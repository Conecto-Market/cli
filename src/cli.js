// Conecto from the command line, for agents and people with a shell (Claude Code, Codex, Cursor, a terminal). It
// works the way Monid's CLI does (discover, inspect, run, runs, keys, balance, setup), plus signup and topup.
//
// Every command is a call to Conecto's public API (https://conecto.chat/docs) or its MCP server, the same ones SKILL.md
// describes, so nothing here is reserved to the CLI: an agent without a shell (ChatGPT, Claude or Grok on the web)
// does all of it through the connector or the REST API. The CLI keeps the key in its own file (mode 0600) and sends it
// itself, so an agent never has to read a key back into a shell command.
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
export const VERSION = PKG.version
export const DEFAULT_API = 'https://api.conecto.chat'
const TERMS = 'https://conecto.chat/terms'
const TERMS_MD = 'https://conecto.chat/terms.md'
const STILL_RUNNING = new Set(['reserved', 'running'])

// --- output ---------------------------------------------------------------------------------------------------------

class Fail extends Error {}             // a refusal for the person or agent: its message, and exit code 1

const env = process.env
const colors = (stream) => Boolean(stream.isTTY) && !env.NO_COLOR && env.TERM !== 'dumb'
const paint = (code) => (text) => (colors(process.stdout) ? `\x1b[${code}m${text}\x1b[0m` : String(text))
const bold = paint('1')
const dim = paint('2')
// The hints below say `npx conecto`; each is printed as the command that started this copy: `npx @conecto-chat/cli`
// through npx, or `conecto` once installed (npm install -g @conecto-chat/cli).
export const CMD = /[\\/]_npx[\\/]/.test(process.argv[1] || '') ? `npx ${PKG.name}` : 'conecto'
const hint = (text) => String(text).replaceAll('npx conecto', CMD)
const out = (text = '') => process.stdout.write(`${hint(text)}\n`)
const err = (text = '') => process.stderr.write(`${hint(text)}\n`)
const json = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

function table(rows, head) {
  const all = head ? [head, ...rows] : rows
  if (!all.length) return
  const widths = all[0].map((_, i) => Math.max(...all.map((row) => String(row[i] ?? '').length)))
  const line = (row) => row.map((cell, i) => (i === row.length - 1 ? String(cell ?? '') : String(cell ?? '').padEnd(widths[i]))).join('  ').trimEnd()
  if (head) out(bold(line(head)))
  for (const row of rows) out(line(row))
}

export const mask = (key) => (key ? `${key.slice(0, 11)}…${key.slice(-4)}` : '')

// What a tool costs, in a few words, from its price in the catalog.
export function price(p) {
  if (!p) return ''
  if (p.model === 'free') return 'free'
  if (p.model === 'per_call') return p.usd
  if (p.model === 'per_item') return `${p.usd_per_item} per ${p.per || 'item'}`
  if (p.model === 'quoted') return `quoted, up to ${p.usd_max}`
  if (p.model === 'metered') return `${p.typical || p.basis}, up to ${p.usd_max}`
  return p.usd || ''
}

// --- the key file ---------------------------------------------------------------------------------------------------

export const configDir = () => env.CONECTO_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'conecto')
const storePath = () => join(configDir(), 'keys.json')

async function loadStore() {
  try {
    const store = JSON.parse(await readFile(storePath(), 'utf8'))
    return { active: store.active ?? null, keys: store.keys ?? {} }
  } catch (e) {
    if (e.code === 'ENOENT') return { active: null, keys: {} }
    throw new Fail(`Couldn't read ${storePath()}: ${e.message}`)
  }
}

async function saveStore(store) {
  const dir = configDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `.keys.${process.pid}.json`)
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, storePath())
  await chmod(storePath(), 0o600).catch(() => {})
}

const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'key'
function freeLabel(store, wanted) {
  let label = wanted
  for (let n = 2; store.keys[label]; n++) label = `${wanted}-${n}`
  return label
}

// The key a command runs with: CONECTO_API_KEY, else --as <label>, else the active one.
async function current(o) {
  if (env.CONECTO_API_KEY) return { key: env.CONECTO_API_KEY, label: 'CONECTO_API_KEY' }
  const store = await loadStore()
  const label = o.as || store.active
  const saved = label ? store.keys[label] : null
  if (!saved) {
    throw new Fail(o.as
      ? `No key called "${o.as}" on this computer. \`npx conecto keys list\` shows them.`
      : 'No Conecto key on this computer yet. Sign up with `npx conecto signup`, or add a key with `npx conecto keys add`.')
  }
  return { ...saved, label }
}

// --- the API --------------------------------------------------------------------------------------------------------

const base = (o, saved) => String(o.api || env.CONECTO_API || saved?.api || DEFAULT_API).replace(/\/+$/, '')

