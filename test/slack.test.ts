import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  chunkText,
  createThrottledUpdater,
  handleIncomingMessage,
  isChannelAllowed,
  normalizeMentionText,
  shouldHandleDirectMessage,
  truncateForStream,
} from "../src/slack.js";

test("normalizeMentionText removes bot mentions and extra whitespace", () => {
  assert.equal(
    normalizeMentionText("  <@U12345>   what changed   this week? "),
    "what changed this week?"
  );
});

test("shouldHandleDirectMessage ignores bot and subtype events", () => {
  assert.equal(
    shouldHandleDirectMessage({
      channel_type: "im",
      channel: "D1",
      ts: "123.456",
      text: "hello",
      bot_id: "B1",
    }),
    false
  );

  assert.equal(
    shouldHandleDirectMessage({
      channel_type: "im",
      channel: "D1",
      ts: "123.456",
      text: "hello",
      subtype: "message_changed",
    }),
    false
  );

  assert.equal(
    shouldHandleDirectMessage({
      channel_type: "im",
      channel: "D1",
      ts: "123.456",
      text: "hello",
    }),
    true
  );
});

test("shouldHandleDirectMessage rejects messages with bot_profile even when bot_id is absent", () => {
  assert.equal(
    shouldHandleDirectMessage({
      channel_type: "im",
      channel: "D1",
      ts: "123.456",
      text: "hello",
      bot_profile: { app_id: "A1", name: "OtherBot" },
    }),
    false
  );
});

test("isChannelAllowed returns true when no allowlist is set", () => {
  assert.equal(isChannelAllowed(undefined, "C123"), true);
});

test("isChannelAllowed checks membership when an allowlist is set", () => {
  const allowlist = new Set(["C123", "C456"]);
  assert.equal(isChannelAllowed(allowlist, "C123"), true);
  assert.equal(isChannelAllowed(allowlist, "C999"), false);
});

test("chunkText returns a single chunk when text fits", () => {
  assert.deepEqual(chunkText("hello", 100), ["hello"]);
});

test("chunkText splits on paragraph boundaries when available", () => {
  const para1 = "a".repeat(60);
  const para2 = "b".repeat(60);
  const text = `${para1}\n\n${para2}`;
  const chunks = chunkText(text, 80);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], para1);
  assert.equal(chunks[1], para2);
});

test("chunkText falls back to hard cut when no good boundary exists", () => {
  const text = "a".repeat(250);
  const chunks = chunkText(text, 100);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
});

test("truncateForStream preserves short text and truncates long text with suffix", () => {
  assert.equal(truncateForStream("short"), "short");

  const long = "x".repeat(5_000);
  const truncated = truncateForStream(long);
  assert.ok(truncated.length <= 3_500);
  assert.ok(truncated.endsWith("(continuing)_"));
});

function makeChatClient(overrides?: {
  replies?: () => Promise<{ messages: Array<{ text?: string }> }>;
}) {
  const updates: string[] = [];
  const reactions: string[] = [];
  const client = {
    conversations: {
      replies:
        overrides?.replies ?? (async () => ({ messages: [] as Array<{ text?: string }> })),
    },
    chat: {
      update: async ({ text }: { text: string }) => {
        updates.push(text);
      },
    },
    reactions: {
      add: async ({ name }: { name: string }) => {
        reactions.push(`+${name}`);
      },
      remove: async ({ name }: { name: string }) => {
        reactions.push(`-${name}`);
      },
    },
  };
  return { client, updates, reactions };
}

test("handleIncomingMessage posts placeholder and flushes the final response", async () => {
  const { client, updates, reactions } = makeChatClient();
  const sent: Array<{ text: string; thread_ts: string }> = [];

  await handleIncomingMessage(
    client,
    async (message) => {
      sent.push(message);
      return { ts: "T1" };
    },
    "C1",
    "100.000",
    "hello",
    async () => "response",
    "100.001"
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, "…");
  assert.equal(updates.at(-1), "response");
  assert.deepEqual(reactions, ["+eyes", "-eyes"]);
});

