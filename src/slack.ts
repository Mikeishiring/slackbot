/**
 * Slack connection — Socket Mode.
 *
 * Receives messages, fetches thread history, passes to agent,
 * posts response in thread. Nothing else.
 */

import pkg from "@slack/bolt";
const { App } = pkg;

const FALLBACK_ERROR_MESSAGE =
  "I hit an error while processing that message. Please try again.";
const THREAD_HISTORY_LIMIT = 20;

interface SlackConfig {
  botToken: string;
  appToken: string;
  onMessage: (text: string, threadHistory: string[]) => Promise<string>;
}

interface ThreadHistoryMessage {
  bot_id?: string;
  text?: string;
}

interface ThreadHistoryResult {
  messages?: ThreadHistoryMessage[];
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

export interface SlackHistoryClient extends SlackReactionsClient {
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
  subtype?: string;
}

export type SlackSay = (message: {
  text: string;
  thread_ts: string;
}) => Promise<unknown>;

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

    const text = normalizeMentionText(event.text);
    if (!text) return;

    await handleIncomingMessage(
      client,
      (message) => say(message),
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
      (message) => say(message),
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

  try {
    const threadHistory = await getThreadHistory(client, channel, threadTs);
    const response = await onMessage(text, threadHistory);
    await say({ text: response, thread_ts: threadTs });
  } catch (error) {
    console.error("Failed to handle Slack message", error);

    try {
      await say({ text: FALLBACK_ERROR_MESSAGE, thread_ts: threadTs });
    } catch (replyError) {
      console.error("Failed to send Slack error message", replyError);
    }
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

export function normalizeMentionText(text: string): string {
  return normalizeInboundText(text.replace(/<@[A-Z0-9]+>/g, " "));
}

export function shouldHandleDirectMessage(
  event: unknown
): event is DirectMessageEvent {
  return isDirectMessageEvent(event) && !event.bot_id && !event.subtype;
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
    (event.subtype === undefined || typeof event.subtype === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