async function api(root, path, { method = 'GET', key, body, headers = {}, timeout = 120_000, text = false } = {}) {
  let res
  try {
    res = await fetch(root + path, {
      method,
      headers: {
        Accept: text ? 'text/markdown' : 'application/json',
        'User-Agent': `conecto-cli/${VERSION} (node ${process.versions.node})`,
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'no answer in time' : e.cause?.code || e.message
    throw new Fail(`Couldn't reach ${root} (${why}).`)
  }
  const raw = await res.text()
  if (text) return { status: res.status, ok: res.ok, data: raw }
  let data
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {                                  // a proxy's or a crash's page: say so in one line, never print it
    data = { error: `http_${res.status}`, message: `${root} answered ${res.status} without JSON. Try again in a minute.` }
  }
  return { status: res.status, ok: res.ok, data }
}

// A refused call, as the API words it, with what to do next.
function refusal({ status, data }) {
  const lines = [`${data?.error || `http_${status}`}: ${data?.message || 'The request was refused.'}${data?.field ? ` (${data.field})` : ''}`]
  if (status === 401) lines.push('The key was refused. `npx conecto keys list` shows the keys on this computer.')
  if (status === 402) lines.push('Top up with `npx conecto topup 20`, or ask the owner to.')
  return lines.join('\n')
}

// --- small helpers --------------------------------------------------------------------------------------------------

const GLOBAL = { api: { type: 'string' }, as: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }
function parse(argv, options = {}) {
  try {
    return parseArgs({ args: argv, options: { ...GLOBAL, ...options }, allowPositionals: true, strict: true })
  } catch (e) {
    throw new Fail(`${e.message.replace(/\.$/, '')}. Add --help to see the options.`)
  }
}

const interactive = () => Boolean(process.stdin.isTTY && process.stderr.isTTY)
async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// A hidden prompt: what is typed or pasted stays off the screen. Enter ends it, Ctrl-C stops.
function askHidden(question) {
  const stdin = process.stdin
  process.stderr.write(question)
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (error) => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish()
        if (ch === '\u0003') return finish(new Fail('Stopped. Nothing was sent.'))
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else if (ch >= ' ') value += ch
      }
    }
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
    stdin.resume()
  })
}

// The keys, tokens and passwords `run -s <name>` sends: typed at a hidden prompt, or piped in whole (a key
// file: < key.json). They go from this computer straight to the API, never through a chat or the shell's history.
async function readSecrets(names) {
  if (!process.stdin.isTTY) {
    if (names.length > 1) throw new Fail('Several -s at once read from stdin: send one at a time, or type them at the prompt.')
    const value = (await readStdin()).trim()
    if (!value) throw new Fail(`No ${names[0]} on stdin. Nothing was sent.`)
    return { [names[0]]: value }
  }
  const values = {}
  for (const name of names) {
    const value = (await askHidden(`${name} (hidden): `)).trim()
    if (!value) throw new Fail(`No ${name} typed. Nothing was sent.`)
    values[name] = value
  }
  return values
}

// The agent running this, when it says so, for the key's name on the account page.
function runtime() {
  if (env.CLAUDECODE) return 'Claude Code'
  if (env.CURSOR_TRACE_ID) return 'Cursor'
  return 'conecto CLI'
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 60_000 }, (e, stdout, stderr) => resolve({
      code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
      missing: e?.code === 'ENOENT',
      text: `${stdout || ''}${stderr || ''}`.trim(),
    }))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(root, key, callId) {
  const started = Date.now()
  for (let every = 1000; ; every = Math.min(every * 1.5, 5000)) {
    const r = await api(root, `/v1/calls/${callId}`, { key })
    if (!r.ok) throw new Fail(refusal(r))
    if (!STILL_RUNNING.has(r.data.status)) return r.data
    if (Date.now() - started > 15 * 60_000) throw new Fail(`Still running after 15 minutes. Look again with \`npx conecto runs get -r ${callId} -w\`.`)
    await sleep(every)
  }
}

