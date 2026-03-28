# Slack Bot + LLM Starter

Let people talk to your data through Slack.

```
User: "What's new this week?"
Bot:  "3 items this week — Q1 roadmap update, Acme's Series B, and the sales pipeline review..."
```

Clone it, copy the included `.env.example`, set your keys, run it.

---

<details>
<summary>🤖 <strong>Agent / automated setup</strong> (Claude Code, Cursor, Codex, etc.)</summary>

<br/>

If you're setting this up through an AI coding agent rather than clicking through UIs:

1. **Slack App** — use the **App Manifest** JSON editor (`Settings → App Manifests`), not the individual settings pages. Set `socket_mode_enabled: true`, add scopes and events in one shot. Clicking through individual pages is brittle for automation.

2. **Tokens** — generate an app-level token with `connections:write` scope, copy the bot token from OAuth & Permissions. Both go in `.env`.

3. **Scopes** — `app_mentions:read`, `chat:write`, `channels:history`, `reactions:write`. Skip `im:history` and `message.im` for channel-only mode. **Channel-only security is about omission** — you secure it by not adding scopes, not by configuring something extra.

4. **Railway** — `New Project → GitHub Repository → select repo`. Set variables via **Raw Editor** or the GraphQL API (`variableCollectionUpsert`), not one-by-one. The individual variable UI can be flaky for automation.

5. **Verify** — `npm run check` locally before pushing. Railway auto-deploys on push and on variable changes.

6. **Smoke test** — invite bot to a channel, `@YourBot what's new?`. Expect a threaded reply with 👀 reaction while processing.

</details>

## Setup (10 minutes)

### Prerequisites

- Node.js 20+
- A Slack workspace where you can install apps
- An Anthropic API key

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From Scratch**
2. Name it whatever you want, pick your workspace
3. Go to **Socket Mode** → toggle it on → generate an app token (starts with `xapp-`)
4. Go to **OAuth & Permissions** → add these bot scopes:
   - `app_mentions:read` — see when someone @mentions the bot
   - `chat:write` — post responses
   - `channels:history` — read thread history for context
   - `im:history` — read DM history
5. **Install to Workspace** → copy the bot token (starts with `xoxb-`)
6. Go to **Event Subscriptions** → toggle on → subscribe to:
   - `app_mention` — someone @mentions the bot
   - `message.im` — someone DMs the bot

Notes:

- Default support is **DMs + public channels**
- If you want private-channel support, add `groups:history`, reinstall the app, and invite the bot to the private channel
- Any time you change scopes or event subscriptions, **reinstall the app to the workspace**

### 2. Get an Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API key
3. Add some credits ($5 is plenty to start)

### 3. Configure Environment

This repo includes an environment template: `.env.example`

Required:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `ANTHROPIC_API_KEY`

Optional:

- `ANTHROPIC_MODEL` — defaults to `claude-opus-4-20250514`
- `ANTHROPIC_REQUEST_TIMEOUT_MS` — defaults to `15000`
- `ANTHROPIC_MAX_RETRIES` — defaults to `2`

Copy the template, then edit it with your values:

```bash
git clone https://github.com/Mikeishiring/slackbot.git
cd slackbot

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your values
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

### 4. Run Locally

The app loads `.env` automatically in local development.

```bash
npm start
```

Go to Slack, @mention your bot, ask it something.

Before testing in a channel, invite the bot:

```text
/invite @YourBotName
```

### 5. Smoke Test

Run both checks:

1. Send the bot a DM such as `what's new this week?`
2. Mention the bot in a public channel where it has been invited

Expected result:

- The bot replies in the DM thread
- The bot replies in the channel thread
- With the starter data, the answer should reference items from `data/sample-data.json`
- `npm run check` passes locally

### 6. Deploy to Railway (optional)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Pick your repo
4. Go to **Variables** → add the required env vars from `.env`
5. Done. Railway runs `npm start` automatically.

Verification:

- Railway logs should show `Bot is running (Socket Mode)`
- No public URL is required because this bot uses Socket Mode

**Other hosting options:** Fly.io, DigitalOcean, Render, any VPS, Docker — anything that can run `npm start` and stay alive.

---

## Project Structure

```
README.md          ← Public setup guide.
CLAUDE.md          ← Agent runbook for browser/coding agents.
src/
  index.ts         ← Entry point. Loads config and wires Slack + Agent + Tools.
  config.ts        ← Environment parsing and defaults.
  slack.ts         ← Slack connection. Messages in, responses out.
  agent.ts         ← Claude API + tool loop. The LLM thinks here.
  tools.ts         ← YOUR TOOLS. The first file you should customize.
data/
  sample-data.json ← Fake data. Swap for your real data source.
test/              ← Minimal contract tests for config, agent, Slack, and tools.
.env.example       ← Environment template for local/dev/prod setup.
```

## Connect Your Own Data

Open `src/tools.ts`. Three things to change:

1. **Tool definitions** — describe what queries your data supports
2. **Tool implementations** — write the functions that run those queries
3. **`loadData()`** — swap the sample JSON read for your real data source