test("handleIncomingMessage streams deltas through chat.update", async () => {
  const { client, updates, reactions } = makeChatClient();

  await handleIncomingMessage(
    client,
    async () => ({ ts: "T1" }),
    "C1",
    "100.000",
    "hello",
    async (_text, _history, onTextDelta) => {
      onTextDelta?.("hi ", "hi ");
      onTextDelta?.("there", "hi there");
      return "hi there";
    },
    "100.001"
  );

  assert.ok(updates.includes("hi there"));
  assert.equal(updates.at(-1), "hi there");
  assert.deepEqual(reactions, ["+eyes", "-eyes"]);
});

test("handleIncomingMessage updates placeholder with error message on failure", async () => {
  const { client, updates, reactions } = makeChatClient({
    replies: async () => ({ messages: [{ text: "user: prior" }] }),
  });
  const sent: Array<{ text: string; thread_ts: string }> = [];
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await handleIncomingMessage(
      client,
      async (message) => {
        sent.push(message);
        return { ts: "T1" };
      },
      "C1",
      "100.000",
      "hello",
      async () => {
        throw new Error("boom");
      },
      "100.001"
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, "…");
  assert.ok(
    updates.some((text) => /hit an error/i.test(text)),
    `expected error update, got: ${JSON.stringify(updates)}`
  );
  assert.deepEqual(reactions, ["+eyes", "-eyes"]);
});

test("handleIncomingMessage falls back to non-streaming say() when placeholder post fails", async () => {
  const { client, updates, reactions } = makeChatClient();
  const sent: Array<{ text: string; thread_ts: string }> = [];
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await handleIncomingMessage(
      client,
      async (message) => {
        sent.push(message);
        return undefined;
      },
      "C1",
      "100.000",
      "hello",
      async () => "response"
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(
    sent.map((m) => m.text),
    ["…", "response"]
  );
  assert.equal(updates.length, 0);
  assert.deepEqual(reactions, ["+eyes", "-eyes"]);
});

test("createThrottledUpdater fires the first call immediately and coalesces bursts", async () => {
  const calls: string[] = [];
  const updater = createThrottledUpdater(async (text) => {
    calls.push(text);
  }, 50);

  updater.schedule("a");
  updater.schedule("ab");
  updater.schedule("abc");

  await delay(10);
  assert.deepEqual(calls, ["a"]);

  await delay(80);
  assert.deepEqual(calls, ["a", "abc"]);
});

test("createThrottledUpdater cancel drops pending updates and awaits in-flight", async () => {
  const calls: string[] = [];
  const updater = createThrottledUpdater(async (text) => {
    calls.push(text);
  }, 1_000);

  updater.schedule("first");
  updater.schedule("second");
  await updater.cancel();

  assert.deepEqual(calls, ["first"]);
});

test("createThrottledUpdater deduplicates consecutive identical text", async () => {
  const calls: string[] = [];
  const updater = createThrottledUpdater(async (text) => {
    calls.push(text);
  }, 50);

  updater.schedule("same");
  await delay(80);
  updater.schedule("same");
  await delay(80);

  assert.deepEqual(calls, ["same"]);
});

test("handleIncomingMessage chunks long responses across multiple messages", async () => {
  const { client, updates, reactions } = makeChatClient();
  const sent: Array<{ text: string; thread_ts: string }> = [];
  const longResponse = `${"para1 ".repeat(700).trim()}\n\n${"para2 ".repeat(700).trim()}`;

  await handleIncomingMessage(
    client,
    async (message) => {
      sent.push(message);
      return { ts: "T1" };
    },
    "C1",
    "100.000",
    "hello",
    async () => longResponse,
    "100.001"
  );

  // Placeholder posted via say(); chunk[0] via chat.update; chunk[1..] via say().
  assert.equal(sent[0]?.text, "…");
  assert.ok(sent.length > 1, "expected at least one follow-up message");
  assert.ok(updates.length >= 1, "expected at least one chat.update for chunk[0]");
  assert.ok(
    updates.every((text) => text.length <= 3_500),
    `chat.update payloads exceeded chunk limit: ${updates.map((t) => t.length).join(", ")}`
  );
  assert.ok(
    sent.slice(1).every((message) => message.text.length <= 3_500),
    `follow-up say() payloads exceeded chunk limit: ${sent
      .slice(1)
      .map((m) => m.text.length)
      .join(", ")}`
  );
  assert.deepEqual(reactions, ["+eyes", "-eyes"]);
});

