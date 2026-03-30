# 🤖 Slack Bot + LLM Starter

> Give your team an AI teammate that answers questions from your data — right inside Slack.

```
User: "What's new this week?"
Bot:  "3 items this week — Q1 roadmap update, Acme's Series B,
       and the sales pipeline review..."
```

Clone. Set 3 keys. Run. That's it.

---

## ⚡ How It Works

```mermaid
graph LR
    A["💬 Slack"] -->|message| B["🧠 Agent"]
    B -->|tool call| C["🔧 Tools"]
    C -->|query| D["📦 Your Data"]
    D -->|results| C
    C -->|response| B
    B -->|reply| A

    style A fill:#4A154B,color:#fff,stroke:#4A154B
    style B fill:#D97706,color:#fff,stroke:#D97706
    style C fill:#2563EB,color:#fff,stroke:#2563EB
    style D fill:#059669,color:#fff,stroke:#059669
```

Someone messages your bot in Slack. Claude reads the message, decides which tools to call, gets data back, and replies in the thread. You control what tools exist.

**4 files, 1 extension point:**

| File | What it does |
|------|-------------|
| `src/slack.ts` | Receives messages, posts replies |
| `src/agent.ts` | Claude API + tool loop |
| `src/tools.ts` | **Your tools — edit this first** |
| `src/config.ts` | Environment variables + defaults |

---

## 🔒 Before You Start — What Gets Stored?

```mermaid
graph LR
    subgraph "Your Bot (stateless)"
        A["Message in"] --> B["Claude processes"] --> C["Reply out"]
    end

    subgraph "Where data lives"
        D["Slack<br/>Messages stay in Slack"]
        E["Anthropic API<br/>Subject to their<br/>retention policy"]
    end

    B -.->|"API call"| E
    A -.->|"stored by"| D
    C -.->|"stored by"| D

    style A fill:#059669,color:#fff,stroke:none
    style B fill:#D97706,color:#fff,stroke:none
    style C fill:#059669,color:#fff,stroke:none
    style D fill:#4A154B,color:#fff,stroke:none
    style E fill:#2563EB,color:#fff,stroke:none
```

