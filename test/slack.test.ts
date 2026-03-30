import assert from "node:assert/strict";
import test from "node:test";

import {
  handleIncomingMessage,
  normalizeMentionText,
  shouldHandleDirectMessage,
} from "../src/slack.js";

test("normalizeMentionText removes bot mentions and extra whitespace", () => {
  assert.equal(
    normalizeMentionText("  <@U12345>   what changed   this week? "),
    "what changed this week?"
  );
});

test("normalizeMentionText handles multiple mentions", () => {
  assert.equal(
    normalizeMentionText("<@U111> <@U222> hello there"),
    "hello there"
  );
});

test("normalizeMentionText returns empty string for mention-only messages", () => {
  assert.equal(normalizeMentionText("<@U12345>"), "");
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

test("shouldHandleDirectMessage rejects non-im channel types", () => {
  assert.equal(
    shouldHandleDirectMessage({
      channel_type: "channel",
      channel: "C1",
      ts: "123.456",
      text: "hello",
    }),
    false
  );
});

test("shouldHandleDirectMessage rejects malformed events", () => {
  assert.equal(shouldHandleDirectMessage(null), false);
  assert.equal(shouldHandleDirectMessage(undefined), false);
  assert.equal(shouldHandleDirectMessage("string"), false);
  assert.equal(shouldHandleDirectMessage({ channel_type: "im" }), false);
});

test("handleIncomingMessage sends a fallback reply when processing fails", async () => {
  const sent: Array<{ text: string; thread_ts: string }> = [];
  const client = {
    conversations: {
      replies: async () => ({
        messages: [{ text: "user: prior message" }],
      }),
    },
  };
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await handleIncomingMessage(
      client,
      async (message) => {
        sent.push(message);
      },
      "D1",
      "123.456",
      "hello",
      async () => {
        throw new Error("boom");
      }
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(sent, [
    {
      text: "I hit an error while processing that message. Please try again.",
      thread_ts: "123.456",
    },
  ]);
});

test("handleIncomingMessage sends successful response in thread", async () => {
  const sent: Array<{ text: string; thread_ts: string }> = [];
  const client = {
    conversations: {
      replies: async () => ({ messages: [] }),
    },
  };

  await handleIncomingMessage(
    client,
    async (message) => {
      sent.push(message);
    },
    "C1",
    "999.000",
    "what's new?",
    async (text, history) => {
      assert.equal(text, "what's new?");
      assert.ok(Array.isArray(history));
      return "Here's what's new!";
    }
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, "Here's what's new!");
  assert.equal(sent[0]?.thread_ts, "999.000");
});
