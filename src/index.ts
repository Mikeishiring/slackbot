/**
 * Entry point — wires Slack, Agent, and Tools together. THIS IS YOUR FILE.
 *
 * `tools.ts` owns what the bot can do. This file owns policy: persona,
 * shutdown, and any extra Slack handlers. The four other files in src/ are
 * the machine — you shouldn't need to edit them.
 *
 * Run with: npx tsx src/index.ts
 */

import "dotenv/config";
import { pathToFileURL } from "url";

import { createAgent } from "./agent.js";
import { getConfig } from "./config.js";
import { startSlackBot, type SlackBot } from "./slack.js";
import { closeTools, runTool, tools } from "./tools.js";

export async function main(
  env: NodeJS.ProcessEnv = process.env
): Promise<SlackBot> {
  const config = getConfig(env);

  const agent = createAgent({
    anthropicApiKey: config.anthropicApiKey,
    tools,
    runTool,
    model: config.anthropicModel,
    requestTimeoutMs: config.anthropicRequestTimeoutMs,
    maxRetries: config.anthropicMaxRetries,
    maxTokens: config.anthropicMaxTokens,
    effort: config.anthropicEffort,
    // Adds your domain context after the shipped prompt. To replace the prompt
    // outright use `systemPrompt` — see DEFAULT_SYSTEM_PROMPT in agent.ts for
    // the one paragraph you should keep.
    ...(config.anthropicSystemPromptAppend
      ? { systemPromptAppend: config.anthropicSystemPromptAppend }
      : {}),
  });

  const bot = await startSlackBot({
    botToken: config.slackBotToken,
    appToken: config.slackAppToken,
    ...(config.slackAllowedChannels
      ? { allowedChannels: config.slackAllowedChannels }
      : {}),
    onMessage: agent.respond,
  });

  // Extra Slack surfaces go here — no need to edit slack.ts:
  //
  //   bot.app.command("/ask", async ({ command, ack, respond }) => {
  //     await ack();
  //     const answer = await agent.respond({
  //       text: command.text,
  //       history: [],
  //       context: { channelId: command.channel_id, threadTs: command.trigger_id,
  //                  userId: command.user_id },
  //     });
  //     await respond(answer);
  //   });

  registerShutdownHandlers(async () => {
    // Stop accepting work first, then release resources tools opened.
    await bot.stop();
    await closeTools();
  });

  return bot;
}

/**
 * Hosts like Railway send SIGTERM on redeploy. Closing the socket before
 * exiting stops Slack from redelivering whatever we were mid-way through.
 */
export function registerShutdownHandlers(stop: () => Promise<void>): void {
  let stopping = false;

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;

      console.log(`Received ${signal}, shutting down`);
      stop()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          console.error("Failed to shut down cleanly", error);
          process.exit(1);
        });
    });
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  void main().catch((error) => {
    console.error("Failed to start Slack bot", error);
    process.exit(1);
  });
}

function isEntrypoint(moduleUrl: string, entrypointPath?: string): boolean {
  if (!entrypointPath) {
    return false;
  }

  return moduleUrl === pathToFileURL(entrypointPath).href;
}
