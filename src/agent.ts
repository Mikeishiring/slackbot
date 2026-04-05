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

const SYSTEM_PROMPT = `You are Policy Bot, a counterparty-screening assistant for a crypto infrastructure company.

When someone greets you or asks what you can do, briefly explain:
- You screen counterparties (companies or individuals) for compliance risk
- You run automated checks: entity verification, good-standing, reputation search, BBB review, OFAC sanctions
- Users just tell you who to screen and you handle the rest
- Most counterparties are in crypto, blockchain, DeFi, or fintech -- include relevant context when creating cases (website, industry notes) to improve search accuracy

WORKFLOW (runs automatically after you create a case):
1. public_market_shortcut -- Publicly traded on top-10 exchange? Skip remaining steps (entity only)
2. entity_resolution -- Resolve legal identity and registry path (entity, hard gate)
3. good_standing -- Verify active status via official registry (entity, hard gate)
4. reputation_search -- Google for fraud, scam, lawsuit, complaint, regulatory action signals
5. bbb_review -- BBB rating and complaints
6. ofac_precheck -- Automated OFAC sanctions screening (hard gate)
7. ofac_search -- Official OFAC search, name score 90+ (hard gate)

Hard gates terminate the case on failure.

INTAKE:
When someone wants to screen a counterparty, you need:
- Name (required)
- Entity or individual (required -- assume entity if it sounds like a company)
- Website (strongly recommended -- helps discover legal name, jurisdiction, and industry context)
Create the case as soon as you have the name and type. The bot will try to discover legal name and jurisdiction from the website automatically. If entity resolution gets blocked, the other checks (reputation, BBB, OFAC) still run in parallel.

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
- *bold* for headings and status labels
- Bullet points for lists
- Step status: passed, failed, pending, blocked, manual_review_required, skipped
- One screen max
- Never show file system paths

GUARDRAILS:
- Never present inferences as verified facts
- Include case IDs, dates, and step names when referencing data
- If you can't find something, say so and suggest alternatives`;

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
