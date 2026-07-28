# Slackbot Agent Runbook

This file is for coding agents and browser-driven setup agents working in this repo.

`README.md` is the canonical end-user setup guide. Keep this file aligned with it. If they conflict, fix the docs before making more changes.

## What This Repo Is

A minimal Slack bot starter:

- Slack Bolt in Socket Mode
- Anthropic Claude with tool use
- Local `.env` loading via `dotenv/config`
- Validation commands: `npm run check`, `npm test`, `npm run typecheck`

## Six Files, Two Are Yours

The organizing rule: **separate the file you READ from the file you EDIT.**

| File | Role |
|------|------|
| `src/tools.ts` | **User-owned.** Data source and capabilities. |
| `src/index.ts` | **User-owned.** Wiring and policy: persona, shutdown, extra Slack handlers. |
| `src/slack.ts` | Machine. Socket Mode, thread history, streaming, chunking. |
| `src/agent.ts` | Machine. Claude loop + the contracts the app speaks. |
| `src/format.ts` | Machine. markdown → Slack mrkdwn. |
| `src/config.ts` | Machine. Env parsing and exported defaults. |

Seams belong where the *change* belongs, not where the code happens to live. When
asked to make something customizable, first check whether the knob can move into
one of the two user-owned files. Prefer that over introducing a layer.

`agent.ts` declares `AgentRequest`, `HistoryMessage`, `ToolContext`, and
`RunTool` exactly once; `slack.ts` and `tools.ts` import them. Do not re-declare
these shapes.

## Current Repo State

Key files:

- `src/index.ts` — loads config, creates the agent, starts Slack, owns shutdown
- `src/config.ts` — environment parsing and defaults
- `src/slack.ts` — Slack event handling, thread history, reply path
- `src/agent.ts` — Claude loop, shared contracts, context trimming
- `src/format.ts` — markdown → Slack mrkdwn (code-span safe)
- `src/tools.ts` — colocated tool definitions + implementations
- `data/sample-data.json` — starter dataset
- `manifest.json` — Slack app manifest; source of truth for scopes and events
- `.env.example` — environment template
- `test/` — contract tests for all six modules
- `test/tools.example.test.ts` — copyable template using `setItemSource()`

Runtime expectations:

- Node.js 20+ (enforced via `engines` in `package.json`; CI runs 20, 22, and 24)
- Socket Mode only
- No inbound webhook server or public URL required

`npm test` pins its glob to `test/*.test.ts`. Keep it pinned — Node's default
test-file discovery widened in Node 22 and started collecting
`scripts/test-live.ts`, which needs live credentials.

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

- `ANTHROPIC_MODEL` (default `claude-opus-5`)
- `ANTHROPIC_SYSTEM_PROMPT_APPEND` (appended to `DEFAULT_SYSTEM_PROMPT`; no default constant, deliberately)
- `ANTHROPIC_MAX_TOKENS` (default `16000`; caps thinking + reply text together)
- `ANTHROPIC_EFFORT` (default `medium`; one of `low`, `medium`, `high`, `xhigh`, `max`)
- `ANTHROPIC_REQUEST_TIMEOUT_MS` (default `120000`, per attempt)
- `ANTHROPIC_MAX_RETRIES` (default `2`)
- `SLACK_ALLOWED_CHANNELS` (comma-separated channel IDs; restricts @-mention responses; DMs always allowed)

Defaults live in `src/config.ts` and are exported — assert against those exports in tests rather than hardcoding values.

Local development uses `.env` automatically. The repo includes `.env.example`.

## Model Invariants

The agent runs on a thinking model. Two rules matter when editing `src/agent.ts`:

- **Keep `thinking: {type: "adaptive"}` on.** With thinking disabled this model
  can emit a tool call as plain text — the call silently never runs and the bot
  answers as if it had data. Control cost with `ANTHROPIC_EFFORT`, not by
  disabling thinking. (Disabling it is also rejected outright at `xhigh`/`max`.)