**By default, this bot stores nothing.** No database, no logs, no conversation history. Messages live in Slack. API calls go to Anthropic (see their [data retention policy](https://www.anthropic.com/policies)). That's it.

If you add a database later, you're now storing conversations — think about encryption, retention, and access controls before you do.

---

## 🚀 Setup

You need **3 things**: a Slack app, an Anthropic key, and this repo.

```mermaid
graph LR
    A["1️⃣ Create Slack App<br/>Get 2 tokens"] --> B["2️⃣ Get Anthropic Key<br/>~$5 credits"]
    B --> C["3️⃣ Clone & Run<br/>Paste tokens in .env"]

    style A fill:#4A154B,color:#fff,stroke:none
    style B fill:#D97706,color:#fff,stroke:none
    style C fill:#059669,color:#fff,stroke:none
```

### Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From Scratch**
2. Name it whatever you want, pick your workspace
3. **Socket Mode** → toggle on → generate an app token (starts with `xapp-`)
4. **OAuth & Permissions** → add bot scopes:
   - `app_mentions:read` — see when someone @mentions the bot
   - `chat:write` — post replies
   - `channels:history` — read thread history for context
   - `im:history` — read DMs *(skip this for channel-only mode)*
5. **Install to Workspace** → copy the bot token (starts with `xoxb-`)
6. **Event Subscriptions** → toggle on → subscribe to:
   - `app_mention` — someone @mentions the bot
   - `message.im` — someone DMs the bot *(skip for channel-only)*

> **Changed scopes or events?** Reinstall the app to the workspace.
> **Want private channels?** Add `groups:history`, reinstall, and invite the bot.

### Step 2: Get an Anthropic Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API key
3. Add credits (~$5 is plenty to start)
4. **Set a monthly spend cap** — there's no built-in rate limiting in the bot

### Step 3: Clone & Run

```bash
git clone https://github.com/Mikeishiring/slackbot.git && cd slackbot
npm install
cp .env.example .env   # then paste your 3 tokens
npm start
```

<details>
<summary>Windows PowerShell</summary>

```powershell
Copy-Item .env.example .env
npm install
npm start
```

</details>

### Step 4: Test It

1. Invite the bot to a channel: `/invite @YourBotName`
2. Send: `@YourBotName what's new this week?`
3. Also try a DM — just message the bot directly

Expected: the bot replies in a thread with information from the sample dataset.

`npm run check` runs both linting and tests locally.

<details>
<summary>🤖 <strong>Agent / automated setup</strong> (Claude Code, Cursor, Codex)</summary>

<br/>

1. **Slack App** — use the **App Manifest** JSON editor (`Settings → App Manifests`), not individual pages. Set `socket_mode_enabled: true`, scopes + events in one shot.
2. **Tokens** — app-level token with `connections:write`, bot token from OAuth. Both in `.env`.
3. **Scopes** — add `reactions:write` if you implement the 👀 processing indicator. Skip `im:history` for channel-only mode.
4. **Railway** — set vars via Raw Editor or GraphQL (`variableCollectionUpsert`), not one-by-one.
5. **Verify** — `npm run check` locally, then push. Railway auto-deploys.

</details>

---

## 🏗️ Architecture

### Project Structure

```
📁 src/
  ├── index.ts         → Entry point — wires everything together
  ├── config.ts        → Env vars, defaults, validation
  ├── slack.ts         → Socket Mode connection + thread history
  ├── agent.ts         → Claude API + tool loop (max 10 calls)
  └── tools.ts         → ⭐ YOUR TOOLS — start here
📁 data/
  └── sample-data.json → Starter dataset (swap this out)
📁 test/               → Contract tests for all 4 modules
📄 .env.example        → Template — copy to .env and fill in
```

### The Tool Loop

Here's exactly what happens when someone messages your bot:

```mermaid
sequenceDiagram
    participant S as Slack
    participant A as Agent (Claude)
    participant T as tools.ts

    S->>A: "What happened with Acme?"
    A->>T: search_items({query: "Acme"})
    T-->>A: [{title: "Acme Series B", id: "item-002"...}]
    A->>T: get_item({id: "item-002"})
    T-->>A: {content: "Acme raised $45M..."}
    A-->>S: "Acme announced a $45M Series B led by Sequoia..."
```

Claude decides which tools to call, how many times (up to 10), and how to summarize the results. You define what tools exist and what data they return.

### What's Included

The starter ships with 3 read-only tools against a sample JSON file:

| Tool | What it does |
|------|-------------|
| `search_items` | Keyword search with optional tag filter |
| `get_item` | Full details for one item by ID |
| `list_recent` | Most recent items (default: last 7 days) |

---

## 🔧 Connect Your Data

Open `src/tools.ts` — three things to change:

```mermaid
graph TD
    A["1️⃣ Tool Definitions"] -->|"what can Claude call?"| B["Describe inputs + purpose"]
    C["2️⃣ Tool Implementations"] -->|"what runs when called?"| D["Your query logic"]
    E["3️⃣ Data Source"] -->|"where does data live?"| F["JSON → DB / API / MCP"]

    style A fill:#2563EB,color:#fff,stroke:none
    style C fill:#D97706,color:#fff,stroke:none
    style E fill:#059669,color:#fff,stroke:none
    style B fill:#1e40af,color:#fff,stroke:none
    style D fill:#92400e,color:#fff,stroke:none
    style F fill:#065f46,color:#fff,stroke:none
```

**Swap the JSON file for a database:**
```typescript
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL);

function searchItems(query: string) {
  return sql`SELECT * FROM items WHERE title ILIKE ${'%' + query + '%'} LIMIT 10`;
}
```

**Or call a REST API:**
```typescript
async function searchItems(query: string) {
  const res = await fetch(`https://api.example.com/search?q=${query}`);
  return res.json();
}
```

---

## 📈 How It Scales

```mermaid
graph LR
    subgraph "Day 1"
        A["tools.ts<br/>3 tools, 1 file"]
    end

    subgraph "Growing"
        B["tools/<br/>index.ts"]
        C["search.ts"]
        D["reports.ts"]
        E["actions.ts"]
        B --> C
        B --> D
        B --> E
    end

    subgraph "Multi-source"
        F["tools/<br/>index.ts"]
        G["Local tools"]
        H["MCP servers"]
        F --> G
        F --> H
    end

    A -.->|"split into folder"| B
    B -.->|"add external sources"| F

    style A fill:#059669,color:#fff,stroke:none
    style B fill:#2563EB,color:#fff,stroke:none
    style C fill:#1e40af,color:#fff,stroke:none
    style D fill:#1e40af,color:#fff,stroke:none
    style E fill:#1e40af,color:#fff,stroke:none
    style F fill:#D97706,color:#fff,stroke:none
    style G fill:#92400e,color:#fff,stroke:none
    style H fill:#92400e,color:#fff,stroke:none
```

`agent.ts` never changes. It imports `tools` and `runTool` — doesn't matter if that's one file or ten.

---

## 🔌 Scaling with MCP

[Model Context Protocol](https://modelcontextprotocol.io) lets you connect external tool servers instead of writing everything in `tools.ts`.

```mermaid
graph LR
    subgraph "Your Bot"
        A["Agent"] --> B["Local Tools<br/>(tools.ts)"]
        A --> C["MCP Client"]
    end

    C --> D["📊 Analytics<br/>MCP Server"]
    C --> E["🗄️ Database<br/>MCP Server"]
    C --> F["📁 Files<br/>MCP Server"]

    style A fill:#D97706,color:#fff,stroke:none
    style B fill:#2563EB,color:#fff,stroke:none
    style C fill:#7C3AED,color:#fff,stroke:none
    style D fill:#059669,color:#fff,stroke:none
    style E fill:#059669,color:#fff,stroke:none
    style F fill:#059669,color:#fff,stroke:none
```

| | Local (`tools.ts`) | MCP Server |
|---|---|---|
| **Best for** | Simple queries, single data source | Shared services, pre-built integrations |
| **Setup** | Edit one file | Run a server + connect |
| **Trust** | You wrote it | Audit what it exposes |

**Start local.** Move to MCP when you need multiple bots on the same data, or a pre-built server already does what you need.

---

## 🛡️ Security

Running an LLM in Slack creates new attack surface. Here's the threat model:

```mermaid
graph TB
    subgraph "🟢 Safe by Default"
        A["Stateless — no data stored"]
        B["Read-only tools only"]
        C["Socket Mode — no public URL"]
    end

    subgraph "🟡 Watch Carefully"
        D["Slack scope creep"]
        E["Unscoped channel access"]
        F["No rate limiting on API spend"]
    end

    subgraph "🔴 High Risk if Added"
        G["Database with write access"]
        H["Untrusted MCP servers"]
        I["Secrets in system prompt"]
    end

    style A fill:#059669,color:#fff,stroke:none
    style B fill:#059669,color:#fff,stroke:none
    style C fill:#059669,color:#fff,stroke:none
    style D fill:#D97706,color:#fff,stroke:none
    style E fill:#D97706,color:#fff,stroke:none
    style F fill:#D97706,color:#fff,stroke:none
    style G fill:#DC2626,color:#fff,stroke:none
    style H fill:#DC2626,color:#fff,stroke:none
    style I fill:#DC2626,color:#fff,stroke:none
```

### Slack Scope Discipline

Every OAuth scope is an attack surface. Ship with the minimum:

| Scope | Risk | Guidance |
|-------|------|----------|
| `chat:write` | Low | Required — bot replies |
| `channels:history` | Medium | Only channels bot is invited to |
| `files:write` | **High** | Add only if a tool needs it |
| `admin.*` | **Critical** | Never give to a bot |

### Channel & Tool Scoping

- **Channel allowlist** — check `event.channel` in `slack.ts` to restrict where the bot responds
- **Read-only tools first** — write tools should require confirmation
- **User allowlist** — restrict who can trigger the bot if needed

> `search_items` is safe. `delete_items` or `run_sql` is a loaded gun.

### Third-Party & MCP Trust

- Only connect MCP servers **you control or trust** — a malicious server can inject prompts via tool results
- Audit tool lists before connecting (`client.listTools()`)
- Run MCP in the same private network — not on the public internet
- **Local tools first** — don't add an MCP dependency when `tools.ts` works fine

### Prompt Injection

**An LLM is not a security boundary.** If you give the bot a database connection, assume a skilled user can extract any data reachable by that connection. "Never return PII" in a system prompt is a guideline, not a guardrail — it can be bypassed.

- Keep tools **read-only** — limits damage even if injection succeeds
- **Don't put secrets in the system prompt** — assume it can be extracted
- **Validate tool inputs** in `runTool()` — don't blindly trust Claude's parameters
- **Scope database credentials** — read-only replica, row-level security
- **Enforce access at the data layer**, never at the prompt layer

### Keys & Cost

- Never commit `.env` (gitignored by default)
- Use platform secrets (Railway env vars) in production
- **Set a spend cap** in the [Anthropic Console](https://console.anthropic.com) — there's no built-in rate limiting
- Consider per-user cooldowns if the bot is widely accessible

---

## 🚂 Deploy

```bash
npm start   # local development
```

**Railway** (recommended): Push to GitHub → New Project → Deploy from GitHub → add env vars → done. Logs should show `Bot is running (Socket Mode)`.

**Other hosts:** Fly.io, Render, DigitalOcean, Docker — anything that runs `npm start` and stays alive. No public URL needed.

---

## ⚙️ Environment Variables

| Variable | Required | Default |
|----------|----------|---------|
| `SLACK_BOT_TOKEN` | Yes | — |
| `SLACK_APP_TOKEN` | Yes | — |
| `ANTHROPIC_API_KEY` | Yes | — |
| `ANTHROPIC_MODEL` | No | `claude-opus-4-20250918` |
| `ANTHROPIC_REQUEST_TIMEOUT_MS` | No | `15000` |
| `ANTHROPIC_MAX_RETRIES` | No | `2` |

---

## 💰 Cost

| Component | Monthly cost |
|-----------|-------------|
| Slack | Free |
| Anthropic API | ~$5–50 depending on usage |
| Railway | ~$5–20 |

**What drives cost:** Every message = one or more API calls. Longer tool responses and deeper threads use more tokens. A team of 10 with moderate usage runs ~$10–20/month.

---

## 🔧 Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot doesn't respond | Check scopes + event subscriptions. Reinstall app after changes. |
| `Bot is running` but no replies | Invite the bot: `/invite @YourBotName` |
| `not_found_error` on model | Check `ANTHROPIC_MODEL` — use a valid model ID |
| Socket keeps disconnecting | Check `SLACK_APP_TOKEN` starts with `xapp-` |
| High API costs | Set spend cap in Anthropic Console. Reduce tool response sizes. |
| `Missing required environment variable` | Check `.env` has all 3 required vars filled in |

---

## 📝 Notes

This repo is intentionally small. The only file you need to change is `src/tools.ts` — swap the sample JSON for your database, API, or MCP server and ship it.
