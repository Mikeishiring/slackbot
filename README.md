# Policy Bot

Automated counterparty screening for crypto infrastructure companies. Tell it who to check in Slack, it runs the compliance workflow and hands you a PDF.

```
You:  "screen Kraken, they're a crypto exchange"
Bot:  Creates case, resolves Payward Inc. (DE), runs 7 checks...
      :white_check_mark: entity resolution
      :white_check_mark: good standing
      :eyes: reputation search -- 23 results flagged
      :white_check_mark: bbb review
      :white_check_mark: ofac precheck
      :white_check_mark: ofac search
      "4/5 checks passed. Want me to share the PDF report?"
```

---

## How It Works

### View 1: The Simple Version

```mermaid
graph LR
    A["Slack message"] --> B["Claude (Opus)"]
    B --> C["Screening Engine"]
    C --> D["PDF Report"]
    D --> E["Slack thread"]

    style A fill:#4A154B,color:#fff,stroke:none
    style B fill:#D97706,color:#fff,stroke:none
    style C fill:#2563EB,color:#fff,stroke:none
    style D fill:#059669,color:#fff,stroke:none
    style E fill:#4A154B,color:#fff,stroke:none
```

Someone messages the bot. Claude understands what they want, runs the screening, and delivers results back to Slack with a PDF report.

---

### View 2: The Architecture

```mermaid
graph TB
    subgraph "Slack Interface"
        A["User message"] --> B["Socket Mode"]
        B --> C["Rate Limiter<br/>5 req/min/user"]
        C --> D["Claude Opus<br/>15 tools available"]
    end

    subgraph "Screening Engine"
        D --> E["Tool Runner<br/>thread-context-aware"]
        E --> F["create_case"]
        E --> G["get_case / search"]
        E --> H["resolve_review"]
        E --> I["share_report"]

        F --> J["Policy Workflow"]
        J --> K["Job Queue<br/>SQLite + WAL"]
    end

    subgraph "Evidence Collection"
        K --> L["Entity Resolution<br/>Known hints + Web search + TOS"]
        K --> M["Good Standing<br/>OpenCorporates + Registry search"]
        K --> N["Reputation Search<br/>Brave API + Noise filter"]
        K --> O["BBB Review<br/>Rating + Complaints"]
        K --> P["OFAC Precheck<br/>SDN dataset match"]
        K --> Q["OFAC Search<br/>Playwright automation"]
    end

    subgraph "Output"
        J --> R["PDF Report<br/>styled, status-colored"]
        J --> S["Step Notifications<br/>emoji in thread"]
        R --> T["Slack file upload"]
    end

    style A fill:#4A154B,color:#fff,stroke:none
    style D fill:#D97706,color:#fff,stroke:none
    style J fill:#2563EB,color:#fff,stroke:none
    style R fill:#059669,color:#fff,stroke:none
    style K fill:#1e40af,color:#fff,stroke:none
```

---

### View 3: Every Decision Mapped