async function emit(data, file) {
  if (!file) return json(data)
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`)
  err(`Saved to ${file}`)
}

// --- signup ---------------------------------------------------------------------------------------------------------

async function signup(argv) {
  const { values: o } = parse(argv, {
    name: { type: 'string', short: 'n' }, business: { type: 'string', short: 'b' }, 'owner-email': { type: 'string' },
    country: { type: 'string' }, website: { type: 'string' }, referral: { type: 'string', short: 'r' }, ref: { type: 'string' },
    join: { type: 'string' }, 'accept-terms': { type: 'boolean' }, label: { type: 'string', short: 'l' },
    runtime: { type: 'string' }, 'show-key': { type: 'boolean' }, mcp: { type: 'string' },
  })
  if (o.help) return help('signup')
  let name = o.name?.trim()
  if (!name && interactive()) name = await ask('What does the business call you (your agent\'s name)? ')
  if (!name) throw new Fail('Give your agent a name: npx conecto signup --name "Pip" --accept-terms')
  const root = base(o)
  const body = { bot_name: name, runtime: (o.runtime || runtime()).slice(0, 40) }
  if (o.join) {
    body.join = o.join                       // into the company's account: it accepted the terms already
  } else {
    if (!o['accept-terms']) {
      if (!interactive()) throw new Fail(`Signing up accepts Conecto's terms for the business you act for. Read them at ${TERMS_MD}, then add --accept-terms.`)
      err(`Signing up accepts Conecto's terms (${TERMS}) and their data processing terms for ${o.business || 'the business you act for'}.`)
      if (!/^y(es)?$/i.test(await ask('Accept them? [y/N] '))) {
        err('Nothing was created.')
        return 1
      }
    }
    body.accept_terms = true
    if (o.business) body.business_name = o.business
    if (o['owner-email']) body.owner_email = o['owner-email']
    if (o.country) body.country = o.country
    if (o.website) body.website = o.website
    if (o.referral || o.ref) body.referral = o.referral || o.ref
  }
  const r = await api(root, '/v1/signup', { method: 'POST', body })
  if (!r.ok) {
    if (r.data?.error === 'signups_closed') {
      err(r.data.message)
      err('')
      err('With a join code: npx conecto signup --name "<your name>" --join conecto_join_...')
      return 1
    }
    throw new Fail(refusal(r))
  }
  const d = r.data
  const store = await loadStore()
  const label = o.label || freeLabel(store, Object.keys(store.keys).length ? slug(d.business_name) : 'main')
  store.keys[label] = {
    key: d.key, account_id: d.account_id, business: d.business_name, bot: name,
    ...(root === DEFAULT_API ? {} : { api: root }), added_at: new Date().toISOString(),
  }
  store.active = label
  await saveStore(store)
  if (o.json) {
    json({ ...d, key: o['show-key'] ? d.key : mask(d.key), saved_as: label, saved_in: storePath() })
  } else {
    out(`${bold('Signed up')} ${d.business_name}${d.joined ? ', with the join code' : ''}`)
    table([
      ['  Account', String(d.account_id)],
      ['  Key', `${o['show-key'] ? d.key : mask(d.key)}, kept on this computer as "${label}"`],
      ['  Balance', `${d.balance_usd}${d.free_credit_usd && d.free_credit_usd !== '$0.00' ? ' of free credit' : ''}`],
      ...(d.free_credit_note ? [['', d.free_credit_note]] : []),
      ['  Limits', `${d.daily_budget_usd} a day for this key${d.monthly_ceiling_usd ? `, ${d.monthly_ceiling_usd} a month for the account` : ''}`],
      ...(d.owner_note ? [['  Owner', d.owner_note]] : []),
      ...(d.terms ? [['  Terms', `version ${d.terms.version}, accepted for ${d.terms.accepted_for}`]] : []),
    ])
    out('')
    out(bold('Next'))
    table([
      ['  npx conecto setup', 'connect your agent to every tool over MCP, once'],
      ['  npx conecto discover -q "send an invoice"', 'find a tool for a job'],
      ['  npx conecto topup 20', 'your first top-up is doubled, up to $20 extra'],
    ])
  }
  if (o.mcp) return connect(o.mcp, { key: d.key, root })
  return 0
}

// --- setup: the skill and the MCP server, the way `monid setup` does it ------------------------------------------------

function detectClient() {
  if (env.CLAUDECODE) return 'claude-code'
  return ''
}

async function connect(client, { key, root, scope = 'user', force = false }) {
  const url = `${root}/v1/mcp`
  if (client === 'claude-code' || client === 'claude') {
    const args = ['mcp', 'add', '--transport', 'http', '--scope', scope, 'conecto', url, '--header', `Authorization: Bearer ${key}`]
    let r = await run('claude', args)
    if (r.missing) throw new Fail('Claude Code\'s `claude` command isn\'t on this computer\'s PATH.')
    if (r.code !== 0 && /already exists/i.test(r.text)) {
      if (!force) throw new Fail('Claude Code already has a server called "conecto". Add --force to replace it.')
      await run('claude', ['mcp', 'remove', 'conecto', '--scope', scope])
      r = await run('claude', args)
    }
    if (r.code !== 0) throw new Fail(`claude mcp add didn't work: ${r.text}`)
    err('Claude Code has Conecto as an MCP server now. Restart Claude Code so its tools load.')
    return 0
  }
  if (client === 'codex') {
    const r = await run('codex', ['mcp', 'add', 'conecto', '--url', url, '--bearer-token-env-var', 'CONECTO_API_KEY'])
    if (r.missing) throw new Fail('Codex\'s `codex` command isn\'t on this computer\'s PATH.')
    if (r.code !== 0) throw new Fail(`codex mcp add didn't work: ${r.text}`)
    err('Codex has Conecto as an MCP server now. It sends the key from the CONECTO_API_KEY environment variable, so set it where Codex starts (`npx conecto keys show --reveal` prints the key).')
    return 0
  }
  err('Add Conecto in your agent\'s MCP settings as a Streamable HTTP server:')
  err(`  URL     ${url}`)
  err('  Header  Authorization: Bearer <your key>   (`npx conecto keys show --reveal` prints it)')
  err('People in ChatGPT, Claude or Grok on the web add the same address as a connector, and sign in with OAuth.')
  return 0
}

