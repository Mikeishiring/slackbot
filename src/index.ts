/**
 * Entry point — wires Slack, Agent, and Tools together.
 * Run with: npx tsx src/index.ts
 */

import "dotenv/config";
import { pathToFileURL } from "url";

import { createAgent } from "./agent.js";
import { getConfig } from "./config.js";
import { startSlackBot } from "./slack.js";
import { runTool, tools } from "./tools.js";

export async function main(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const config = getConfig(env);

  const agent = createAgent({
    anthropicApiKey: config.anthropicApiKey,
    tools,
    runTool,
    model: config.anthropicModel,
    requestTimeoutMs: config.anthropicRequestTimeoutMs,
    maxRetries: config.anthropicMaxRetries,
  });

  await startSlackBot({
    botToken: config.slackBotToken,
    appToken: config.slackAppToken,
    onMessage: agent.respond,
  });
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