- **Echo assistant turns back verbatim.** `runConversation` pushes
  `response.content` unchanged; thinking and `tool_use` blocks must survive
  intact or the next request fails validation. Don't map or filter that array.

`stop_reason` is handled exhaustively — `refusal` and
`model_context_window_exceeded` included. Add a branch rather than widening the
`default` case if a new one appears.

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
- Wiring and policy in `index.ts`
- Setting the persona via `ANTHROPIC_SYSTEM_PROMPT_APPEND` or `systemPromptAppend`
- Adjusting timeout, retry, effort, or max-token env defaults
- Adding tests
- Improving docs

Needs extra care:

- Adding write tools
- Changing Slack scopes or event subscriptions (update `manifest.json` **and** the README security table together)
- Adding private-channel support
- Expanding context retention or memory
- Returning large tool payloads to Claude
- Anything that edits `slack.ts`, `agent.ts`, `format.ts`, or `config.ts`

## Recipes

Each is a change in a user-owned file. Do not introduce an abstraction to serve one of these.

**Swap the data source** — `tools.ts` → replace the body of `loadSampleFile`. It is
`async`, so a query drops straight in. Cache lives in `loadItems`; if the source is
remote, drop the cache or give it a TTL. Close pools in `closeTools`.

**Add a tool** — `tools.ts` → add one `LocalTool` to `LOCAL_TOOLS`. Schema and `run`
are the same object, so an advertised tool cannot lack an implementation. Reuse the
validators under the KEEP THESE banner.

**Enable an Anthropic-hosted tool** — `tools.ts` → add to `SERVER_TOOLS` (a commented
`web_search` example is there). No `run` needed; `agent.ts` already handles `pause_turn`.

**Change the persona** — `.env` → `ANTHROPIC_SYSTEM_PROMPT_APPEND` for a sentence;
`index.ts` → `systemPromptAppend` for anything longer (dotenv drops unquoted newlines).
`systemPrompt` replaces the prompt outright — keep the markdown paragraph or `format.ts`
has nothing to convert.

**Gate a tool by user** — `tools.ts` → at the top of that tool's `run`:
`if (!ALLOWED.has(context.userId ?? "")) return { error: "Not authorized" };`
Use an allowlist. `context.userId` is optional, so a deny-list fails *open*.

**Add a slash command or button** — `index.ts` → `bot.app.command(...)` on the returned
handle. A commented example is in the file. Do not edit `slack.ts` for this.

## Non-Goals

Do not implement these without an explicit request; each is a fork, not a feature flag:

- HTTP mode / `SLACK_SIGNING_SECRET` (Socket Mode only)
- Serverless or Lambda deployment (assumes a long-running process)
- Block Kit replies (the reply path is a string end to end)
- Image or file input (attachments get an honest refusal)
- Native `mcp_servers` (beta-only; wrap MCP as a tool instead)

## Do Not "Clean Up" These

Deliberate decisions that look like smells. Leave them alone.

- **`startSlackBot` takes four fields, not `AppConfig`.** Narrow parameters keep each
  module's blast radius readable from its signature and keep the
  `exactOptionalPropertyTypes` spreads precise.
- **`slack.ts` is one long file.** It has exactly one intra-`src` import. Splitting it
  trades zero indirection for a dependency graph; line count is not the metric.
- **No `src/tools/` folder, no `src/types.ts`, no `src/lib/`.** Not earned at this size.
  When `tools.ts` outgrows itself the split is `git mv src/tools.ts src/tools/search.ts`
  plus a re-export barrel — do it then, not now.
- **`ModelStreamClient` is Anthropic-shaped on purpose.** It is a test seam, not a
  provider abstraction. Generalizing it would relocate the model invariants above away
  from the code that can violate them.
- **`agent.ts` imports defaults from `config.ts`.** The direction is arguably backwards,
  but flipping it unlocks no customization and moves five constants plus their tests.
- **`ToolContext.userId` is optional.** Slack genuinely omits it. Making it required
  would be a lie; the hazard is documented on the type.