async function installSkill(root, dir) {
  const r = await api(root, '/v1/skill.md', { text: true })
  if (!r.ok) throw new Fail(`Couldn't fetch SKILL.md (${r.status}).`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), r.data)
  return join(dir, 'SKILL.md')
}

async function setup(argv) {
  const { values: o } = parse(argv, {
    client: { type: 'string', short: 'c' }, scope: { type: 'string' }, force: { type: 'boolean' },
    'skill-dir': { type: 'string' }, 'no-skill': { type: 'boolean' }, 'no-mcp': { type: 'boolean' },
  })
  if (o.help) return help('setup')
  const client = o.client || detectClient()
  let saved = null
  try {
    saved = await current(o)
  } catch (e) {
    if (!(e instanceof Fail)) throw e
  }
  const root = base(o, saved)
  if (!o['no-skill']) {
    const dir = o['skill-dir'] || (client === 'claude-code' ? join(homedir(), '.claude', 'skills', 'conecto') : '')
    if (dir) err(`Saved Conecto's skill to ${await installSkill(root, dir)}`)
    else err(`Save Conecto's skill where your agent keeps skills: ${root === DEFAULT_API ? 'https://conecto.chat' : root}/SKILL.md (or \`npx conecto skill --install --dir <folder>\`).`)
  }
  if (!o['no-mcp']) {
    if (!saved) {
      err('No key yet, so no MCP server was added. Sign up with `npx conecto signup`, then run setup again.')
      return 1
    }
    return connect(client, { key: saved.key, root, scope: o.scope || 'user', force: o.force })
  }
  return 0
}

async function skill(argv) {
  const { values: o } = parse(argv, { install: { type: 'boolean' }, dir: { type: 'string' }, ref: { type: 'string' } })
  if (o.help) return help('skill')
  const root = base(o)
  if (o.install || o.dir) {
    err(`Saved Conecto's skill to ${await installSkill(root, o.dir || join(homedir(), '.claude', 'skills', 'conecto'))}`)
    return 0
  }
  const r = await api(root, `/v1/skill.md${o.ref ? `?ref=${encodeURIComponent(o.ref)}` : ''}`, { text: true })
  if (!r.ok) throw new Fail(`Couldn't fetch SKILL.md (${r.status}).`)
  process.stdout.write(r.data)
  return 0
}

// --- finding tools --------------------------------------------------------------------------------------------------

