// The CLI as an agent runs it: the real bin, a stand-in for Conecto's API, a fresh home and key folder per test.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../bin/conecto.js', import.meta.url))
const KEY = `conecto_sk_${'a'.repeat(32)}WXYZ`
let server
let api
let handler = () => [404, { error: 'not_found', message: 'Nothing here.' }]
let seen = []

before(async () => {
  server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const request = { method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined }
    seen.push(request)
    const [status, reply, type = 'application/json'] = await handler(request)
    res.writeHead(status, { 'Content-Type': type })
    res.end(typeof reply === 'string' ? reply : JSON.stringify(reply))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  api = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

async function home() {
  return mkdtemp(join(tmpdir(), 'conecto-cli-'))
}

async function withKey(dir, key = KEY) {
  await mkdir(join(dir, 'config'), { recursive: true })
  await writeFile(join(dir, 'config', 'keys.json'), JSON.stringify({ active: 'main', keys: { main: { key } } }))
}

function cli(args, { handle, dir, env = {}, stdin = '' } = {}) {
  if (handle) handler = handle
  seen = []
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, HOME: dir, CONECTO_API: api, CONECTO_CONFIG_DIR: join(dir, 'config'), NO_COLOR: '1', ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.stdin.end(stdin)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const signupReply = (extra = {}) => ({
  account_id: 7, business_name: 'Halverson Cycle & Repair', key: KEY, key_note: 'Shown once.', balance_usd: '$1.00',
  free_credit_usd: '$1.00', free_credit_note: null, daily_budget_usd: '$20.00', monthly_ceiling_usd: '$100.00',
  owner_note: 'No owner email.', terms: { version: '2026-10-26', accepted_for: 'Halverson Cycle & Repair' }, ...extra,
})

test('signup without --accept-terms says where the terms are and creates nothing', async () => {
  const r = await cli(['signup', '--name', 'Pip'], { dir: await home() })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /terms\.md/)
  assert.equal(seen.length, 0)
})

test('signup sends the agent, the terms and the partner code, and keeps the key out of sight', async () => {
  const dir = await home()
  const r = await cli(['signup', '-n', 'Pip', '--accept-terms', '-b', 'Halverson Cycle & Repair', '--referral', 'lindqvist'], {
    dir, handle: (q) => (q.path === '/v1/signup' ? [201, signupReply()] : [404, {}]),
  })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(seen[0].body, { bot_name: 'Pip', runtime: 'conecto CLI', accept_terms: true, business_name: 'Halverson Cycle & Repair', referral: 'lindqvist' })
  assert.ok(!r.stdout.includes(KEY), 'the whole key is never printed')
  assert.match(r.stdout, /conecto_sk_…WXYZ/)
  const file = join(dir, 'config', 'keys.json')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const store = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(store.active, 'main')
  assert.equal(store.keys.main.key, KEY)
})

test('signup while signups are closed shows the server\'s words and the join code way in', async () => {
  const r = await cli(['signup', '-n', 'Pip', '--accept-terms'], {
    dir: await home(), handle: () => [403, { error: 'signups_closed', message: 'Conecto opens to everyone soon.' }],
  })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Conecto opens to everyone soon\./)
  assert.match(r.stderr, /--join conecto_join_/)
})

test('signup with a join code needs no terms: the company accepted them', async () => {
  const r = await cli(['signup', '-n', 'Pip', '--join', 'conecto_join_abc'], {
    dir: await home(), handle: () => [201, signupReply({ joined: true })],
  })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(seen[0].body, { bot_name: 'Pip', runtime: 'conecto CLI', join: 'conecto_join_abc' })
})

test('run sends the arguments with the key and an idempotency key, and prints the reply', async () => {
  const dir = await home()
  await withKey(dir)
  const reply = { tool: 'crm_search', status: 'succeeded', cost_usd: '$0.00', balance_usd: '$0.99', result: { contacts: [] } }
  const r = await cli(['run', 'crm_search', '-i', '{"query": "rachel"}'], { dir, handle: () => [200, reply] })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].path, '/v1/tools/crm_search')
  assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`)
  assert.match(seen[0].headers['idempotency-key'], /^[0-9a-f-]{36}$/)
  assert.deepEqual(seen[0].body, { query: 'rachel' })
  assert.deepEqual(JSON.parse(r.stdout), reply)
})

test('run --wait follows a call that runs in the background to its end', async () => {
  const dir = await home()
  await withKey(dir)
  const id = '0f8c1e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b'
  let polls = 0
  const r = await cli(['run', 'web_research', '-i', '{"question": "x"}', '-w'], {
    dir,
    handle: (q) => {
      if (q.method === 'POST') return [202, { call_id: id, status: 'running' }]
      polls += 1
      return [200, { call_id: id, status: polls < 2 ? 'running' : 'succeeded', cost_usd: '$0.05', output: { answer: 'yes' } }]
    },
  })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(seen.at(-1).path, `/v1/calls/${id}`)
  assert.equal(JSON.parse(r.stdout).status, 'succeeded')
})

test('run -s reads a key from stdin and sends it straight to the API with the other arguments', async () => {
  const dir = await home()
  await withKey(dir)
  const reply = { tool: 'connect_add', status: 'succeeded', cost_usd: '$0.00', result: { connection: { name: 'zendesk' } } }
  const r = await cli(['run', 'connect_add', '-i', '{"name": "zendesk", "allow": ["GET /tickets*"]}', '-s', 'secret'], {
    dir, stdin: 'zd-token-1234\n', handle: () => [200, reply],
  })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].path, '/v1/tools/connect_add')
  assert.deepEqual(seen[0].body, { name: 'zendesk', allow: ['GET /tickets*'], secret: 'zd-token-1234' })
  assert.ok(!`${r.stdout}${r.stderr}`.includes('zd-token-1234'), 'the key is never printed')
})

test('run -s keeps a key file whole, and refuses a key also given in -i or none at all', async () => {
  const dir = await home()
  await withKey(dir)
  const file = '{\n  "type": "service_account",\n  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE\\n"\n}\n'
  const ok = await cli(['run', 'google_connect', '-i', '{"mailboxes": ["support@halverson.example"]}', '-s', 'secret'], {
    dir, stdin: file, handle: () => [200, { status: 'succeeded', result: {} }],
  })
  assert.equal(ok.code, 0, ok.stderr)
  assert.equal(seen[0].body.secret, file.trim())
  const twice = await cli(['run', 'hubspot_connect', '-i', '{"token": "pat-1234567890"}', '-s', 'token'], { dir, stdin: 'pat-1234567890' })
  assert.equal(twice.code, 1)
  assert.match(twice.stderr, /Leave token out of -i/)
  assert.ok(!twice.stderr.includes('pat-1234567890'))
  const empty = await cli(['run', 'hubspot_connect', '-s', 'token'], { dir, stdin: '' })
  assert.equal(empty.code, 1)
  assert.match(empty.stderr, /No token/)
  assert.equal(seen.length, 0)                                  // neither reached the API
})

test('a call refused for money says how to top up', async () => {
  const dir = await home()
  await withKey(dir)
  const r = await cli(['run', 'email_send', '-i', '{}'], { dir, handle: () => [402, { error: 'insufficient_balance', message: 'The balance is empty.' }] })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /`conecto topup 20`/)
})

test('setup saves the skill and gives Claude Code the server with the key, through `claude mcp add`', async () => {
  const dir = await home()
  await withKey(dir)
  const bin = join(dir, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, 'claude-args')}"\n`)
  await chmod(join(bin, 'claude'), 0o755)
  const r = await cli(['setup', '--client', 'claude-code'], {
    dir, env: { PATH: `${bin}:${process.env.PATH}` },
    handle: (q) => (q.path === '/v1/skill.md' ? [200, '---\nname: conecto\n---\n', 'text/markdown'] : [404, {}]),
  })
  assert.equal(r.code, 0, r.stderr)
  const args = (await readFile(join(dir, 'claude-args'), 'utf8')).trim().split('\n')
  assert.deepEqual(args, ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'conecto', `${api}/v1/mcp`, '--header', `Authorization: Bearer ${KEY}`])
  assert.match(await readFile(join(dir, '.claude', 'skills', 'conecto', 'SKILL.md'), 'utf8'), /name: conecto/)
})

