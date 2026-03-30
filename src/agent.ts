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

const SYSTEM_PROMPT = `You're a helpful teammate that answers questions using the tools available to you.

Keep answers short - one screen max. Lead with the answer, context second.
Use Slack formatting: *bold* for emphasis, bullet points (-) for lists.
If you can't find what someone's looking for, say so and suggest a different search.
When you reference data, be specific - include names, dates, and numbers.`;

const DEFAULT_MODEL = "claude-opus-4-20250918";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_TOOL_CALLS = 10;
const MAX_THREAD_HISTORY_MESSAGES = 12;
const MAX_HISTORY_MESSAGE_CHARS = 600;
const MAX_USER_MESSAGE_CHARS = 2_000;

type RunTool = (
  name: string,
  input: Record<string, unknown>
) => Promise<unknown>;

interface AgentConfig {
  anthropicApiKey: string;
  tools: Tool[];
  runTool: RunTool;
  model?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

interface Agent {
  respond: (text: string, threadHistory: string[]) => Promise<string>;
}

export function createAgent(config: AgentConfig): Agent {
  const client = new Anthropic({
    apiKey: config.anthropicApiKey,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeout: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });
  const model = config.model ?? DEFAULT_MODEL;

  return {
    respond: async (text: string, threadHistory: string[]): Promise<string> => {
      const messages = buildMessages(threadHistory, text);
      return runConversation(client, model, config.tools, config.runTool, messages);
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
          content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
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
