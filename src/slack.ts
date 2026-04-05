import pkg from "@slack/bolt";
const { App } = pkg;

const FALLBACK_ERROR_MESSAGE =
  "I hit an error while processing that message. Please try again.";
const THREAD_HISTORY_LIMIT = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 5;

class RateLimiter {
  private readonly requests = new Map<string, number[]>();

  public isAllowed(userId: string): boolean {
    const now = Date.now();
    const window = this.requests.get(userId) ?? [];
    const recent = window.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
      this.requests.set(userId, recent);
      return false;
    }

    recent.push(now);
    this.requests.set(userId, recent);

    if (this.requests.size > 1_000) {
      this.prune(now);
    }

    return true;
  }

  private prune(now: number): void {
    for (const [userId, timestamps] of this.requests) {
      const active = timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
      if (active.length === 0) {
        this.requests.delete(userId);
      } else {
        this.requests.set(userId, active);
      }
    }
  }
}

export interface SlackIncomingRequest {
  text: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  actorId: string | null;
  actorLabel: string | null;
  threadHistory: string[];
}

interface SlackConfig {
  botToken: string;
  appToken: string;
  onMessage: (request: SlackIncomingRequest) => Promise<string>;
}

interface ThreadHistoryMessage {
  user?: string;
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
  user?: string;
  thread_ts?: string;
}

export interface DirectMessageEvent {
  channel_type: "im";
  channel: string;
  ts: string;
  user?: string;
  thread_ts?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
}

export type SlackSay = (message: {
  text: string;
  thread_ts: string;
}) => Promise<unknown>;

export interface SlackBotHandle {
  postMessage: (channel: string, threadTs: string, text: string) => Promise<void>;
}

export async function startSlackBot(config: SlackConfig): Promise<SlackBotHandle> {
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
  });
  const rateLimiter = new RateLimiter();

  app.event("app_mention", async ({ event, client, say }) => {
    if (!isMentionEvent(event)) {
      console.error("Received malformed app_mention event", event);
      return;
    }

    if (event.user && !rateLimiter.isAllowed(event.user)) {
      await say({ text: "Slow down -- you're sending messages too quickly. Try again in a minute.", thread_ts: event.thread_ts ?? event.ts });
      return;
    }

    const text = normalizeMentionText(event.text);
    if (!text) {
      return;
    }

    await handleIncomingMessage(
      client,
      (message) => say(message),
      {
        channelId: event.channel,
        threadTs: event.thread_ts ?? event.ts,
        messageTs: event.ts,
        text,
        actorId: event.user ?? null,
        actorLabel: event.user ?? null,
      },
      config.onMessage
    );
  });

  app.event("message", async ({ event, client, say }) => {
    if (!shouldHandleDirectMessage(event)) {
      return;
    }

    if (event.user && !rateLimiter.isAllowed(event.user)) {
      await say({ text: "Slow down -- you're sending messages too quickly. Try again in a minute.", thread_ts: event.thread_ts ?? event.ts });
      return;
    }

    const text = normalizeInboundText(event.text ?? "");
    if (!text) {
      return;
    }

    await handleIncomingMessage(
      client,
      (message) => say(message),
      {
        channelId: event.channel,
        threadTs: event.thread_ts ?? event.ts,
        messageTs: event.ts,
        text,
        actorId: event.user ?? null,
        actorLabel: event.user ?? null,
      },
      config.onMessage
    );
  });

  await app.start();
  console.log("Bot is running (Socket Mode)");

  return {
    postMessage: async (channel, threadTs, text) => {
      try {
        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text,
        });
      } catch {
        // Non-critical notification failure.
      }
    },
  };
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
  message: Omit<SlackIncomingRequest, "threadHistory">,
  onMessage: SlackConfig["onMessage"]
): Promise<void> {
  await addReaction(client, message.channelId, message.messageTs, "eyes");

  try {
    const threadHistory = await getThreadHistory(
      client,
      message.channelId,
      message.threadTs
    );
    const response = await onMessage({
      ...message,
      threadHistory,
    });
    await say({ text: response, thread_ts: message.threadTs });
  } catch (error) {
    console.error("Failed to handle Slack message", error);
    try {
      await say({ text: FALLBACK_ERROR_MESSAGE, thread_ts: message.threadTs });
    } catch (replyError) {
      console.error("Failed to send Slack error message", replyError);
    }
  } finally {
    await removeReaction(client, message.channelId, message.messageTs, "eyes");
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
    // Non-critical.
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
    // Non-critical.
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
    (event.user === undefined || typeof event.user === "string") &&
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
    (event.user === undefined || typeof event.user === "string") &&
    (event.thread_ts === undefined || typeof event.thread_ts === "string") &&
    (event.text === undefined || typeof event.text === "string") &&
    (event.bot_id === undefined || typeof event.bot_id === "string") &&
    (event.subtype === undefined || typeof event.subtype === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