```mermaid
flowchart TB
    START(["Message received"]) --> RATE{"Rate limit<br/>check"}
    RATE -->|Blocked| RATE_MSG["'Slow down' reply"]
    RATE -->|Allowed| CLAUDE["Claude Opus processes"]

    CLAUDE --> INTENT{"What does<br/>the user want?"}
    INTENT -->|"Screen a company"| DUP_CHECK["search_cases<br/>duplicate check"]
    INTENT -->|"Check status"| GET_CASE["get_case"]
    INTENT -->|"Review queue"| GET_QUEUE["get_review_queue"]
    INTENT -->|"Resolve review"| ACL{"Reviewer<br/>access?"}
    INTENT -->|"Share report"| SHARE["share_report<br/>upload PDF"]
    INTENT -->|"General question"| ANSWER["Claude answers<br/>from context"]

    ACL -->|Denied| ACL_MSG["'Need reviewer access'"]
    ACL -->|Allowed| RESOLVE["resolve_review_task"]

    DUP_CHECK --> DUP{"Existing<br/>active case?"}
    DUP -->|Yes| DUP_WARN["Warn user,<br/>ask to proceed"]
    DUP -->|No| CREATE["create_case"]
    DUP_WARN -->|Proceed| CREATE

    CREATE --> BIND["Bind case to<br/>Slack thread"]
    BIND --> ENQUEUE["Enqueue first<br/>workflow step"]

    subgraph "Background Worker (polls every 5s)"
        ENQUEUE --> CLAIM["Claim next job<br/>(transactional lock)"]
        CLAIM --> STEP_TYPE{"Which step?"}

        STEP_TYPE -->|entity_resolution| ER_START["Check known<br/>entity hints"]
        ER_START --> ER_HINT{"Hint<br/>found?"}
        ER_HINT -->|Yes| ER_PATCH["Apply curated<br/>legal name + jurisdiction"]
        ER_HINT -->|No| ER_TOS["Fetch website<br/>TOS pages"]
        ER_TOS --> ER_TOS_OK{"Legal name<br/>found?"}
        ER_TOS_OK -->|Yes| ER_PATCH
        ER_TOS_OK -->|No| ER_WEB["Web search:<br/>'entity incorporation'"]
        ER_WEB --> ER_WEB_OK{"Name +<br/>jurisdiction?"}
        ER_WEB_OK -->|Yes| ER_PATCH
        ER_WEB_OK -->|No| ER_BLOCK["BLOCKED<br/>ask user in Slack"]
        ER_PATCH --> ER_REGISTRY["Build registry<br/>routing"]
        ER_REGISTRY --> ER_PASS["PASSED"]

        STEP_TYPE -->|good_standing| GS_START["Search OpenCorporates<br/>+ ICIS + LEI"]
        GS_START --> GS_FETCH{"Registry page<br/>found?"}
        GS_FETCH -->|Yes| GS_READ["Fetch page,<br/>extract status"]
        GS_FETCH -->|No| GS_SNIPPET["Check search<br/>snippets"]
        GS_READ --> GS_STATUS{"Status<br/>indicator?"}
        GS_SNIPPET --> GS_STATUS
        GS_STATUS -->|"Active"| GS_PASS["PASSED"]
        GS_STATUS -->|"Inactive"| GS_FAIL["FAILED<br/>case terminated"]
        GS_STATUS -->|"Unknown"| GS_MANUAL["MANUAL REVIEW<br/>registry link provided"]

        STEP_TYPE -->|reputation_search| RS_START["Brave API:<br/>7 queries x 10 results"]
        RS_START --> RS_CONTEXT["Add industry<br/>qualifier (crypto)"]
        RS_CONTEXT --> RS_NOISE["Filter noise:<br/>'is X a scam' posts"]
        RS_NOISE --> RS_COUNT{"Adverse<br/>count?"}
        RS_COUNT -->|"<= 5"| RS_PASS["PASSED"]
        RS_COUNT -->|"> 5 + classifier"| RS_LLM["Opus classifies:<br/>enforcement vs noise"]
        RS_COUNT -->|"> 5 no classifier"| RS_MANUAL["MANUAL REVIEW"]
        RS_LLM --> RS_REAL{"Real adverse<br/>count?"}
        RS_REAL -->|"0"| RS_PASS
        RS_REAL -->|"> 0"| RS_MANUAL

        STEP_TYPE -->|bbb_review| BBB_START["Capture BBB page"]
        BBB_START --> BBB_EXTRACT["Extract rating +<br/>complaint count"]
        BBB_EXTRACT --> BBB_CHECK{"Real<br/>complaints?"}
        BBB_CHECK -->|"No"| BBB_PASS["PASSED"]
        BBB_CHECK -->|"Yes"| BBB_MANUAL["MANUAL REVIEW"]

        STEP_TYPE -->|ofac_precheck| OFAC_PRE["Download SDN<br/>XML dataset"]
        OFAC_PRE --> OFAC_MATCH{"Exact name<br/>match?"}
        OFAC_MATCH -->|No| OFAC_PRE_PASS["PASSED"]
        OFAC_MATCH -->|Yes| OFAC_PRE_FAIL["CRITICAL: manual review"]

        STEP_TYPE -->|ofac_search| OFAC_SEARCH["Playwright: navigate<br/>OFAC search tool"]
        OFAC_SEARCH --> OFAC_SCORE{"Results at<br/>score >= 90?"}
        OFAC_SCORE -->|No| OFAC_SEARCH_PASS["PASSED"]
        OFAC_SCORE -->|Yes| OFAC_SEARCH_FAIL["CRITICAL: manual review"]

        ER_PASS & ER_BLOCK --> NOTIFY1["Post to Slack thread"]
        GS_PASS & GS_FAIL & GS_MANUAL --> NOTIFY2["Post to Slack thread"]
        RS_PASS & RS_MANUAL --> NOTIFY3["Post to Slack thread"]
        BBB_PASS & BBB_MANUAL --> NOTIFY4["Post to Slack thread"]
        OFAC_PRE_PASS & OFAC_PRE_FAIL --> NOTIFY5["Post to Slack thread"]
        OFAC_SEARCH_PASS & OFAC_SEARCH_FAIL --> NOTIFY6["Post to Slack thread"]

        NOTIFY1 & NOTIFY2 & NOTIFY3 & NOTIFY4 & NOTIFY5 & NOTIFY6 --> DECIDE["Evaluate case<br/>decision"]
        DECIDE --> NEXT["Enqueue next step"]
    end

    DECIDE --> REPORT["Generate PDF<br/>+ working report"]
    REPORT --> DONE{"All steps<br/>complete?"}
    DONE -->|"Yes, all passed"| APPROVED["APPROVED"]
    DONE -->|"Hard gate failed"| TERMINATED["TERMINATED"]
    DONE -->|"Reviews pending"| AWAITING["AWAITING REVIEW"]

    style START fill:#4A154B,color:#fff,stroke:none
    style CLAUDE fill:#D97706,color:#fff,stroke:none
    style CREATE fill:#2563EB,color:#fff,stroke:none
    style APPROVED fill:#059669,color:#fff,stroke:none
    style TERMINATED fill:#DC2626,color:#fff,stroke:none
    style AWAITING fill:#F59E0B,color:#000,stroke:none
    style ER_PASS fill:#059669,color:#fff,stroke:none
    style GS_PASS fill:#059669,color:#fff,stroke:none
    style RS_PASS fill:#059669,color:#fff,stroke:none
    style BBB_PASS fill:#059669,color:#fff,stroke:none
    style OFAC_PRE_PASS fill:#059669,color:#fff,stroke:none
    style OFAC_SEARCH_PASS fill:#059669,color:#fff,stroke:none
    style ER_BLOCK fill:#DC2626,color:#fff,stroke:none
    style GS_FAIL fill:#DC2626,color:#fff,stroke:none
    style GS_MANUAL fill:#F59E0B,color:#000,stroke:none
    style RS_MANUAL fill:#F59E0B,color:#000,stroke:none
    style BBB_MANUAL fill:#F59E0B,color:#000,stroke:none
    style OFAC_PRE_FAIL fill:#DC2626,color:#fff,stroke:none
    style OFAC_SEARCH_FAIL fill:#DC2626,color:#fff,stroke:none
```

