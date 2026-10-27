# conecto

Conecto from the command line. Sign your AI agent up, find and call business tools (CRM, email, phone, calendar, invoices, books and more) and keep an eye on the balance.

```bash
npx conecto signup --name "Pip" --accept-terms
npx conecto setup
npx conecto discover -q "send an invoice"
npx conecto run crm_search -i '{"query": "rachel"}'
```

You can use Conecto without the CLI. Agents without a shell (ChatGPT, Claude or Grok on the web, Copilot Studio) add `https://api.conecto.chat/v1/mcp` as a connector, and any agent can read [conecto.chat/SKILL.md](https://conecto.chat/SKILL.md) and call the REST API. The CLI calls that same public API, so whatever it does, they do too.

## Commands

| Command | What it does |
| --- | --- |
| `signup` | Signs your agent up with $1.00 of free credit and keeps the key on this computer |
| `setup` | Saves Conecto's SKILL.md for your agent and adds Conecto as one MCP server (Claude Code, Codex) |
| `discover -q "<job>"` | Finds tools for a job, best match first |
| `areas`, `tools [--area crm]` | Every area, and every tool with its price |
| `inspect <tool>` | A tool's inputs, price and an example call |
| `run <tool> -i '<json>'` | Calls a tool and prints its reply as JSON (`-w` waits for tools that run in the background) |
| `runs list`, `runs get -r <id>` | Recent calls, and one call |
| `balance` | The balance, the budgets and this month's free reads |
| `topup <dollars>` | A checkout link to add credit |
| `keys list`, `add`, `activate`, `show`, `remove` | The keys on this computer |
| `skill` | Prints SKILL.md |

Every command takes `--json` for output an agent can parse, and `--help`.

## Signing up

`signup` accepts Conecto's [terms](https://conecto.chat/terms) for the business your agent works for, so it asks first, or takes `--accept-terms`. It also takes `--business`, `--owner-email`, `--country`, `--website`, `--referral <partner code>`, and `--join <code>` to join your company's account with a code from its IT.

## The key

The key is kept in `~/.config/conecto/keys.json` (or `$XDG_CONFIG_HOME/conecto`), readable only by you, and the CLI sends it itself. Signup prints only its first and last characters, and `setup` hands it straight to Claude Code's MCP settings. `keys show --reveal` prints it when you need to paste it somewhere.

Environment: `CONECTO_API_KEY` uses that key, `CONECTO_API` another API address, `CONECTO_CONFIG_DIR` another folder for the keys, and `NO_COLOR` turns colour off.

## Requirements

Node.js 20 or newer. No dependencies.

## License

MIT
