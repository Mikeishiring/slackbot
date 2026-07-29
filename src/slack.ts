/**
 * Slack connection — Socket Mode.
 *
 * Receives messages, fetches thread history, streams agent text into a
 * single message in the thread.
 *
 * `startSlackBot` returns a handle: `stop` for clean shutdown, and `app` —
 * the live Bolt instance — so slash commands, buttons, and `app.use`
 * middleware can be registered from index.ts without editing this file.
 */

import pkg from "@slack/bolt";
const { App } = pkg;

import type { AgentRequest, HistoryMessage, OnTextDelta } from "./agent.js";
import { toSlackMrkdwn } from "./format.js";

// --- Copy and behaviour knobs. Exported so index.ts and tests can reuse them.
export const FALLBACK_ERROR_MESSAGE =
  "I hit an error while processing that message. Please try again.";
export const UNSUPPORTED_ATTACHMENT_MESSAGE =
  "I can't read files or images yet — paste the text and I'll take a look.";
/** Appended when later chunks fail, so a partial answer isn't silently partial. */
export const TRUNCATED_REPLY_MESSAGE =
  "_The rest of this answer failed to post — the reply above may be incomplete._";
/** A bare @-mention or an empty DM. Answering beats silence. */
export const EMPTY_MENTION_MESSAGE =
  "I'm here — ask me a question and I'll look it up.";
export const PLACEHOLDER_TEXT = "…";
/** The emoji shown while the bot is working. */
export const WORKING_REACTION = "eyes";
/**
 * `conversations.replies` pages forward from the thread parent, oldest first,
 * so the recent messages we actually want are on the LAST page. We follow the
 * cursor to the end and keep the tail. How much of that tail reaches the model
 * is agent.ts's MAX_THREAD_HISTORY_MESSAGES.
 */
export const THREAD_FETCH_LIMIT = 100;
/** Bounds API cost on pathological threads. 10 x 100 = 10,000 replies. */
export const MAX_THREAD_PAGES = 10;
export const STREAM_UPDATE_INTERVAL_MS = 1_500;
/**
 * Our own safety margin, not a Slack limit — `chat.postMessage` accepts more
 * (4,000 chars is the practical ceiling). Splitting below it keeps replies
 * comfortably clear of truncation.
 */
export const MAX_CHUNK_SIZE = 3_500;
/** Slack redelivers events on reconnect; remember recent ones to stay idempotent. */
export const DEDUPE_TTL_MS = 10 * 60 * 1_000;
export const DEDUPE_MAX_ENTRIES = 1_000;

const STREAM_TRUNCATION_SUFFIX = "… _(continuing)_";
const NO_UNFURL = { unfurl_links: false, unfurl_media: false } as const;

export interface SlackConfig {
  botToken: string;
  appToken: string;
  allowedChannels?: ReadonlySet<string>;
  onMessage: (request: AgentRequest) => Promise<string>;
}

interface ThreadHistoryMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
}

