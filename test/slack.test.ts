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
      user: "U1",
    }),
    true
  );
});

const mockReactions = () => ({
  add: async () => {},
  remove: async () => {},
});

test("handleIncomingMessage sends structured request to the controller", async () => {
  const sent: Array<{ text: string; thread_ts: string }> = [];
  const client = {
    conversations: {
      replies: async () => ({
        messages: [{ text: "older question" }, { bot_id: "B1", text: "ignored newest" }],
      }),
    },
    reactions: mockReactions(),
  };

  await handleIncomingMessage(
    client,
    async (message) => {
      sent.push(message);
    },
    {
      channelId: "C1",
      threadTs: "123.000",
      messageTs: "123.001",
      text: "status",
      actorId: "U1",
      actorLabel: "U1",
    },
    async (request) => {
      assert.equal(request.text, "status");
      assert.equal(request.channelId, "C1");
      assert.equal(request.threadTs, "123.000");
      assert.deepEqual(request.threadHistory, ["user: older question"]);
      return "Case summary";
    }
  );

  assert.deepEqual(sent, [{ text: "Case summary", thread_ts: "123.000" }]);
});

test("handleIncomingMessage falls back when the controller throws", async () => {
  const sent: Array<{ text: string; thread_ts: string }> = [];
  const client = {
    conversations: {
      replies: async () => ({ messages: [] }),
    },
    reactions: mockReactions(),
  };
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await handleIncomingMessage(
      client,
      async (message) => {
        sent.push(message);
      },
      {
        channelId: "C1",
        threadTs: "999.000",
        messageTs: "999.001",
        text: "status",
        actorId: "U1",
        actorLabel: "U1",
      },
      async () => {
        throw new Error("boom");
      }
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(sent[0]?.thread_ts, "999.000");
  assert.match(String(sent[0]?.text), /try again/i);
});
