# Slackbot Agent Runbook

This file is for coding agents and browser-driven setup agents working in this repo.

`README.md` is the canonical end-user setup guide. Keep this file aligned with it. If they conflict, fix the docs before making more changes.

## What This Repo Is

A Slack-native counterparty screening bot:

- Slack Bolt in Socket Mode
- Claude handles all Slack interaction via natural language + tool use
- 7-step policy workflow with SQLite persistence, Playwright evidence capture, PDF reports
- Validation commands: `npm run check`, `npm test`, `npm run typecheck`

## Current Repo State

Key files:

- `src/index.ts` — loads config, wires Claude responder, starts Slack, sets up step-complete notifications
- `src/config.ts` — environment parsing and defaults
- `src/slack.ts` — Slack event handling, thread history, proactive notifications
- `src/agent.ts` — Claude conversation loop with per-call tool injection
- `src/tools.ts` — tool definitions (read + action) and per-request tool runner with thread context
- `src/runtime.ts` — PolicyBotRuntime: orchestrates workflow, storage, Slack command dispatch (CLI/testing)
- `src/workflow.ts` — PolicyWorkflow: case lifecycle, step execution, decision evaluation
- `src/connectors.ts` — Step connectors: Playwright evidence gathering, OFAC, Google, BBB
- `src/storage.ts` — SQLite storage layer (cases, facts, issues, jobs, audit trail)
- `src/artifacts.ts` — Local artifact store, Playwright capture service, PDF report generation
- `src/policy.ts` — YAML policy bundle loader (decision-matrix + source-registry)
- `src/admin.ts` — Case export, health snapshots, retention pruning
- `src/types.ts` — Domain type definitions
- `src/utils.ts` — ID generation, normalization, hashing
- `policy/decision-matrix.yml` — 7-step workflow definition
- `policy/source-registry.yml` — Evidence source configuration
- `.env.example` — environment template
- `test/` — contract tests for all modules (66 tests)

Runtime expectations:

- Node.js 20+
- Socket Mode only — no inbound webhook server or public URL required
- Playwright Chromium browser required for evidence capture: `npm run setup`

Supported Slack surfaces by default:

- Direct messages
- Public channels where the bot has been invited

Not supported by default:

- Private channels

To support private channels, add the Slack scope `groups:history`, reinstall the app, and invite the bot to the private channel.

## Environment Variables

Required:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `ANTHROPIC_API_KEY`

Optional:

- `ANTHROPIC_MODEL`
- `ANTHROPIC_REQUEST_TIMEOUT_MS`
- `ANTHROPIC_MAX_RETRIES`
- `POLICY_BOT_REVIEWER_USER_IDS` — comma-separated Slack user IDs allowed to finalize/resolve (empty = anyone can)
- `POLICY_BOT_OFAC_DATASET_URLS` — override OFAC dataset endpoints if Treasury changes URLs

Local development uses `.env` automatically. The repo includes `.env.example`.

## Browser Setup Runbook

Use this sequence when guiding setup through Slack, Anthropic, and Railway in a browser.

### 1. Local Setup

Run:

```bash
npm install
npm run setup          # installs Playwright Chromium for evidence capture
cp .env.example .env   # then fill in credentials
npm start
```

Windows PowerShell:

```powershell
npm install
npm run setup
Copy-Item .env.example .env
npm start
```

Required credentials in `.env`:
- `SLACK_BOT_TOKEN` — Slack bot token (xoxb-)
- `SLACK_APP_TOKEN` — Slack app token (xapp-)
- `ANTHROPIC_API_KEY` — Anthropic API key for Claude

The bot starts in Slack mode by default (`POLICY_BOT_RUNTIME=slack`). Set to `local` for CLI-only use without Slack.

### 2. Slack App Setup

In Slack app settings:

1. Create the app from scratch.
2. Enable Socket Mode.
3. Generate an app token starting with `xapp-`.
4. Add bot scopes:
   - `app_mentions:read`
   - `chat:write`
   - `channels:history`
   - `reactions:write`
   - `im:history`
5. Subscribe to bot events:
   - `app_mention`
   - `message.im`
6. Install the app to the workspace.
7. Copy the bot token starting with `xoxb-`.

Important:

- After changing scopes or event subscriptions, reinstall the app to the workspace.
- Before testing in a channel, invite the bot: `/invite @YourBotName`