```typescript
// Example: connect to a SQL database instead of a JSON file
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL);

function searchItems(query: string) {
  return sql`SELECT * FROM items WHERE title ILIKE ${'%' + query + '%'} LIMIT 10`;
}
```

```typescript
// Example: call a REST API instead
async function searchItems(query: string) {
  const res = await fetch(`https://api.example.com/search?q=${query}`);
  return res.json();
}
```

## How It Scales

Day 1, `src/tools.ts` is one file with 3 tools. When you outgrow it:

```
src/tools.ts  →  src/tools/
                   ├── index.ts      ← same exports, re-routes to sub-files
                   ├── search.ts     ← search tools
                   ├── reports.ts    ← report tools
                   └── actions.ts    ← write tools (with confirmations)
```

`agent.ts` doesn't change. It imports `tools` and `runTool` — doesn't matter if that comes from one file or ten.

## Cost

| Component | Monthly cost |
|-----------|-------------|
| Slack | Free |
| Anthropic API | ~$5-50 depending on usage |
| Railway | ~$5-20 |

Main cost driver is tokens. Longer system prompts and bigger data responses = more tokens per message.

## Security

Running an LLM in Slack creates a new surface area. Here's what to watch for.

### 1. Conversation Storage

By default, this bot is **stateless** — messages go to the LLM and the response comes back. No database, no logs, no conversation history beyond the current thread.

If you deploy on Railway with just the LLM, **no conversation data is stored anywhere** beyond Slack itself and Anthropic's API (subject to their [data retention policy](https://www.anthropic.com/policies)).

If you add a database for memory or analytics, you're now storing user conversations. Consider encryption, retention policies, and access controls.

### 2. Slack Scope Discipline

Every OAuth scope you add is an attack surface. The bot ships with **read-only access** — it can read messages and write replies. That's it.

| Scope | Risk | Guidance |
|-------|------|----------|
| `chat:write` | Low — bot can only reply | Required |
| `channels:history` | Medium — reads all channel messages | Only channels the bot is invited to |
| `files:write` | **High** — bot can upload files | Add only if needed |
| `users:read` | Medium — access to user profiles | Add only if needed |
| `admin.*` | **Critical** — workspace admin powers | Never give to a bot |

**Principle of least privilege.** Start with the minimum scopes. Add more only when a specific tool needs them — and document why.

### 3. Channel & Tool Scoping

The bot responds wherever it's invited. To limit its reach:

- **Channel allowlist** — only respond in specific channels (check `event.channel` in `slack.ts`)
- **Tool restrictions** — read-only tools first, write tools behind confirmation
- **User allowlist** — restrict who can trigger the bot if needed

The tools you define in `tools.ts` are the bot's hands. A `search_items` tool is safe. A `delete_items` or `run_sql` tool is a loaded gun.

### 4. Third-Party & MCP Trust

MCP servers are powerful — and that's the risk. When you connect an MCP server, you're giving Claude access to whatever that server exposes.

- **Only connect MCP servers you control or trust.** A malicious server could return prompt injections in tool results.
- **Audit tool lists** — check what tools an MCP server exposes before connecting (`client.listTools()`)
- **Network isolation** — run MCP servers in the same private network as the bot, not on the public internet
- **Local tools first** — if you can do it in `tools.ts`, don't add an MCP dependency

### 5. Prompt Injection & Database Access

**An LLM is not a security boundary.** If you give the bot a database connection, assume a skilled user can extract any data reachable by that connection. System prompts like "never return PII" are guidelines, not guardrails — they can be bypassed through prompt injection.

Unless you are running the bot in an isolated container with a read-only database replica, scoped credentials, and row-level security, **assume that connecting a database means exposing everything in it.**

Mitigations:

- Keep tools **read-only** by default — injection is harmless if the worst case is a search query
- **Don't put secrets in the system prompt** — assume it can be extracted
- **Validate tool inputs** in `runTool()` before executing — don't trust Claude's parameters blindly
- **Scope database credentials** to only the tables/views the bot needs — don't use an admin connection
- **Use a read-only replica** or materialized views that contain only safe-to-expose data
- **Enforce access control at the data layer** (row-level security, view permissions), never at the prompt layer

### 6. Key & Secret Hygiene

- **Never commit `.env`** — it's in `.gitignore` by default
- **Rotate keys** if you suspect exposure
- **Use platform secrets** (Railway, Fly.io env vars) in production — not files
- **Error messages** should never include API keys or tokens — the bot's error handler returns a generic fallback message by design

### 7. Rate Limiting & Abuse

There's no built-in rate limiting. A user (or automated script) could spam the bot and run up your Anthropic bill. Consider:

- **Per-user cooldowns** — track last message timestamp per user
- **Monthly spend caps** — set usage limits in the [Anthropic Console](https://console.anthropic.com)
- **Channel restrictions** — limit the bot to specific channels to reduce exposure

**TL;DR:** Ship read-only, scope tight, don't store what you don't need, and treat every MCP server like a dependency — vet it before you trust it.

## Notes

This repo is intentionally small. The main extension point is `src/tools.ts`: replace the sample JSON reader with your database, API, or internal service and keep the Slack and agent loop unchanged.
