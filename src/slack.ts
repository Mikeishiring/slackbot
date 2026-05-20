/**
 * Slack connection — Socket Mode.
 *
 * Receives messages, fetches thread history, streams agent text into a
 * single message in the thread.
 */

import pkg from "@slack/bolt";
const { App } = pkg;

import { toSlackMrkdwn } from "./format.js";

const FALLBACK_ERROR_MESSAGE =
  "I hit an error while processing that message. Please try again.";
const THREAD_HISTORY_LIMIT = 20;
const PLACEHOLDER_TEXT = "…";
const STREAM_UPDATE_INTERVAL_MS = 1_500;
const MAX_CHUNK_SIZE = 3_500;
const STREAM_TRUNCATION_SUFFIX = "… _(continuing)_";

type OnTextDelta = (delta: string, fullText: string) => void;

interface SlackConfig {
  botToken: string;
  appToken: string;
  allowedChannels?: ReadonlySet<string>;
  onMessage: (
    text: string,
    threadHistory: string[],
    onTextDelta?: OnTextDelta
  ) => Promise<string>;
}

interface ThreadHistoryMessage {
  bot_id?: string;
  text?: string;
}

interface ThreadHistoryResult {
  messages?: ThreadHistoryMessage[];
}

export interface SlackChatClient {
  chat: {
    update: (params: {
      channel: string;
      ts: string;
      text: string;
    }) => Promise<unknown>;
  };
}

export interface SlackReactionsClient {
  reactions: {
    add: (params: {
      channel: string;
      timestamp: string;
      name: string;
    }) => Promise<unknown>;
    remove: (params: {
      channel: string;
      timestamp: string;
      name: string;
    }) => Promise<unknown>;
  };
}

export interface SlackHistoryClient extends SlackChatClient, SlackReactionsClient {
  conversations: {
    replies: (params: {
      channel: string;
      ts: string;
      limit: number;
    }) => Promise<ThreadHistoryResult>;
  };
}

export interface MentionEvent {
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
}

export interface DirectMessageEvent {
  channel_type: "im";
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  bot_id?: string;
  bot_profile?: Record<string, unknown>;
  subtype?: string;
}

export type SlackSay = (message: {
  text: string;
  thread_ts: string;
}) => Promise<{ ts?: string } | undefined>;

export async function startSlackBot(config: SlackConfig): Promise<void> {
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
  });

  app.event("app_mention", async ({ event, client, say }) => {
    if (!isMentionEvent(event)) {
      console.error("Received malformed app_mention event", event);
      return;
    }

    if (!isChannelAllowed(config.allowedChannels, event.channel)) {
      console.log(
        `Ignoring app_mention in non-allowlisted channel: ${event.channel}`
      );
      return;
    }

    const text = normalizeMentionText(event.text);
    if (!text) return;

    await handleIncomingMessage(
      client,
      (message) => say(message) as ReturnType<SlackSay>,
      event.channel,
      event.thread_ts ?? event.ts,
      text,
      config.onMessage,
      event.ts
    );
  });

  app.event("message", async ({ event, client, say }) => {
    if (!shouldHandleDirectMessage(event)) return;

    const text = normalizeInboundText(event.text ?? "");
    if (!text.trim()) return;

    await handleIncomingMessage(
      client,
      (message) => say(message) as ReturnType<SlackSay>,
      event.channel,
      event.thread_ts ?? event.ts,
      text,
      config.onMessage,
      event.ts
    );
  });

  await app.start();
  console.log("Bot is running (Socket Mode)");
}

async function getThreadHistory(
  client: SlackHistoryClient,
  channel: string,
  threadTs: string
): Promise<string[]> {
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: THREAD_HISTORY_LIMIT,
    });

    return (result.messages ?? [])
      .slice(0, -1)
      .flatMap((message) => {
        const role = message.bot_id ? "assistant" : "user";
        const content = normalizeInboundText(message.text ?? "");

        return content ? [`${role}: ${content}`] : [];
      });
  } catch (error) {
    console.error("Failed to load thread history", error);
    return [];
  }
}

export async function handleIncomingMessage(
  client: SlackHistoryClient,
  say: SlackSay,
  channel: string,
  threadTs: string,
  text: string,
  onMessage: SlackConfig["onMessage"],
  messageTs?: string
): Promise<void> {
  const reactionTs = messageTs ?? threadTs;
  await addReaction(client, channel, reactionTs, "eyes");

  const placeholder = await postPlaceholder(say, threadTs);

  try {
    const threadHistory = await getThreadHistory(client, channel, threadTs);

    if (!placeholder?.ts) {
      const response = await onMessage(text, threadHistory);
      await sendChunks(
        say,
        threadTs,
        chunkText(toSlackMrkdwn(response), MAX_CHUNK_SIZE)
      );
      return;
    }

    const placeholderTs = placeholder.ts;
    const updater = createThrottledUpdater(
      (nextText) =>
        client.chat.update({
          channel,
          ts: placeholderTs,
          text: truncateForStream(toSlackMrkdwn(nextText)),
        }),
      STREAM_UPDATE_INTERVAL_MS
    );

    const response = await onMessage(text, threadHistory, (_delta, fullText) => {
      updater.schedule(fullText);
    });

    await updater.cancel();

    const chunks = chunkText(toSlackMrkdwn(response), MAX_CHUNK_SIZE);
    await client.chat.update({ channel, ts: placeholderTs, text: chunks[0] ?? "" });
    if (chunks.length > 1) {
      await sendChunks(say, threadTs, chunks.slice(1));
    }
  } catch (error) {
    console.error("Failed to handle Slack message", error);
    await sendErrorReply(client, say, channel, threadTs, placeholder?.ts);
  } finally {
    await removeReaction(client, channel, reactionTs, "eyes");
  }
}