test('keys add checks a key before keeping it, and reads it from stdin', async () => {
  const dir = await home()
  const refused = await cli(['keys', 'add', '-k', KEY], { dir, handle: () => [401, { error: 'invalid_key', message: 'Unknown key.' }] })
  assert.equal(refused.code, 1)
  const added = await cli(['keys', 'add', '-k', '-'], { dir, stdin: `${KEY}\n`, handle: () => [200, { balance_usd: '$3.00' }] })
  assert.equal(added.code, 0, added.stderr)
  assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`)
  assert.equal(JSON.parse(await readFile(join(dir, 'config', 'keys.json'), 'utf8')).keys.main.key, KEY)
})

test('CONECTO_API_KEY is used in place of the stored key', async () => {
  const dir = await home()
  await withKey(dir)
  const other = `conecto_sk_${'b'.repeat(32)}QRST`
  const r = await cli(['balance', '--json'], { dir, env: { CONECTO_API_KEY: other }, handle: () => [200, { balance_usd: '$5.00' }] })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(seen[0].headers.authorization, `Bearer ${other}`)
})

test('discover puts the tools that match the words first', async () => {
  const tools = [
    { name: 'crm_search', area: 'crm', title: 'Search the CRM', description: 'Find contacts.', price: { model: 'free' } },
    { name: 'invoices_send', area: 'invoices', title: 'Send a quote or invoice', description: 'Emails it.', price: { model: 'per_call', usd: '$0.10' } },
  ]
  const r = await cli(['discover', '-q', 'send an invoice', '--json'], { dir: await home(), handle: () => [200, { tools, count: 2 }] })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).tools.map((t) => t.name), ['invoices_send'])
})