interface ThreadHistoryResult {
  messages?: ThreadHistoryMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackChatClient {
  chat: {
    update: (params: {
      channel: string;
      ts: string;
      text: string;
      unfurl_links?: boolean;
      unfurl_media?: boolean;
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
      cursor?: string;
    }) => Promise<ThreadHistoryResult>;
  };
}

export interface MentionEvent {
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  // Slack sends these on app_mention too — we used to not even look.
  bot_id?: string;
  bot_profile?: Record<string, unknown>;
  subtype?: string;
  files?: unknown[];
}

export interface DirectMessageEvent {
  channel_type: "im";
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  bot_profile?: Record<string, unknown>;
  subtype?: string;
}

export type SlackSay = (message: {
  text: string;
  thread_ts: string;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}) => Promise<{ ts?: string } | undefined>;

export interface IncomingMessage {
  client: SlackHistoryClient;
  say: SlackSay;
  channel: string;
  threadTs: string;
  text: string;
  onMessage: SlackConfig["onMessage"];
  /** The ts of the message we're replying to — carries the 👀 reaction. */
  messageTs?: string;
  /** Our own bot user ID, used to attribute thread history correctly. */
  botUserId?: string;
  /** The Slack user who sent it, passed through to tools for authorization. */
  userId?: string;
}

/** Handle returned by startSlackBot. `app` is the live Bolt instance. */
export interface SlackBot {
  app: InstanceType<typeof App>;
  stop: () => Promise<void>;
}

export async function startSlackBot(config: SlackConfig): Promise<SlackBot> {
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
  });

  // Needed to tell our own past replies apart from other bots' messages when
  // reconstructing thread history.
  const botUserId = await resolveBotUserId(app);
  const seen = createEventDeduper();

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

    const disposition = classifyMention(event);
    if (disposition === "ignore") {
      console.log(`Ignoring bot-authored app_mention: ${event.channel}/${event.ts}`);
      return;
    }

    if (seen.isDuplicate(event.channel, event.ts)) {
      console.log(`Ignoring redelivered app_mention: ${event.channel}/${event.ts}`);
      return;
    }

    if (disposition === "unsupported-attachment") {
      await say({
        text: UNSUPPORTED_ATTACHMENT_MESSAGE,
        thread_ts: event.thread_ts ?? event.ts,
        ...NO_UNFURL,
      });
      return;
    }

    const text = normalizeMentionText(event.text);
    if (!text) {
      await say({
        text: EMPTY_MENTION_MESSAGE,
        thread_ts: event.thread_ts ?? event.ts,
        ...NO_UNFURL,
      });
      return;
    }

    await handleIncomingMessage({
      client,
      say: (message) => say(message) as ReturnType<SlackSay>,
      channel: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      text,
      onMessage: config.onMessage,
      messageTs: event.ts,
      ...(botUserId ? { botUserId } : {}),
      ...(event.user ? { userId: event.user } : {}),
    });
  });

  app.event("message", async ({ event, client, say }) => {
    const disposition = classifyDirectMessage(event);
    if (disposition === "ignore") return;

    const dm = event as DirectMessageEvent;
    if (seen.isDuplicate(dm.channel, dm.ts)) {
      console.log(`Ignoring redelivered DM: ${dm.channel}/${dm.ts}`);
      return;
    }

    // A DM with an attachment used to be dropped in total silence. Say so
    // rather than answering from tools as if the file had been read.
    if (disposition === "unsupported-attachment") {
      await say({
        text: UNSUPPORTED_ATTACHMENT_MESSAGE,
        thread_ts: dm.thread_ts ?? dm.ts,
        ...NO_UNFURL,
      });
      return;
    }

    const text = normalizeMentionText(dm.text ?? "");
    if (!text) {
      await say({
        text: EMPTY_MENTION_MESSAGE,
        thread_ts: dm.thread_ts ?? dm.ts,
        ...NO_UNFURL,
      });
      return;
    }

    await handleIncomingMessage({
      client,
      say: (message) => say(message) as ReturnType<SlackSay>,
      channel: dm.channel,
      threadTs: dm.thread_ts ?? dm.ts,
      text,
      onMessage: config.onMessage,
      messageTs: dm.ts,
      ...(botUserId ? { botUserId } : {}),
      ...(dm.user ? { userId: dm.user } : {}),
    });
  });

  await app.start();
  console.log("Bot is running (Socket Mode)");

  return { app, stop: () => app.stop().then(() => undefined) };
}

async function resolveBotUserId(app: {
  client: { auth: { test: () => Promise<{ user_id?: string }> } };
}): Promise<string | undefined> {
  try {
    const auth = await app.client.auth.test();
    return typeof auth.user_id === "string" ? auth.user_id : undefined;
  } catch (error) {
    // Non-fatal: history attribution falls back to the bot_id heuristic.
    console.error("Failed to resolve bot user ID", error);
    return undefined;
  }
}

interface EventDeduper {
  isDuplicate(channel: string, ts: string): boolean;
}

export function createEventDeduper(
  ttlMs: number = DEDUPE_TTL_MS,
  maxEntries: number = DEDUPE_MAX_ENTRIES,
  now: () => number = Date.now
): EventDeduper {
  const seen = new Map<string, number>();

  return {
    isDuplicate(channel: string, ts: string): boolean {
      const key = `${channel}:${ts}`;
      const currentTime = now();

      for (const [seenKey, seenAt] of seen) {
        if (currentTime - seenAt > ttlMs) {
          seen.delete(seenKey);
        } else {
          // Map preserves insertion order, so the rest are newer.
          break;
        }
      }

      if (seen.has(key)) return true;

      seen.set(key, currentTime);
      while (seen.size > maxEntries) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }

      return false;
    },
  };
}