async function addReaction(
  client: SlackReactionsClient,
  channel: string,
  timestamp: string,
  name: string
): Promise<void> {
  try {
    await client.reactions.add({ channel, timestamp, name });
  } catch {
    // Non-critical — don't block the response
  }
}

async function removeReaction(
  client: SlackReactionsClient,
  channel: string,
  timestamp: string,
  name: string
): Promise<void> {
  try {
    await client.reactions.remove({ channel, timestamp, name });
  } catch {
    // Non-critical — reaction may have been manually removed
  }
}

async function postPlaceholder(
  say: SlackSay,
  threadTs: string
): Promise<{ ts?: string } | undefined> {
  try {
    return await say({ text: PLACEHOLDER_TEXT, thread_ts: threadTs });
  } catch (error) {
    console.error("Failed to post placeholder message", error);
    return undefined;
  }
}

async function sendErrorReply(
  client: SlackChatClient,
  say: SlackSay,
  channel: string,
  threadTs: string,
  placeholderTs: string | undefined
): Promise<void> {
  if (placeholderTs) {
    try {
      await client.chat.update({
        channel,
        ts: placeholderTs,
        text: FALLBACK_ERROR_MESSAGE,
      });
      return;
    } catch (updateError) {
      console.error("Failed to update placeholder with error", updateError);
    }
  }

  try {
    await say({ text: FALLBACK_ERROR_MESSAGE, thread_ts: threadTs });
  } catch (replyError) {
    console.error("Failed to send Slack error message", replyError);
  }
}

interface ThrottledUpdater {
  schedule(text: string): void;
  cancel(): Promise<void>;
}

/**
 * Leading-edge throttle with cancel.
 *
 * - First call fires immediately (instant feedback on first token).
 * - Subsequent calls within the interval coalesce — only the latest text wins.
 * - cancel() stops the timer and awaits any in-flight update without emitting
 *   anything more — caller takes over the final state (e.g. chunked sends).
 *
 * Concurrency: at most one update in flight at a time.
 */
export function createThrottledUpdater(
  update: (text: string) => Promise<unknown>,
  intervalMs: number
): ThrottledUpdater {
  let pendingText: string | null = null;
  let lastEmittedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<unknown> = Promise.resolve();
  let lastEmittedText = "";

  function fire(text: string): void {
    if (text === lastEmittedText) return;
    lastEmittedAt = Date.now();
    lastEmittedText = text;
    inFlight = update(text).catch((error: unknown) => {
      console.error("Failed to update Slack message", error);
    });
  }

  function schedule(text: string): void {
    pendingText = text;
    if (timer) return;

    const elapsed = Date.now() - lastEmittedAt;
    if (elapsed >= intervalMs) {
      const next = pendingText;
      pendingText = null;
      fire(next);
      return;
    }

    timer = setTimeout(() => {
      timer = null;
      if (pendingText !== null) {
        const next = pendingText;
        pendingText = null;
        fire(next);
      }
    }, intervalMs - elapsed);
  }

  async function cancel(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingText = null;
    await inFlight;
  }

  return { schedule, cancel };
}

export function truncateForStream(text: string): string {
  if (text.length <= MAX_CHUNK_SIZE) return text;
  const headroom = MAX_CHUNK_SIZE - STREAM_TRUNCATION_SUFFIX.length;
  return text.slice(0, headroom).trimEnd() + STREAM_TRUNCATION_SUFFIX;
}

export function chunkText(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  let remaining = text;
  const minSplit = Math.floor(maxSize * 0.5);

  while (remaining.length > maxSize) {
    let splitAt = remaining.lastIndexOf("\n\n", maxSize);
    if (splitAt < minSplit) splitAt = remaining.lastIndexOf("\n", maxSize);
    if (splitAt < minSplit) splitAt = remaining.lastIndexOf(" ", maxSize);
    if (splitAt < minSplit) splitAt = maxSize;

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function sendChunks(
  say: SlackSay,
  threadTs: string,
  chunks: string[]
): Promise<void> {
  for (const chunk of chunks) {
    await say({ text: chunk, thread_ts: threadTs });
  }
}

export function normalizeMentionText(text: string): string {
  return normalizeInboundText(text.replace(/<@[A-Z0-9]+>/g, " "));
}

export function isChannelAllowed(
  allowlist: ReadonlySet<string> | undefined,
  channel: string
): boolean {
  return !allowlist || allowlist.has(channel);
}

export function shouldHandleDirectMessage(
  event: unknown
): event is DirectMessageEvent {
  return (
    isDirectMessageEvent(event) &&
    !event.bot_id &&
    !event.bot_profile &&
    !event.subtype
  );
}

function normalizeInboundText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isMentionEvent(event: unknown): event is MentionEvent {
  if (!isRecord(event)) {
    return false;
  }

  return (
    typeof event.text === "string" &&
    typeof event.channel === "string" &&
    typeof event.ts === "string" &&
    (event.thread_ts === undefined || typeof event.thread_ts === "string")
  );
}

function isDirectMessageEvent(event: unknown): event is DirectMessageEvent {
  if (!isRecord(event)) {
    return false;
  }

  return (
    event.channel_type === "im" &&
    typeof event.channel === "string" &&
    typeof event.ts === "string" &&
    (event.thread_ts === undefined || typeof event.thread_ts === "string") &&
    (event.text === undefined || typeof event.text === "string") &&
    (event.bot_id === undefined || typeof event.bot_id === "string") &&
    (event.bot_profile === undefined || isRecord(event.bot_profile)) &&
    (event.subtype === undefined || typeof event.subtype === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