### 3. Anthropic Setup

In Anthropic Console:

1. Create an API key.
2. Put it in `.env` as `ANTHROPIC_API_KEY`.

### 4. Railway Setup

For Railway deployment:

1. Push the repo to GitHub.
2. Create a new Railway project from the GitHub repo.
3. Add the required environment variables in Railway.
4. Deploy.

Verification:

- Railway logs should show `Bot is running (Socket Mode)`.
- No public HTTP URL is required for this bot.

### 5. Railway Deployment

Push to GitHub, then in Railway:

1. Create a new project from the GitHub repo.
2. Railway will auto-detect the `Dockerfile` and build.
3. Set environment variables in Railway dashboard (or Raw Editor):
   - `SLACK_BOT_TOKEN`
   - `SLACK_APP_TOKEN`
   - `ANTHROPIC_API_KEY`
4. Deploy. Logs should show `Bot is running (Socket Mode)`.

No public URL, health check port, or volume mount required. SQLite + artifacts live in the container's `/app/var/` directory. For data persistence across deploys, attach a Railway volume mounted at `/app/var`.

## Smoke Test

After setup:

1. Invite the bot to a channel: `/invite @YourBotName`
2. Send: `@YourBotName screen Acme Labs, they're a Delaware company`
3. Try a DM: just message the bot directly with a screening request

Expected behavior:

- The bot responds conversationally asking for any missing details
- It creates a screening case and links it to the Slack thread
- Background workflow steps run automatically with progress updates appearing in the thread
- Send `what's the status?` in the thread for a case update
- Send `what's in the review queue?` to see pending review tasks

## Architecture: Natural Language First

All Slack messages route through Claude with tool use. The flow:

```
Slack message → slack.ts → runtime.handleSlackRequest()
  → createToolRunner(runtime, threadContext)
  → agent.respond(text, history, runTool)
  → Claude picks tools → runTool executes → Claude formats response
```

Key pattern: `getToolDefinitions()` returns static tool schemas (created once), `createToolRunner()` returns a per-request executor with the thread's case context baked in. This lets Claude tools auto-resolve "the current case" without explicit IDs.

Step-complete notifications post to Slack threads automatically when background workflow steps finish.

## Implementation Guidance

When extending the repo:

- Add new capabilities as Claude tools in `src/tools.ts` (add definition to `TOOL_DEFINITIONS`, handler to `createToolRunner`)
- Keep tool output curated — return structured summaries, never file paths
- The system prompt in `agent.ts` teaches Claude how to use the tools
- `runtime.ts:dispatchCommand()` exists for CLI/testing only, not the primary Slack path
- Policy steps and evidence sources are configured in `policy/*.yml`

Invariants:

- `.env.example` matches runtime config
- `npm test` passes (66+ tests)
- `npm run typecheck` passes
- Thread-context-aware tools must use `resolveCase()` for case ID resolution

## Production Features

- **Rate limiting**: 5 messages/minute/user at the Slack event handler level (slack.ts)
- **Access control**: `POLICY_BOT_REVIEWER_USER_IDS` restricts finalize_case and resolve_review_task to designated reviewers
- **Duplicate detection**: create_case checks for existing active cases with similar names and returns a warning
- **Case search**: search_cases tool lets Claude find prior cases by counterparty name
- **Error sanitization**: file paths, PIDs, and API keys are stripped from error messages before reaching Slack
- **Graceful shutdown**: SIGTERM waits up to 30s for in-flight jobs to finish before closing
- **Job locking**: recovery + claim runs in a single SQLite transaction to prevent double-execution
- **Step notifications**: Slack thread gets progress updates as background workflow steps complete
- **Configurable OFAC URLs**: `POLICY_BOT_OFAC_DATASET_URLS` overrides hardcoded Treasury endpoints

## Safe Changes vs Risky Changes

Usually safe:

- Adding new tools to `tools.ts`
- Updating the system prompt in `agent.ts`
- Adding policy steps to `decision-matrix.yml`
- Adding evidence sources to `source-registry.yml`
- Adjusting timeout or retry env defaults
- Adding tests

Needs extra care:

- Adding write tools that modify external systems
- Changing Slack scopes or event subscriptions
- Adding private-channel support
- Changing the `handleSlackRequest` routing
- Modifying the notification callback chain
- Returning large tool payloads to Claude