async function getThreadHistory(
  client: SlackHistoryClient,
  channel: string,
  threadTs: string,
  excludeTs: ReadonlySet<string>,
  botUserId?: string
): Promise<HistoryMessage[]> {
  try {
    const messages: ThreadHistoryMessage[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_THREAD_PAGES; page++) {
      const result: ThreadHistoryResult = await client.conversations.replies({
        channel,
        ts: threadTs,
        limit: THREAD_FETCH_LIMIT,
        ...(cursor ? { cursor } : {}),
      });

      messages.push(...(result.messages ?? []));

      cursor = result.response_metadata?.next_cursor || undefined;
      if (!result.has_more || !cursor) {
        return toHistory(messages, excludeTs, botUserId);
      }
    }

    // Only reachable on a thread deeper than MAX_THREAD_PAGES x THREAD_FETCH_LIMIT.
    // We hold the oldest pages, so the recent context the question depends on is
    // missing — say so rather than answering from stale history in silence.
    console.warn(
      `Thread ${channel}/${threadTs} exceeds ${MAX_THREAD_PAGES * THREAD_FETCH_LIMIT} replies; using the oldest portion`
    );
    return toHistory(messages, excludeTs, botUserId);
  } catch (error) {
    console.error("Failed to load thread history", error);
    return [];
  }
}

function toHistory(
  messages: ThreadHistoryMessage[],
  excludeTs: ReadonlySet<string>,
  botUserId?: string
): HistoryMessage[] {
  return messages
    .filter((message) => !message.ts || !excludeTs.has(message.ts))
    .flatMap((message): HistoryMessage[] => {
      const text = normalizeMentionText(message.text ?? "");
      if (!text) return [];

      return [
        { role: isOwnMessage(message, botUserId) ? "assistant" : "user", text },
      ];
    });
}

/**
 * Only *our* replies are the assistant turn. Other bots in the thread are
 * third parties and belong in the user role — attributing their messages to
 * ourselves makes Claude think it said things it never said.
 */
function isOwnMessage(
  message: ThreadHistoryMessage,
  botUserId?: string
): boolean {
  if (botUserId) return message.user === botUserId;
  return Boolean(message.bot_id);
}

