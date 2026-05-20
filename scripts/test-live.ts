/**
 * Live end-to-end test. Calls the real agent with the real tools and prints
 * each response in raw and Slack-bound form.
 *
 * Loads ANTHROPIC_API_KEY from the environment (set before running).
 * Run: npx tsx scripts/test-live.ts
 */

import { createAgent } from "../src/agent.js";
import { tools, runTool } from "../src/tools.js";
import { toSlackMrkdwn } from "../src/format.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is not set");
  process.exit(1);
}

const questions = [
  "what shipped this month?",
  "tell me about the march 18 outage",
  "any news about widgetz inc?",
  "give me a quick state of the business — wins, risks, watchouts",
];

const agent = createAgent({
  anthropicApiKey: apiKey,
  tools,
  runTool,
});

const divider = "─".repeat(72);

for (const question of questions) {
  console.log(`\n${divider}`);
  console.log(`  Q: ${question}`);
  console.log(divider);

  const start = Date.now();
  try {
    const raw = await agent.respond(question, []);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`\n[RAW — ${elapsed}s — what Claude emits]\n`);
    console.log(raw);
    console.log(`\n[CONVERTED — what Slack sees]\n`);
    console.log(toSlackMrkdwn(raw));
  } catch (err: unknown) {
    console.log("ERROR:", err instanceof Error ? err.message : String(err));
  }
}
