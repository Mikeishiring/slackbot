/**
 * Claude conversation — sends messages, runs the tool loop, returns a response.
 *
 * The Anthropic SDK handles request timeouts and retries.
 * This loop only manages conversational state and tool use.
 *
 * This file also declares the contracts the rest of the app speaks:
 * `AgentRequest` (what Slack sends in), `HistoryMessage` (thread context),
 * `ToolContext` (who is asking), and `RunTool` (how tools are invoked).
 * They live here, next to the loop that consumes them, so there is exactly
 * one definition of each.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  Message,
  MessageParam,
  RefusalStopDetails,
  ToolResultBlockParam,
  ToolUnion,
} from "@anthropic-ai/sdk/resources/messages.js";

/**
 * Derived from the real client rather than imported, so this stays correct if
 * the SDK moves or renames its params type.
 */
type StreamParams = Parameters<Anthropic["messages"]["stream"]>[0];

import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS,
  DEFAULT_ANTHROPIC_MAX_RETRIES,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  DEFAULT_ANTHROPIC_EFFORT,
  type AnthropicEffort,
} from "./config.js";

/**
 * Override with `systemPrompt`, or add to it with `systemPromptAppend`.
 *
 * If you replace this wholesale, keep the markdown paragraph — `format.ts`
 * translates that markdown into Slack's dialect, and a prompt that stops
 * asking for markdown will produce flatter replies.
 */
export const DEFAULT_SYSTEM_PROMPT = `You're a helpful teammate that answers questions using the tools available to you.

Lead with the answer. Your first sentence should be the thing the person would
ask for if they said "just give me the short version" - supporting detail comes
after. Keep responses focused and brief: this is a Slack thread, not a report.
Skip preamble, skip restating the question, and skip caveats unless they change
what the reader would do.

Format with standard markdown: **bold** for emphasis, bullet lists with "- ",
and [link text](https://url) for hyperlinks. The bot translates this to
Slack's native rendering, so write normally.
If you can't find what someone's looking for, say so and suggest a different search.
When you reference data, be specific - include names, dates, and numbers.
Answer the question that was asked. Don't expand the scope or volunteer adjacent
work that nobody requested.`;

/** Model turns per message, including tool round-trips. Bounds runaway loops. */
export const MAX_MODEL_TURNS = 10;
/** Thread messages kept as context. This is the limit that actually binds. */
export const MAX_THREAD_HISTORY_MESSAGES = 12;
export const MAX_HISTORY_MESSAGE_CHARS = 600;
export const MAX_USER_MESSAGE_CHARS = 2_000;
/**
 * A runaway tool result can crowd out the rest of the conversation, so cap it.
 * Tune alongside the payloads your own tools return.
 */
export const MAX_TOOL_RESULT_CHARS = 20_000;

const TRUNCATION_NOTE = "truncated - ask a narrower question for the rest";

/** One turn of Slack thread history, already attributed to a role. */
export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * Who is asking, and where. Passed to every tool so a tool can authorize,
 * rate-limit, log, or personalize without any core file changing.
 *
 * `userId` is optional because Slack omits `user` on some events. Beware:
 * `if (context.userId !== "U123") deny()` fails *open* for a deny-list when
 * identity is missing. Prefer allowlists, which fail closed.
 */
export interface ToolContext {
  userId?: string;
  channelId: string;
  threadTs: string;
}

export type RunTool = (
  name: string,
  input: Record<string, unknown>,
  context: ToolContext
) => Promise<unknown>;

export type OnTextDelta = (delta: string, fullText: string) => void;

/** What the Slack layer sends the agent. Declared once, imported by slack.ts. */
export interface AgentRequest {
  text: string;
  history: HistoryMessage[];
  context: ToolContext;
  onTextDelta?: OnTextDelta;
}

/**
 * The slice of the Anthropic client this loop actually uses.
 *
 * Deliberately Anthropic-shaped — this is a test seam, not a provider
 * abstraction. The `thinking` and verbatim-echo invariants below are Anthropic
 * wire facts; hiding them behind a neutral interface would relocate a
 * correctness constraint away from the code that can violate it.
 */
export interface ModelResponse {
  stop_reason?: Message["stop_reason"];
  stop_details?: RefusalStopDetails | null;
  content: Message["content"];
}

export interface ModelStream {
  on(event: "text", callback: (delta: string) => void): unknown;
  finalMessage(): Promise<ModelResponse>;
}

export interface ModelStreamClient {
  messages: {
    stream: (params: StreamParams) => ModelStream;
  };
}

export interface AgentConfig {
  anthropicApiKey?: string;
  tools: ToolUnion[];
  runTool: RunTool;
  model?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  maxTokens?: number;
  effort?: AnthropicEffort;
  /** Replace the whole prompt. Read DEFAULT_SYSTEM_PROMPT's note first. */
  systemPrompt?: string;
  /** Safer: keep the default and add your domain context after it. */
  systemPromptAppend?: string;
  /** Inject a fake in tests, or a pre-configured client in production. */
  client?: ModelStreamClient;
}

export interface Agent {
  respond: (request: AgentRequest) => Promise<string>;
}

export function resolveSystemPrompt(options: {
  systemPrompt?: string;
  systemPromptAppend?: string;
}): string {
  const base = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const append = options.systemPromptAppend?.trim();
  return append ? `${base}\n\n${append}` : base;
}

