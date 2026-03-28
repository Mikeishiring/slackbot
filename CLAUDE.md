# Slackbot Agent Runbook

This file is for coding agents and browser-driven setup agents working in this repo.

`README.md` is the canonical end-user setup guide. Keep this file aligned with it. If they conflict, fix the docs before making more changes.

## What This Repo Is

A minimal Slack bot starter:

- Slack Bolt in Socket Mode
- Anthropic Claude with tool use
- One main extension point: `src/tools.ts`
- Local `.env` loading via `dotenv/config`
- Validation commands: `npm run check`, `npm test`, `npm run typecheck`

## Current Repo State

Key files:

- `src/index.ts` — loads config, creates the agent, starts Slack
- `src/config.ts` — environment parsing and defaults
- `src/slack.ts` — Slack event handling, thread history, reply path
- `src/agent.ts` — Claude loop, context trimming, response handling
- `src/tools.ts` — tool definitions and implementations
- `data/sample-data.json` — starter dataset
- `.env.example` — environment template
- `test/` — contract tests for config, agent, Slack, and tools

Runtime expectations:

- Node.js 20+
- Socket Mode only
- No inbound webhook server or public URL required

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

Local development uses `.env` automatically. The repo includes `.env.example`.

## Browser Setup Runbook

Use this sequence when guiding setup through Slack, Anthropic, and Railway in a browser.

### 1. Local Setup

Run:

```bash
npm install
cp .env.example .env
npm start
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
npm install
npm start
```

Fill `.env` with the Slack and Anthropic credentials before starting.

### 2. Slack App Setup

In Slack app settings:

1. Create the app from scratch.
2. Enable Socket Mode.
3. Generate an app token starting with `xapp-`.
4. Add bot scopes:
   - `app_mentions:read`
   - `chat:write`
   - `channels:history`
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

## Smoke Test

Run both tests after setup:

1. Send the bot a DM such as `what's new this week?`
2. Mention the bot in a public channel where it has been invited

Expected behavior:

- The bot replies in the DM thread
- The bot replies in the mentioned channel thread
- The reply references sample data unless `tools.ts` has already been customized

## Implementation Guidance

When extending the repo:

- Change `src/tools.ts` first
- Keep Slack handling and agent wiring small
- Prefer read-only tools first
- Do not add broad abstractions without a concrete need

If modifying bot behavior, keep these invariants:

- `README.md` remains the public setup source of truth
- `.env.example` matches runtime config
- `npm test` passes
- `npm run typecheck` passes

## Safe Changes vs Risky Changes

Usually safe:

- Updating `tools.ts`
- Changing the system prompt in `agent.ts`
- Adjusting timeout or retry env defaults
- Adding tests
- Improving docs

Needs extra care:

- Adding write tools
- Changing Slack scopes or event subscriptions
- Adding private-channel support
- Expanding context retention or memory
- Returning large tool payloads to Claude