export async function handleIncomingMessage(
  input: IncomingMessage
): Promise<void> {
  const { client, say, channel, threadTs, text, onMessage, botUserId } = input;
  const reactionTs = input.messageTs ?? threadTs;
  await addReaction(client, channel, reactionTs, WORKING_REACTION);

  const placeholder = await postPlaceholder(say, threadTs);

  try {
    // The inbound message and our own placeholder are already accounted for —
    // the first as `text`, the second as the reply we're about to fill in.
    const excludeTs = new Set(
      [input.messageTs, placeholder?.ts].filter(
        (value): value is string => typeof value === "string"
      )
    );
    const history = await getThreadHistory(
      client,
      channel,
      threadTs,
      excludeTs,
      botUserId
    );

    const context = {
      channelId: channel,
      threadTs,
      ...(input.userId ? { userId: input.userId } : {}),
    };

    if (!placeholder?.ts) {
      const response = await onMessage({ text, history, context });
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
          ...NO_UNFURL,
        }),
      STREAM_UPDATE_INTERVAL_MS
    );

    const response = await onMessage({
      text,
      history,
      context,
      onTextDelta: (_delta, fullText) => updater.schedule(fullText),
    });

    await updater.cancel();

    const chunks = chunkText(toSlackMrkdwn(response), MAX_CHUNK_SIZE);
    await client.chat.update({
      channel,
      ts: placeholderTs,
      text: chunks[0] ?? "",
      ...NO_UNFURL,
    });
    if (chunks.length > 1) {
      try {
        await sendChunks(say, threadTs, chunks.slice(1));
      } catch (error) {
        // Chunk 1 is already in the placeholder and the user is reading it.
        // Falling through to the outer catch would call sendErrorReply, which
        // overwrites that placeholder — turning a mostly-delivered answer into
        // no answer at all.
        console.error("Failed to post the rest of the reply", error);
        await say({
          text: TRUNCATED_REPLY_MESSAGE,
          thread_ts: threadTs,
          ...NO_UNFURL,
        }).catch(() => undefined);
      }
    }
  } catch (error) {
    console.error("Failed to handle Slack message", error);
    await sendErrorReply(client, say, channel, threadTs, placeholder?.ts);
  } finally {
    await removeReaction(client, channel, reactionTs, WORKING_REACTION);
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
    return await say({ text: PLACEHOLDER_TEXT, thread_ts: threadTs, ...NO_UNFURL });
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
        ...NO_UNFURL,
      });
      return;
    } catch (updateError) {
      console.error("Failed to update placeholder with error", updateError);
    }
  }

  try {
    await say({ text: FALLBACK_ERROR_MESSAGE, thread_ts: threadTs, ...NO_UNFURL });
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

/** `\n```” + “```\n` — the most repairSplitFences can add to one chunk. */
const FENCE_REPAIR_HEADROOM = 8;

export function chunkText(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  // Reserve room for fences we may re-add, so repair can't push a chunk back
  // over the limit we just split to.
  const budget = text.includes("```")
    ? Math.max(1, maxSize - FENCE_REPAIR_HEADROOM)
    : maxSize;

  const chunks: string[] = [];
  let remaining = text;
  const minSplit = Math.floor(budget * 0.5);

  while (remaining.length > budget) {
    let splitAt = remaining.lastIndexOf("\n\n", budget);
    if (splitAt < minSplit) splitAt = remaining.lastIndexOf("\n", budget);
    if (splitAt < minSplit) splitAt = remaining.lastIndexOf(" ", budget);
    if (splitAt < minSplit) splitAt = budget;

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return repairSplitFences(chunks);
}

/**
 * A split can land inside a ``` block, leaving chunk N with an unclosed fence
 * and chunk N+1 opening with an orphaned closer — both render as broken code
 * in Slack. Close the fence at the boundary and reopen it after.
 *
 * Parity is enough here: `format.ts` has already masked and restored fenced
 * regions, so by this point every ``` in the text is a real fence delimiter.
 */
function repairSplitFences(chunks: string[]): string[] {
  let open = false;

  return chunks.map((chunk) => {
    const reopened = open ? "```\n" + chunk : chunk;

    // Count delimiters in the chunk as it will actually be sent.
    const fences = (reopened.match(/```/g) ?? []).length;
    const endsOpen = (fences % 2 === 1) !== false ? fences % 2 === 1 : false;
    const closed = endsOpen ? reopened + "\n```" : reopened;

    open = endsOpen;
    return closed;
  });
}

async function sendChunks(
  say: SlackSay,
  threadTs: string,
  chunks: string[]
): Promise<void> {
  for (const chunk of chunks) {
    await say({ text: chunk, thread_ts: threadTs, ...NO_UNFURL });
  }
}

export function normalizeMentionText(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function isChannelAllowed(
  allowlist: ReadonlySet<string> | undefined,
  channel: string
): boolean {
  return !allowlist || allowlist.has(channel);
}

/**
 * What to do with an inbound message.
 *
 * Both ingress paths classify before acting. They had drifted — DMs filtered
 * bots and refused attachments while mentions did neither — so any new gate
 * belongs in a `classify*` function, never inline in one handler.
 */
export type MessageDisposition =
  | "handle"
  | "unsupported-attachment"
  | "ignore";

/** @deprecated Use MessageDisposition — kept so the rename isn't breaking. */
export type DirectMessageDisposition = MessageDisposition;

/**
 * Slack delivers a DM with an attached file as `subtype: "file_share"`. That
 * used to fall into `ignore`, so someone who DM'd a screenshot got no reply,
 * no log line, and no reaction. It gets an honest answer instead.
 */
export function classifyDirectMessage(event: unknown): MessageDisposition {
  if (!isDirectMessageEvent(event)) return "ignore";
  if (event.bot_id || event.bot_profile) return "ignore";

  if (event.subtype === "file_share") return "unsupported-attachment";
  if (event.subtype) return "ignore";

  return "handle";
}

/**
 * The mention-path twin of `classifyDirectMessage`.
 *
 * Two gaps this closes. Bolt's `ignoreSelf` filters only *our* bot, so a
 * webhook relay or a second copy of this starter whose text contains our
 * handle could drive an unbounded chain of paid turns — and the dedupe can't
 * break it, because every relayed message has a fresh `ts`. And an @-mention
 * carrying a screenshot used to be answered from its caption alone, which is
 * exactly the confident-answer-without-the-data failure the DM path refuses.
 */
export function classifyMention(event: MentionEvent): MessageDisposition {
  if (event.bot_id || event.bot_profile) return "ignore";

  // `files` is the reliable signal on app_mention; `file_share` is a
  // `message`-event convention. Check both.
  if (event.files?.length || event.subtype === "file_share") {
    return "unsupported-attachment";
  }

  return "handle";
}

function isMentionEvent(event: unknown): event is MentionEvent {
  if (!isRecord(event)) {
    return false;
  }

  return (
    typeof event.text === "string" &&
    typeof event.channel === "string" &&
    typeof event.ts === "string" &&
    (event.thread_ts === undefined || typeof event.thread_ts === "string") &&
    (event.user === undefined || typeof event.user === "string")
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
    (event.user === undefined || typeof event.user === "string") &&
    (event.bot_id === undefined || typeof event.bot_id === "string") &&
    (event.bot_profile === undefined || isRecord(event.bot_profile)) &&
    (event.subtype === undefined || typeof event.subtype === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type { OnTextDelta };
