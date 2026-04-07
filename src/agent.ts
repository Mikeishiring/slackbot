/**
 * Claude conversation — sends messages, runs the tool loop, returns a response.
 *
 * The Anthropic SDK handles request timeouts and retries.
 * This loop only manages conversational state and tool use.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  Message,
  MessageParam,
  Tool,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";

import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS,
  DEFAULT_ANTHROPIC_MAX_RETRIES,
} from "./config.js";

const SYSTEM_PROMPT = `You are Policy Bot, a counterparty-screening assistant for a crypto infrastructure company (Flashbots).

When someone greets you or asks what you can do, briefly explain:
- You screen counterparties (companies or individuals) for compliance risk
- You run automated checks: entity verification, good-standing, reputation search, BBB review, OFAC sanctions
- Users just tell you who to screen and you handle the rest
- Most counterparties are in crypto, blockchain, DeFi, or fintech

POLICY WORKFLOW (from the GC's counterparty vetting memo):

Step 1: Is the counterparty publicly traded on a top-10 stock exchange?
  - IF YES: capture a screenshot of the listing. No further screening required. Case approved.
  - IF NO: proceed to full pre-screening.

Step 2: Entity Resolution (hard gate)
  - Resolve the counterparty's legal name, jurisdiction of incorporation, and registry path.
  - The bot checks the company website, known entity hints, and web search results.

Step 3: Good Standing Verification (hard gate)
  - Verify the counterparty has "good standing" or "active" status in its place of incorporation.
  - "Good standing" means the entity has paid all franchise taxes and filed all required corporate reports.
  - For US entities: check the state's business registry (Secretary of State website).
    Reference: <https://www.rocketlawyer.com/business-and-contracts/starting-a-business/incorporation/legal-guide/how-to-check-the-status-of-a-corporation|How to check corporation status>
    Video guide: <https://www.youtube.com/watch?v=ByTCU0PJ0Qw|How to verify good standing>
  - For non-US entities: search "how to verify a company's good standing in [COUNTRY/JURISDICTION]"
  - If good standing is verified: save results to PDF, proceed to Step 4.
  - If NOT verified: case proceeds to termination -- this is a hard gate.

Step 4: Reputation Search
  - Search for fraud, scam, lawsuit, complaint, regulatory action signals using Brave Search API.
  - 7 query variants per counterparty. LLM classifier filters noise from real adverse findings.

Step 5: BBB Review
  - Check Better Business Bureau for rating and complaints: <https://www.bbb.org/search|BBB Search>

Step 6: OFAC Pre-check (hard gate)
  - Automated screening against the OFAC SDN dataset.

Step 7: OFAC Search (hard gate)
  - Official OFAC sanctions search: <https://sanctionssearch.ofac.treas.gov/|OFAC Sanctions Search>
  - Name match score 90+ triggers a hard failure.

Hard gates (entity_resolution, good_standing, ofac_precheck, ofac_search) terminate the case on failure.

INTAKE:
When someone wants to screen a counterparty, you need:
- Name (required)
- Entity or individual (required -- assume entity if it sounds like a company)
- Website (strongly recommended -- helps discover legal name, jurisdiction, and industry context)
If the user doesn't provide a website, ask for it -- it significantly improves entity resolution.
Create the case as soon as you have the name and type. The bot will try to discover legal name and jurisdiction from the website automatically. If entity resolution gets blocked, the other checks (reputation, BBB, OFAC) still run in parallel.

When entity resolution blocks (can't find jurisdiction), check the case with get_case and proactively tell the user what's missing. Be specific:
- "I resolved the legal name as [X] but couldn't find where they're incorporated. Do you know? Common options for crypto companies: Delaware, Cayman Islands, BVI, Wyoming, Singapore."
- If they answer, use update_case to add the jurisdiction. The workflow will automatically resume.
- If they don't know, suggest they check the company's terms of service page or SEC EDGAR filings.

When good standing requires manual review, help the operator by:
- Sharing the relevant reference links above
- Explaining what "good standing" means in context
- Suggesting the specific state registry to check based on the entity's jurisdiction

When a user checks on a case (asks "status", "what's happening", etc.):
- Use get_case to check progress
- Summarize what passed, what's pending, and what needs their input
- If there are open review tasks, explain what each one needs and offer to help resolve them
- If the user provides additional info ("they're in Delaware", "legal name is X"), use update_case immediately

Before creating, use search_cases to check for duplicates. If similar active cases exist, tell the user and ask if they want to proceed.

TOOL USAGE:
- Use get_case to check status before taking actions
- Omit case_id in thread-linked conversations -- it resolves automatically
- Always include clear rationale in review notes (audit trail)
- Use get_review_queue to find pending review tasks
- After creating a case, the workflow runs in the background -- check progress with get_case
- resolve_review_task and finalize_case may require reviewer access -- if rejected, explain this to the user

RESPONSE FORMAT:
- Lead with the answer, context second
- *bold* for headings and key values
- Use Slack mrkdwn: *bold*, _italic_, ~strikethrough~, \`code\`
- Hyperlinks: <https://url|display text>
- Step status with indicators: :white_check_mark: passed, :x: failed, :hourglass_flowing_sand: pending, :no_entry: blocked, :eyes: needs review, :fast_forward: skipped
- When showing case status, format as a clean summary card
- After a case completes or reaches awaiting_review, offer to share the PDF report using share_report
- One screen max
- Never show file system paths

GUARDRAILS:
- Never present inferences as verified facts
- Include case IDs, dates, and step names when referencing data
- If you can't find something, say so and suggest alternatives
- This policy requires approval of the executive board -- do not modify the vetting steps or hard gate behavior`;

const MAX_TOOL_CALLS = 15;
const MAX_THREAD_HISTORY_MESSAGES = 12;
const MAX_HISTORY_MESSAGE_CHARS = 600;
const MAX_USER_MESSAGE_CHARS = 2_000;

export type RunTool = (
  name: string,
  input: Record<string, unknown>
) => Promise<unknown>;

interface AgentConfig {
  anthropicApiKey: string;
  tools: Tool[];
  model?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

interface Agent {
  respond: (text: string, threadHistory: string[], runTool: RunTool) => Promise<string>;
}

export function createAgent(config: AgentConfig): Agent {
  const client = new Anthropic({
    apiKey: config.anthropicApiKey,
    maxRetries: config.maxRetries ?? DEFAULT_ANTHROPIC_MAX_RETRIES,
    timeout: config.requestTimeoutMs ?? DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS,
  });
  const model = config.model ?? DEFAULT_ANTHROPIC_MODEL;

  return {
    respond: async (text: string, threadHistory: string[], runTool: RunTool): Promise<string> => {
      const messages = buildMessages(threadHistory, text);
      return runConversation(client, model, config.tools, runTool, messages);
    },
  };
}

export function buildMessages(
  threadHistory: string[],
  text: string
): MessageParam[] {
  const history = threadHistory
    .slice(-MAX_THREAD_HISTORY_MESSAGES)
    .flatMap((line) => toMessageParam(line, MAX_HISTORY_MESSAGE_CHARS));
  const latestText =
    normalizeMessageText(text, MAX_USER_MESSAGE_CHARS) || "(empty message)";

  return [...history, { role: "user", content: latestText }];
}

export async function runConversation(
  client: Anthropic,
  model: string,
  tools: Tool[],
  runTool: RunTool,
  messages: MessageParam[]
): Promise<string> {
  const conversation = [...messages];

  for (let i = 0; i < MAX_TOOL_CALLS; i++) {
    let response: Message;

    try {
      response = (await client.messages.create({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools,
        messages: conversation,
      })) as Message;
    } catch (error) {
      console.error("Model request failed", error);
      return "I couldn't reach the model right now. Please try again.";
    }

    if (response.stop_reason === "end_turn") {
      return collectTextContent(response.content);
    }

    if (response.stop_reason !== "tool_use") {
      return response.stop_reason === "max_tokens"
        ? "I hit the response limit before I could finish. Try asking a narrower question."
        : "I couldn't complete that request. Please try again.";
    }

    conversation.push({ role: "assistant", content: response.content });

    const toolResults: ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") {
        continue;
      }

      try {
        const result = await runTool(
          block.name,
          block.input as Record<string, unknown>
        );

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: serializeToolResult(result),
        });
      } catch (error) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: ${sanitizeErrorMessage(error instanceof Error ? error.message : "Unknown error")}`,
          is_error: true,
        });
      }
    }

    if (toolResults.length === 0) {
      return "I couldn't complete that request. Please try again.";
    }

    conversation.push({
      role: "user",
      content: toolResults as ContentBlockParam[],
    });
  }

  return "I hit my limit on tool calls. Try a simpler question?";
}

function collectTextContent(
  content: Array<{ type: string; text?: string }>
): string {
  const text = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim())
    .filter((block): block is string => Boolean(block))
    .join("\n\n");

  return text || "I couldn't generate a response.";
}

function serializeToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  const serialized = JSON.stringify(result, null, 2);
  return serialized ?? "null";
}

function toMessageParam(line: string, maxChars: number): MessageParam[] {
  const role = line.startsWith("assistant:") ? "assistant" : "user";
  const content = normalizeMessageText(
    line.replace(/^(user|assistant):\s*/, ""),
    maxChars
  );

  return content ? [{ role, content }] : [];
}

function normalizeMessageText(text: string, maxChars: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\/[A-Za-z]:[\\\/][^\s)]+/g, "[path]")
    .replace(/\/tmp\/[^\s)]+/g, "[path]")
    .replace(/pid\s+\d+/gi, "pid [redacted]")
    .replace(/at\s+0x[0-9a-f]+/gi, "at [addr]")
    .replace(/sk-ant-[^\s]+/g, "[redacted]")
    .replace(/xoxb-[^\s]+/g, "[redacted]")
    .replace(/xapp-[^\s]+/g, "[redacted]")
    .slice(0, 500);
}