const FILLER = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'my', 'our', 'with', 'from', 'by', 'is', 'it', 'me', 'i'])
export function rank(tools, query) {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !FILLER.has(w)).map((w) => (w.length > 4 ? w.replace(/(es|s)$/, '') : w))
  if (!words.length) return tools
  return tools
    .map((t) => {
      const name = t.name.toLowerCase()
      const title = (t.title || '').toLowerCase()
      const text = (t.description || '').toLowerCase()
      let score = 0
      for (const w of words) score += (name.includes(w) ? 4 : 0) + (title.includes(w) ? 3 : 0) + (t.area?.includes(w) ? 2 : 0) + (text.includes(w) ? 1 : 0)
      return { t, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.t)
}

async function discover(argv, listing = false) {
  const { values: o, positionals } = parse(argv, { query: { type: 'string', short: 'q' }, area: { type: 'string', short: 'a' }, limit: { type: 'string', short: 'n' } })
  if (o.help) return help(listing ? 'tools' : 'discover')
  const query = (o.query ?? positionals.join(' ')).trim()
  if (!listing && !query && !o.area) throw new Fail('Say what the tool is for: npx conecto discover -q "send an invoice"')
  const r = await api(base(o), `/v1/tools${o.area ? `?area=${encodeURIComponent(o.area)}` : ''}`)
  if (!r.ok) throw new Fail(refusal(r))
  let tools = query ? rank(r.data.tools, query) : r.data.tools
  const limit = Number(o.limit || (query ? 12 : 0))
  if (limit > 0) tools = tools.slice(0, limit)
  if (o.json) {
    json({ tools })
    return 0
  }
  if (!tools.length) {
    err('No tool matched. `npx conecto areas` lists the areas, `npx conecto tools --area <area>` the tools in one.')
    return 1
  }
  table(tools.map((t) => [t.name, price(t.price), t.title]), ['Tool', 'Price', 'What it does'])
  err('')
  err(dim('`npx conecto inspect <tool>` shows its inputs and an example.'))
  return 0
}

async function areas(argv) {
  const { values: o } = parse(argv)
  if (o.help) return help('areas')
  const r = await api(base(o), '/v1/areas')
  if (!r.ok) throw new Fail(refusal(r))
  if (o.json) {
    json(r.data)
    return 0
  }
  table(r.data.areas.map((a) => [a.area, String(a.tools), a.title]), ['Area', 'Tools', 'What it is'])
  return 0
}

function kind(schema = {}) {
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ')
  if (schema.type === 'array') return `${kind(schema.items)}[]`
  return Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type || 'any'
}

async function inspect(argv) {
  const { values: o, positionals: [name] } = parse(argv)
  if (o.help) return help('inspect')
  if (!name) throw new Fail('Name the tool: npx conecto inspect crm_search')
  const r = await api(base(o), `/v1/tools/${encodeURIComponent(name)}`)
  if (!r.ok) throw new Fail(refusal(r))
  const t = r.data
  if (o.json) {
    json(t)
    return 0
  }
  out(`${bold(t.name)}  ${t.title}`)
  out(dim([t.area, price(t.price), t.read_only && 'reads only', t.destructive && 'destructive', t.runs_in_background && 'runs in the background'].filter(Boolean).join(' · ')))
  out('')
  out(t.description)
  const props = Object.entries(t.input_schema?.properties || {})
  const required = new Set(t.input_schema?.required || [])
  if (props.length) {
    out('')
    out(bold('Input'))
    table(props.map(([key, s]) => [`  ${key}`, kind(s), [required.has(key) && 'required', s.writeOnly && 'secret'].filter(Boolean).join(', '), (s.description || '').replace(/\s+/g, ' ')]))
  }
  const secrets = props.filter(([, s]) => s.writeOnly).map(([key]) => key)
  if (t.examples?.length) {
    out('')
    out(bold('Example'))
    out(`  npx conecto run ${t.name} -i '${JSON.stringify(t.examples[0])}'`)
  }
  if (secrets.length) {
    out('')
    out(`Type ${secrets.join(' or ')} at a hidden prompt: add ${secrets.map((s) => `-s ${s}`).join(' or ')} to run, and leave it out of -i.`)
  }
  out('')
  out(dim(`Its page, with a real reply and its errors: https://conecto.chat/tools/${t.area}/${t.name}.md`))
  return 0
}

// --- calling tools --------------------------------------------------------------------------------------------------

async function runTool(argv) {
  const { values: o, positionals: [name] } = parse(argv, {
    input: { type: 'string', short: 'i' }, 'input-file': { type: 'string', short: 'f' }, wait: { type: 'boolean', short: 'w' },
    output: { type: 'string', short: 'o' }, 'idempotency-key': { type: 'string' }, approval: { type: 'string' },
    secret: { type: 'string', short: 's', multiple: true },
  })
  if (o.help) return help('run')
  if (!name) throw new Fail('Name the tool: npx conecto run crm_search -i \'{"query": "rachel"}\'')
  const saved = await current(o)
  const root = base(o, saved)
  const secrets = o.secret || []
  let input = o.input
  if (o['input-file']) input = await readFile(o['input-file'], 'utf8')
  else if (input === '-' && secrets.length && !process.stdin.isTTY) throw new Fail('-i - and -s both read stdin: give the arguments with -i \'<json>\' or -f <file>.')
  else if (input === '-') input = await readStdin()
  let args = {}
  if (input !== undefined && input.trim()) {
    try {
      args = JSON.parse(input)
    } catch (e) {
      throw new Fail(`The input isn't JSON (${e.message}).`)
    }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Fail('The input is a JSON object of the tool\'s arguments, like {"query": "rachel"}.')
  for (const secret of secrets) {
    if (Object.hasOwn(args, secret)) throw new Fail(`Leave ${secret} out of -i: -s ${secret} reads it at a hidden prompt, or from stdin.`)
  }
  if (secrets.length) Object.assign(args, await readSecrets(secrets))
  const idempotency = o['idempotency-key'] || randomUUID()
  const r = await api(root, `/v1/tools/${encodeURIComponent(name)}`, {
    method: 'POST', key: saved.key, body: args,
    headers: { 'Idempotency-Key': idempotency, ...(o.approval ? { 'X-Conecto-Approval': o.approval } : {}) },
  })
  let data = r.data
  if (r.status === 202 && data?.call_id && o.wait) data = await waitFor(root, saved.key, data.call_id)
  await emit(data, o.output)
  const failed = !r.ok || data?.status === 'failed'
  const parts = [name, failed ? (data?.error || data?.status || `http ${r.status}`) : (data?.status || 'ok')]
  if (data?.cost_usd) parts.push(`cost ${data.cost_usd}`)
  if (data?.balance_usd) parts.push(`balance ${data.balance_usd}`)
  err(dim(parts.join(' · ')))
  if (r.status === 202 && !o.wait && data?.call_id) err(`It runs in the background. Read it with \`npx conecto runs get -r ${data.call_id} -w\`.`)
  if (data?.error === 'approval_required') err(`It waits for a person's approval. Once approved, run it again with --approval ${data.approval_id || '<approval_id>'}.`)
  if (r.status === 402) err('Top up with `npx conecto topup 20`, or ask the owner to.')
  if (r.status === 401) err('The key was refused. `npx conecto keys list` shows the keys on this computer.')
  if (!failed) err(dim(`Retry safely with --idempotency-key ${idempotency}`))
  return failed ? 1 : 0
}

async function runs(argv) {
  if (/^[0-9a-f-]{36}$/.test(argv[0] || '')) argv = ['get', ...argv]       // runs <call_id> reads that call
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list'
  const rest = sub === argv[0] ? argv.slice(1) : argv
  const { values: o, positionals } = parse(rest, {
    run: { type: 'string', short: 'r' }, wait: { type: 'boolean', short: 'w' }, output: { type: 'string', short: 'o' },
    limit: { type: 'string', short: 'l' }, status: { type: 'string', short: 's' },
  })
  if (o.help) return help('runs')
  const saved = await current(o)
  const root = base(o, saved)
  if (sub === 'get') {
    const id = o.run || positionals[0]
    if (!id) throw new Fail('Give the call\'s id: npx conecto runs get -r <call_id>')
    let data
    if (o.wait) {
      data = await waitFor(root, saved.key, id)
    } else {
      const r = await api(root, `/v1/calls/${encodeURIComponent(id)}`, { key: saved.key })
      if (!r.ok) throw new Fail(refusal(r))
      data = r.data
    }
    await emit(data, o.output)
    return data.status === 'failed' ? 1 : 0
  }
  if (sub !== 'list') throw new Fail(`Unknown: runs ${sub}. Use \`runs list\` or \`runs get -r <call_id>\`.`)
  const query = new URLSearchParams({ limit: String(o.limit || 20), ...(o.status ? { status: o.status } : {}) })
  const r = await api(root, `/v1/calls?${query}`, { key: saved.key })
  if (!r.ok) throw new Fail(refusal(r))
  if (o.json) {
    json(r.data)
    return 0
  }
  if (!r.data.calls.length) {
    err('No calls yet.')
    return 0
  }
  table(r.data.calls.map((c) => [c.at.slice(0, 16).replace('T', ' '), c.tool, c.status, c.cost_usd, c.call_id]), ['When (UTC)', 'Tool', 'Status', 'Cost', 'Call'])
  return 0
}

// --- money ----------------------------------------------------------------------------------------------------------

async function balance(argv) {
  const { values: o } = parse(argv)
  if (o.help) return help('balance')
  const saved = await current(o)
  const r = await api(base(o, saved), '/v1/balance', { key: saved.key })
  if (!r.ok) throw new Fail(refusal(r))
  const d = r.data
  if (o.json) {
    json(d)
    return 0
  }
  const free = d.free_this_month
  table([
    ['Balance', d.balance_usd],
    ...(d.reserved_usd && d.reserved_usd !== '$0.00' ? [['Held for calls running', d.reserved_usd]] : []),
    ['Daily budget', `${d.daily_budget_usd} for this key`],
    ['Monthly ceiling', `${d.monthly_ceiling_usd} for the account`],
    ['Auto-reload', d.auto_reload?.status === 'on' ? `on, ${d.auto_reload.amount_usd}` : (d.auto_reload?.status || 'off')],
    ...(free?.reads ? [['Free reads this month', `${Number(free.reads.used).toLocaleString('en-US')} of ${Number(free.reads.free).toLocaleString('en-US')}`]] : []),
    ...(free?.downloads ? [['Free downloads this month', `${free.downloads.used} of ${free.downloads.free}`]] : []),
  ])
  if (d.top_up) {
    const amount = /"amount_usd": (\d+)/.exec(d.top_up)?.[1] || '20'
    err(`Top up with \`npx conecto topup ${amount}\`.${d.first_topup_offer ? ` ${d.first_topup_offer}` : ''}`)
  }
  return 0
}

function openLink(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}

async function topup(argv) {
  const { values: o, positionals: [amount] } = parse(argv, { po: { type: 'string' }, open: { type: 'boolean' } })
  if (o.help) return help('topup')
  const dollars = Number(String(amount ?? '').replace(/^\$/, ''))
  if (!Number.isFinite(dollars) || dollars < 5) throw new Fail('Give the amount in US dollars, $5 or more: npx conecto topup 20')
  const saved = await current(o)
  const r = await api(base(o, saved), '/v1/topups', { method: 'POST', key: saved.key, body: { amount_usd: dollars, ...(o.po ? { po_number: o.po } : {}) } })
  if (!r.ok) throw new Fail(refusal(r))
  const d = r.data
  if (o.json) {
    json(d)
  } else {
    table([
      ['Credit', d.amount_usd],
      ...(d.first_topup_bonus_usd && d.first_topup_bonus_usd !== '$0.00' ? [['First top-up bonus', d.first_topup_bonus_usd]] : []),
      ['Fee', d.fee_usd],
      ['You pay', d.total_usd],
      ['Lands on the balance', d.credited_usd],
    ])
    out('')
    out(`${bold('Pay here:')} ${d.checkout_url}`)
    if (d.how) err(d.how)
  }
  if (o.open) openLink(d.checkout_url)
  return 0
}

// --- keys -----------------------------------------------------------------------------------------------------------

async function keys(argv) {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list'
  const rest = sub === argv[0] ? argv.slice(1) : argv
  const { values: o, positionals } = parse(rest, { key: { type: 'string', short: 'k' }, label: { type: 'string', short: 'l' }, reveal: { type: 'boolean' }, force: { type: 'boolean', short: 'f' } })
  if (o.help) return help('keys')
  const store = await loadStore()
  const label = o.label || positionals[0]
  if (sub === 'list') {
    const rows = Object.entries(store.keys)
    if (o.json) {
      json({ active: store.active, keys: rows.map(([l, k]) => ({ label: l, key: mask(k.key), account_id: k.account_id ?? null, business: k.business ?? null, api: k.api || DEFAULT_API })) })
      return 0
    }
    if (!rows.length) {
      err('No keys on this computer yet. Sign up with `npx conecto signup`, or add one with `npx conecto keys add`.')
      return 0
    }
    table(rows.map(([l, k]) => [l === store.active ? '*' : ' ', l, mask(k.key), k.business || '', k.api || '']), [' ', 'Label', 'Key', 'Business', ''])
    if (env.CONECTO_API_KEY) err('CONECTO_API_KEY is set, so commands use that key instead.')
    return 0
  }
  if (sub === 'add') {
    let key = o.key
    if (key === '-') key = (await readStdin()).trim()
    if (!key && interactive()) key = await ask('Paste the key (conecto_sk_...): ')
    if (!key) throw new Fail('Give the key: npx conecto keys add -k conecto_sk_... (or -k - to read it from stdin)')
    if (!key.startsWith('conecto_sk_')) throw new Fail('That isn\'t a Conecto key: they start with conecto_sk_.')
    const root = base(o)
    const r = await api(root, '/v1/balance', { key })
    if (!r.ok) throw new Fail(refusal(r))
    const name = freeLabel(store, o.label || (Object.keys(store.keys).length ? 'key' : 'main'))
    if (o.label && store.keys[o.label] && !o.force) throw new Fail(`There's already a key called "${o.label}". Add --force to replace it.`)
    const final = o.label && o.force ? o.label : name
    store.keys[final] = { key, ...(root === DEFAULT_API ? {} : { api: root }), added_at: new Date().toISOString() }
    store.active = final
    await saveStore(store)
    err(`Added ${mask(key)} as "${final}" and made it the active key. Balance ${r.data.balance_usd}.`)
    return 0
  }
  if (!label) throw new Fail(`Name the key: npx conecto keys ${sub} -l <label>`)
  if (!store.keys[label]) throw new Fail(`No key called "${label}". \`npx conecto keys list\` shows them.`)
  if (sub === 'activate' || sub === 'use') {
    store.active = label
    await saveStore(store)
    err(`"${label}" is the active key now.`)
    return 0
  }
  if (sub === 'remove') {
    delete store.keys[label]
    if (store.active === label) store.active = Object.keys(store.keys)[0] ?? null
    await saveStore(store)
    err(`Removed "${label}" from this computer. The key itself still works until it's revoked on the account page.`)
    return 0
  }
  if (sub === 'show') {
    const k = store.keys[label]
    if (o.json) json({ label, key: o.reveal ? k.key : mask(k.key), account_id: k.account_id ?? null, business: k.business ?? null })
    else out(o.reveal ? k.key : mask(k.key))
    return 0
  }
  throw new Fail(`Unknown: keys ${sub}. Use list, add, activate, show or remove.`)
}

// --- help -----------------------------------------------------------------------------------------------------------

const HELP = {
  '': `conecto ${VERSION}: business tools for your AI agent

Usage: npx conecto <command> [options]
Run it with npx ${PKG.name} <command>, or install it once (npm install -g ${PKG.name}) and type conecto.

Start
  signup      Sign your agent up, with $1.00 of free credit
  setup       Connect your agent to every tool over MCP and save Conecto's skill
Tools
  discover    Find tools for a job: discover -q "send an invoice"
  areas       Every area, with its number of tools
  tools       Every tool with its price (--area crm for one area)
  inspect     A tool's inputs, price and an example
  run         Call a tool: run crm_search -i '{"query": "rachel"}'
  runs        Recent calls (runs list), and one call (runs get -r <id> -w)
Money
  balance     The balance, budgets and this month's free reads
  topup       A checkout link to add credit: topup 20
Keys
  keys        list, add, activate, show and remove the keys on this computer
Other
  skill       Print SKILL.md (--install saves it for Claude Code)

Every option: --json, --api <url>, --as <key label>, --help
Environment: CONECTO_API_KEY, CONECTO_API, CONECTO_CONFIG_DIR, NO_COLOR

Nothing here needs the CLI: agents without a shell (ChatGPT, Claude or Grok on the web) do the
same through the connector (https://api.conecto.chat/v1/mcp) or SKILL.md (https://conecto.chat/SKILL.md).`,
  signup: `Usage: npx conecto signup --name <agent name> --accept-terms [options]

Signs your agent up and keeps its key on this computer (in ${'$'}XDG_CONFIG_HOME/conecto or ~/.config/conecto).

  -n, --name <name>         What the business calls you (required)
      --accept-terms        Accept the terms (https://conecto.chat/terms.md) for the business
  -b, --business <name>     The business you work for
      --owner-email <email> Makes that person the owner at once
      --country <XX>        Two letters, like US or DE
      --website <url>       The business's website
  -r, --referral <code>     A Conecto partner's code (only at signup)
      --join <code>         Join your company's account with the join code IT gave you
  -l, --label <label>       The key's name on this computer
      --mcp <client>        Then add the MCP server: claude-code or codex
      --show-key            Print the whole key once`,
  setup: `Usage: npx conecto setup [--client claude-code|codex] [options]

Saves Conecto's SKILL.md where your agent keeps skills and adds Conecto as one MCP server with your key.

  -c, --client <client>     claude-code or codex (Claude Code is found on its own)
      --scope <scope>       Claude Code's scope: user (default), project or local
      --force               Replace a server called "conecto"
      --skill-dir <folder>  Where to save SKILL.md
      --no-skill, --no-mcp  Skip that part`,
  discover: `Usage: npx conecto discover -q "<what you need>" [--area <area>] [-n <how many>]

Finds tools for a job, best match first.`,
  tools: `Usage: npx conecto tools [--area <area>]

Every tool with its price, or one area's.`,
  areas: 'Usage: npx conecto areas\n\nEvery area, with its number of tools.',
  inspect: `Usage: npx conecto inspect <tool>

A tool's description, price, inputs and an example call.`,
  run: `Usage: npx conecto run <tool> -i '<json>' [options]

Calls a tool and prints its reply as JSON.

  -i, --input <json>        The arguments, as a JSON object (- reads them from stdin)
  -f, --input-file <path>   The arguments from a file
  -s, --secret <name>       Read that argument (a key, token or password) at a hidden prompt, or from
                            stdin (< key.json), so it stays out of chats and command lines
  -w, --wait                Wait for a tool that runs in the background
  -o, --output <path>       Save the reply to a file
      --idempotency-key <k> Retry safely: the same key never charges twice
      --approval <id>       Run a call a person approved`,
  runs: `Usage: npx conecto runs list [--limit 20] [--status failed]
       npx conecto runs get -r <call_id> [-w] [-o <path>]`,
  balance: 'Usage: npx conecto balance\n\nThe balance, the budgets and this month\'s free reads and downloads.',
  topup: `Usage: npx conecto topup <dollars> [--po <number>] [--open]

A Stripe checkout link for credit ($5 or more). Open it, or hand it to the owner.`,
  keys: `Usage: npx conecto keys list
       npx conecto keys add -k <key> [-l <label>]     (-k - reads it from stdin)
       npx conecto keys activate -l <label>
       npx conecto keys show -l <label> [--reveal]
       npx conecto keys remove -l <label>`,
  skill: `Usage: npx conecto skill [--install] [--dir <folder>] [--ref <partner code>]

Prints Conecto's SKILL.md, or saves it (~/.claude/skills/conecto by default).`,
}

function help(command = '') {
  const text = HELP[command]
  if (text === undefined) throw new Fail(`No command called "${command}". Run npx conecto --help.`)
  out(text)
  return 0
}

// --- the commands ---------------------------------------------------------------------------------------------------

export async function main(argv) {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case undefined: case 'help': case '--help': case '-h': return help(rest[0] && HELP[rest[0]] !== undefined ? rest[0] : '')
      case 'version': case '--version': case '-v': out(VERSION); return 0
      case 'signup': return await signup(rest)
      case 'setup': return await setup(rest)
      case 'discover': case 'search': return await discover(rest)
      case 'tools': return await discover(rest, true)
      case 'areas': return await areas(rest)
      case 'inspect': case 'describe': return await inspect(rest)
      case 'run': case 'call': return await runTool(rest)
      case 'runs': case 'calls': return await runs(rest)
      case 'balance': return await balance(rest)
      case 'topup': case 'top-up': return await topup(rest)
      case 'keys': return await keys(rest)
      case 'skill': return await skill(rest)
      default: throw new Fail(`No command called "${command}". Run npx conecto --help.`)
    }
  } catch (e) {
    if (e instanceof Fail) {
      err(e.message)
      return 1
    }
    throw e
  }
}