---

## Setup

### Prerequisites

- Node.js 20+
- Slack workspace with admin access
- Anthropic API key (Claude Opus)
- Brave Search API key (free, 2000 queries/month)

### 1. Clone & Install

```bash
git clone https://github.com/Mikeishiring/slackbot.git && cd slackbot
npm install
npm run setup    # installs Playwright Chromium for evidence capture
```

### 2. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) > Create New App > From Scratch
2. **Socket Mode** > toggle on > generate app token (`xapp-`)
3. **OAuth & Permissions** > add bot scopes:
   - `app_mentions:read`, `chat:write`, `channels:history`, `reactions:write`, `im:history`, `files:write`
4. **Event Subscriptions** > subscribe to: `app_mention`, `message.im`
5. **Install to Workspace** > copy bot token (`xoxb-`)

### 3. Get API Keys

- **Anthropic**: [console.anthropic.com](https://console.anthropic.com) > Create API key
- **Brave Search**: [brave.com/search/api](https://brave.com/search/api/) > Get free API key

### 4. Configure

```bash
cp .env.example .env
```

Fill in:
```env
POLICY_BOT_RUNTIME=slack
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_APP_TOKEN=xapp-your-token
ANTHROPIC_API_KEY=sk-ant-your-key
BRAVE_SEARCH_API_KEY=your-brave-key
```

### 5. Run

```bash
npm start
```

Logs should show `Bot is running (Socket Mode)`.

### 6. Test

1. Invite the bot: `/invite @YourBotName`
2. Send: `@YourBotName screen Alchemy, they're a web3 dev platform`
3. Watch the automated checks run with emoji updates in the thread

---

## Architecture

### Project Structure

```
src/
  index.ts          Entry point, wires Claude + Slack + background worker
  agent.ts          Claude Opus conversation loop with per-call tool injection
  tools.ts          15 tools: read (get_case, search) + action (create, resolve, share)
  runtime.ts        Orchestrator: Slack dispatch, case lifecycle, notifications
  workflow.ts       Policy engine: step ordering, dependencies, decision evaluation
  connectors.ts     Evidence gathering: Brave, Playwright, OFAC, known entity hints
  classifier.ts     Opus-based adverse result classification (enforcement vs noise)
  storage.ts        SQLite: cases, facts, issues, jobs, audit trail
  artifacts.ts      Local storage + PDF report generation (PDFKit)
  policy.ts         YAML policy loader (decision-matrix + source-registry)
  config.ts         30+ env vars with sensible defaults
  types.ts          Domain types (cases, facts, issues, reviews, jobs)
  slack.ts          Socket Mode, rate limiting, file uploads, notifications
  admin.ts          Case export, health snapshots, retention pruning
  utils.ts          ID generation, normalization, hashing
policy/
  decision-matrix.yml   7-step workflow definition
  source-registry.yml   Evidence source configuration
```

### The 7-Step Screening Workflow

| # | Step | Type | What It Does | Auto-Pass Rate |
|---|------|------|-------------|:--------------:|
| 1 | Public Market Shortcut | Optional | NYSE/NASDAQ listed? Skip everything | N/A |
| 2 | Entity Resolution | Hard gate | Resolve legal name + jurisdiction | **100%** |
| 3 | Good Standing | Hard gate | Verify active in official registry | **17%** |
| 4 | Reputation Search | Soft | Search for fraud/scam/lawsuit signals | **22%** |
| 5 | BBB Review | Soft | Better Business Bureau check | **94%** |
| 6 | OFAC Precheck | Hard gate | Automated sanctions dataset match | **100%** |
| 7 | OFAC Search | Hard gate | Official OFAC search tool (score 90+) | **100%** |

Hard gates terminate the case on failure. Auto-pass rates measured across 18 crypto companies.

### Entity Resolution Strategy

```mermaid
graph TD
    A["Company name + website"] --> B{"Known entity<br/>hint?"}
    B -->|Yes| C["Apply curated<br/>legal name + jurisdiction"]
    B -->|No| D["Fetch website<br/>TOS / Legal / Privacy pages"]
    D --> E{"Legal name<br/>found in page?"}
    E -->|Yes| F["Extract + patch case"]
    E -->|No| G["Brave Search:<br/>'entity incorporation'"]
    G --> H{"Found in search<br/>snippets?"}
    H -->|Yes| F
    H -->|No| I["Ask user in Slack"]
    I --> J["User provides jurisdiction"]
    J --> F
    F --> K["Route to official registry"]
    C --> K

    style A fill:#4A154B,color:#fff,stroke:none
    style C fill:#059669,color:#fff,stroke:none
    style F fill:#059669,color:#fff,stroke:none
    style I fill:#F59E0B,color:#000,stroke:none
    style K fill:#2563EB,color:#fff,stroke:none
```

### Known Entity Database

The bot ships with curated entity hints for 18+ crypto companies:

| Company | Legal Entity | Jurisdiction |
|---------|-------------|:---:|
| Offchain Labs | Offchain Labs, Inc. | DE |
| Uniswap Labs | Universal Navigation, Inc. | DE |
| OP Labs | OP Labs PBC | DE |
| Flashbots | Flashbots Ltd. | Cayman |
| Kraken | Payward, Inc. | DE |
| Alchemy | Alchemy Insights, Inc. | DE |
| Chainalysis | Chainalysis, Inc. | DE |
| Polymarket | Polymarket, Inc. | DE |
| Mesh | Mesh Connect, Inc. | DE |
| 0x | ZeroEx, Inc. | DE |
| Privy | Horkos, Inc. | DE |
| Chainlink | SmartContract Chainlink Ltd. SEZC | Cayman |
| bloXroute | bloXroute Labs, Inc. | IL |
| 1inch | 1inch Limited | BVI |
| Arc | Circle Internet Group, Inc. | DE |
| Bebop | Wintermute Trading Ltd | UK |
| Monad | Monad Foundation | Cayman |
| Rain | Rain Financial Inc. | DE |

Each new company screened builds the database automatically via profile reuse.

### Security & Access Control

- **Rate limiting**: 5 messages/minute/user
- **Reviewer access**: `POLICY_BOT_REVIEWER_USER_IDS` restricts finalize and resolve actions
- **Error sanitization**: file paths, PIDs, API keys stripped before reaching Slack
- **Job locking**: single-transaction recovery + claim prevents double execution
- **Graceful shutdown**: SIGTERM waits 30s for in-flight jobs
- **Audit trail**: every action logged with actor, timestamp, case linkage

### Deployment

**Railway** (recommended):

```bash
git push origin main
# Railway auto-detects Dockerfile, builds with Chromium
# Set env vars in Railway dashboard
```

**Docker**:

```bash
docker build -t policy-bot .
docker run -e SLACK_BOT_TOKEN=... -e SLACK_APP_TOKEN=... -e ANTHROPIC_API_KEY=... -e BRAVE_SEARCH_API_KEY=... policy-bot
```

**Local**:

```bash
npm start                              # Slack mode
npm start health                       # System health
npm start run-batch companies.json 3   # Batch screening with 3 workers
npm start show-case case_xxx           # Case details
```

---

## Cost

| Component | Monthly Cost |
|-----------|:-----------:|
| Slack | Free |
| Anthropic (Opus) | ~$20-80 depending on volume |
| Brave Search | Free (2,000 queries/month) |
| Railway | ~$5-20 |

Each screening uses ~7 Brave queries + 1-3 Opus tool calls. A team screening 50 companies/month runs about $40-60 total.

---

## Environment Variables

| Variable | Required | Default |
|----------|:--------:|---------|
| `SLACK_BOT_TOKEN` | Yes | -- |
| `SLACK_APP_TOKEN` | Yes | -- |
| `ANTHROPIC_API_KEY` | Yes | -- |
| `BRAVE_SEARCH_API_KEY` | Recommended | -- |
| `ANTHROPIC_MODEL` | No | `claude-opus-4-6-20260205` |
| `POLICY_BOT_RUNTIME` | No | `slack` |
| `POLICY_BOT_REVIEWER_USER_IDS` | No | anyone can finalize |
| `POLICY_BOT_OFAC_DATASET_URLS` | No | Treasury defaults |
| `GOOGLE_SEARCH_API_KEY` | No | Brave preferred |

See `.env.example` for the full list with all optional configuration.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot doesn't respond | Check scopes + event subscriptions. Reinstall app after changes. |
| `Bot is running` but no replies | Invite the bot: `/invite @YourBotName` |
| Reputation search returns 0 results | Set `BRAVE_SEARCH_API_KEY` -- Google blocks headless browsers |
| Entity resolution blocked | Bot will ask for jurisdiction in Slack. Common: DE, Cayman, BVI |
| High API costs | Set spend cap in Anthropic Console. Use Sonnet instead of Opus for lower cost |
| Good standing manual review | Expected -- Delaware doesn't offer free programmatic status checks |
| `Slack authentication failed` | Check tokens are real, not `.env.example` placeholders |

---

## Security Notes

These notes document the security posture of this bot based on real setup experience.

### What the bot CAN access

| Credential | Access Scope | Risk if Leaked |
|------------|-------------|----------------|
| `SLACK_BOT_TOKEN` (xoxb-) | Post messages and upload files ONLY in channels the bot is invited to. Read messages ONLY where @mentioned. | Attacker could post messages as the bot in its channels. Revoke immediately at api.slack.com/apps. |
| `SLACK_APP_TOKEN` (xapp-) | Establish Socket Mode WebSocket connection. Cannot read messages or post. | Attacker could connect as the bot (but still can't read channels without the bot token). Revoke at api.slack.com/apps. |
| `ANTHROPIC_API_KEY` | Make Claude API calls billed to your account. No access to Slack or Drive. | Attacker could run up API charges. Set a spend cap at console.anthropic.com. Rotate immediately. |
| `BRAVE_SEARCH_API_KEY` | Run web searches. No access to Slack, Drive, or any internal systems. | Attacker could use your search quota (2,000/month free). Low risk. |
| Google service account JSON | Upload/read files ONLY in the specific Drive folder shared with it. Zero access to anything else. | Attacker could read/write files in the shared folder. Remove service account access from the folder to revoke. |

### What the bot CANNOT access

- Messages in channels it hasn't been invited to
- Messages that don't @mention it (even in channels it's in)
- Private channels (no `groups:history` scope)
- DMs (manifest only includes `app_mention`, not `message.im`)
- Your Google Drive files outside the shared "Policy Bot Reports" folder
- Any other Slack workspace settings, users, or admin functions
- Email, calendar, or any Google service besides Drive

### Channel isolation

The bot is designed to operate in **one channel only**. It only responds to @mentions. To restrict it:

1. Invite it to exactly one channel: `/invite @Policy Bot`
2. Don't invite it anywhere else
3. It physically cannot see or respond in channels it's not in

Even if someone @mentions "Policy Bot" in a different channel, the bot won't receive the event because Slack only delivers events for channels the bot is a member of.

### Keys exposed during setup

During browser-based setup, the following were visible in the conversation:

- **Brave Search API key** -- rotate at brave.com/search/api
- **Anthropic API key** -- rotate at console.anthropic.com
- **Slack tokens** -- visible in screenshots; rotate if concerned (api.slack.com/apps > Policy Bot > regenerate)
- **Google service account JSON** -- downloaded locally, never committed to git (in `.gitignore`)

**Best practice:** After initial setup, rotate all keys that appeared in any conversation, logs, or screenshots. Store the new keys only in `.env` (local) or Railway environment variables (production). Never commit `.env` to git.

### Socket Mode security

The bot uses Slack's Socket Mode, which means:

- **No public HTTP endpoint** -- the bot connects outbound to Slack's WebSocket servers
- **No URL to attack** -- there's nothing to send requests to
- **No webhook validation needed** -- Slack handles authentication via the WebSocket handshake
- **Firewall-friendly** -- only outbound connections on port 443

This is more secure than traditional webhook-based Slack apps which require a public URL.