export function createAgent(config: AgentConfig): Agent {
  const client =
    config.client ??
    new Anthropic({
      ...(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {}),
      maxRetries: config.maxRetries ?? DEFAULT_ANTHROPIC_MAX_RETRIES,
      timeout: config.requestTimeoutMs ?? DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS,
    });

  const model = config.model ?? DEFAULT_ANTHROPIC_MODEL;
  const maxTokens = config.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
  const effort = config.effort ?? DEFAULT_ANTHROPIC_EFFORT;
  // Resolved once at construction, not per message.
  const systemPrompt = resolveSystemPrompt(config);

  return {
    respond: (request: AgentRequest): Promise<string> =>
      runConversation({
        client,
        model,
        tools: config.tools,
        runTool: config.runTool,
        messages: buildMessages(request.history, request.text),
        systemPrompt,
        context: request.context,
        maxTokens,
        effort,
        ...(request.onTextDelta ? { onTextDelta: request.onTextDelta } : {}),
      }),
  };
}

export function buildMessages(
  history: HistoryMessage[],
  text: string
): MessageParam[] {
  const trimmed: MessageParam[] = history
    .slice(-MAX_THREAD_HISTORY_MESSAGES)
    .flatMap((message) => {
      const content = normalizeMessageText(
        message.text,
        MAX_HISTORY_MESSAGE_CHARS
      );
      return content ? [{ role: message.role, content }] : [];
    });

  // The API requires the first message to be a user turn. The trim window can
  // easily open on one of our own replies in a long thread, and consecutive
  // same-role turns are fine — only a leading assistant turn is a 400.
  while (trimmed[0]?.role === "assistant") {
    trimmed.shift();
  }

  const latestText =
    normalizeMessageText(text, MAX_USER_MESSAGE_CHARS) || "(empty message)";

  return [...trimmed, { role: "user", content: latestText }];
}

export interface ConversationRequest {
  client: ModelStreamClient;
  model: string;
  tools: ToolUnion[];
  runTool: RunTool;
  messages: MessageParam[];
  systemPrompt: string;
  context: ToolContext;
  maxTokens?: number;
  effort?: AnthropicEffort;
  onTextDelta?: OnTextDelta;
}

export async function runConversation(
  request: ConversationRequest
): Promise<string> {
  const {
    client,
    model,
    tools,
    runTool,
    systemPrompt,
    context,
    onTextDelta,
  } = request;
  const conversation = [...request.messages];
  const maxTokens = request.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
  const effort = request.effort ?? DEFAULT_ANTHROPIC_EFFORT;
  let streamedText = "";

  for (let turn = 0; turn < MAX_MODEL_TURNS; turn++) {
    let response: ModelResponse;

    try {
      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools,
        messages: conversation,
        // Adaptive thinking measurably improves tool selection. Leaving it off
        // on Claude Opus 5 risks tool calls being emitted as plain text, where
        // they silently never run - use `effort` to control spend instead.
        thinking: { type: "adaptive" },
        output_config: { effort },
      });

      if (onTextDelta) {
        const separator = streamedText ? "\n\n" : "";
        if (separator) {
          streamedText += separator;
          onTextDelta(separator, streamedText);
        }

        stream.on("text", (delta: string) => {
          streamedText += delta;
          onTextDelta(delta, streamedText);
        });
      }

      response = await stream.finalMessage();
    } catch (error) {
      console.error("Model request failed", error);
      return "I couldn't reach the model right now. Please try again.";
    }

    switch (response.stop_reason) {
      case "end_turn":
      case "stop_sequence":
        return collectTextContent(response.content);

      case "max_tokens":
        // Keep whatever was generated rather than throwing the answer away.
        return appendNote(
          collectTextContent(response.content, ""),
          "I hit the response limit before I could finish. Try asking a narrower question."
        );

      case "model_context_window_exceeded":
        return "This thread is too long for me to process. Start a new thread and I'll pick it back up.";

      case "refusal":
        // Partial output on a refusal is discarded, not treated as an answer.
        console.warn(
          "Model declined the request",
          response.stop_details ?? "(no details)"
        );
        return describeRefusal(response.stop_details ?? null);

      case "pause_turn":
        // A server-side tool ran long and can be resumed by re-sending as-is.
        conversation.push({ role: "assistant", content: response.content });
        continue;

      case "tool_use":
        break;

      default:
        console.error("Unhandled stop reason", response.stop_reason);
        return "I couldn't finish that request. Please try again.";
    }

    // Echo the assistant turn back verbatim - thinking and tool_use blocks
    // must survive intact for the next request to validate.
    conversation.push({ role: "assistant", content: response.content });

    const toolResults: ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") {
        continue;
      }

      try {
        const result = await runTool(
          block.name,
          block.input as Record<string, unknown>,
          context
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
      console.error("Model reported tool_use with no tool_use blocks");
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
  content: Array<{ type: string; text?: string }>,
  fallback = "I couldn't generate a response."
): string {
  const text = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim())
    .filter((block): block is string => Boolean(block))
    .join("\n\n");

  return text || fallback;
}

function appendNote(text: string, note: string): string {
  return text ? `${text}\n\n_${note}_` : note;
}

/**
 * Claude Opus 5 runs safety classifiers that can decline a request outright.
 * Surface it as a clear dead end instead of a generic retry prompt - retrying
 * the same message will be declined again.
 */
function describeRefusal(details: RefusalStopDetails | null): string {
  const category = details?.category;
  const suffix = category ? ` (category: ${category})` : "";
  return `I can't help with that request${suffix}. Rephrasing won't change it - try a different question.`;
}

export function serializeToolResult(result: unknown): string {
  const serialized =
    typeof result === "string" ? result : (JSON.stringify(result, null, 2) ?? "null");

  return serialized.length > MAX_TOOL_RESULT_CHARS
    ? `${serialized.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n_${TRUNCATION_NOTE}_`
    : serialized;
}

function normalizeMessageText(text: string, maxChars: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
}
