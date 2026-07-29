import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { AgentRequest, HistoryMessage, ToolContext } from "../src/agent.js";
import {
  chunkText,
  classifyDirectMessage,
  createEventDeduper,
  createThrottledUpdater,
  handleIncomingMessage,
  isChannelAllowed,
  MAX_CHUNK_SIZE,
  MAX_THREAD_PAGES,
  normalizeMentionText,
  truncateForStream,
  WORKING_REACTION,
  type IncomingMessage,
} from "../src/slack.js";

test("normalizeMentionText removes bot mentions and extra whitespace", () => {
  assert.equal(
    normalizeMentionText("  <@U12345>   what changed   this week? "),
    "what changed this week?"
  );
});

test("classifyDirectMessage handles, ignores, or flags attachments", () => {
  const base = { channel_type: "im", channel: "D1", ts: "123.456", text: "hello" };

  assert.equal(classifyDirectMessage({ ...base }), "handle");
  assert.equal(classifyDirectMessage({ ...base, bot_id: "B1" }), "ignore");
  assert.equal(
    classifyDirectMessage({ ...base, bot_profile: { app_id: "A1" } }),
    "ignore"
  );
  assert.equal(classifyDirectMessage({ ...base, subtype: "message_changed" }), "ignore");
  assert.equal(classifyDirectMessage({ channel_type: "channel", channel: "C1", ts: "1" }), "ignore");

  // Previously fell into "ignore", so a DM'd screenshot got total silence.
  assert.equal(classifyDirectMessage({ ...base, subtype: "file_share" }), "unsupported-attachment");
  // ...but a bot's file_share is still ignored.
  assert.equal(
    classifyDirectMessage({ ...base, subtype: "file_share", bot_id: "B1" }),
    "ignore"
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
  const chunks = chunkText(`${para1}\n\n${para2}`, 80);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], para1);
  assert.equal(chunks[1], para2);
});

test("chunkText falls back to hard cut when no good boundary exists", () => {
  const chunks = chunkText("a".repeat(250), 100);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
});

test("truncateForStream preserves short text and truncates long text with suffix", () => {
  assert.equal(truncateForStream("short"), "short");

  const truncated = truncateForStream("x".repeat(5_000));
  assert.ok(truncated.length <= MAX_CHUNK_SIZE);
  assert.ok(truncated.endsWith("(continuing)_"));
});

interface MockReplyMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
}

function makeChatClient(overrides?: {
  replies?: () => Promise<{ messages: MockReplyMessage[] }>;
}) {
  const updates: string[] = [];
  const reactions: string[] = [];
  const client = {
    conversations: {
      replies:
        overrides?.replies ?? (async () => ({ messages: [] as MockReplyMessage[] })),
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

/** Fills in the boilerplate so each test only states what it cares about. */
function makeInput(
  overrides: Partial<IncomingMessage> &
    Pick<IncomingMessage, "client" | "say" | "onMessage">
): IncomingMessage {
  return {
    channel: "C1",
    threadTs: "100.000",
    text: "hello",
    messageTs: "100.001",
    ...overrides,
  };
}

test("handleIncomingMessage posts placeholder and flushes the final response", async () => {
  const { client, updates, reactions } = makeChatClient();
  const sent: Array<{ text: string; thread_ts: string }> = [];

  await handleIncomingMessage(
    makeInput({
      client,
      say: async (message) => {
        sent.push(message);
        return { ts: "T1" };
      },
      onMessage: async () => "response",
    })
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, "…");
  assert.equal(updates.at(-1), "response");
  assert.deepEqual(reactions, [`+${WORKING_REACTION}`, `-${WORKING_REACTION}`]);
});

test("handleIncomingMessage streams deltas through chat.update", async () => {
  const { client, updates } = makeChatClient();

  await handleIncomingMessage(
    makeInput({
      client,
      say: async () => ({ ts: "T1" }),
      onMessage: async ({ onTextDelta }) => {
        onTextDelta?.("hi ", "hi ");
        onTextDelta?.("there", "hi there");
        return "hi there";
      },
    })
  );

  assert.ok(updates.includes("hi there"));
  assert.equal(updates.at(-1), "hi there");
});

test("handleIncomingMessage builds the tool context from the Slack event", async () => {
  const { client } = makeChatClient();
  let context: ToolContext | undefined;

  await handleIncomingMessage(
    makeInput({
      client,
      channel: "C_SUPPORT",
      threadTs: "555.000",
      userId: "U_ALICE",
      say: async () => ({ ts: "T1" }),
      onMessage: async (request) => {
        context = request.context;
        return "ok";
      },
    })
  );

  assert.deepEqual(context, {
    channelId: "C_SUPPORT",
    threadTs: "555.000",
    userId: "U_ALICE",
  });
});

test("handleIncomingMessage omits userId when Slack didn't supply one", async () => {
  const { client } = makeChatClient();
  let context: ToolContext | undefined;

  await handleIncomingMessage(
    makeInput({
      client,
      say: async () => ({ ts: "T1" }),
      onMessage: async (request) => {
        context = request.context;
        return "ok";
      },
    })
  );

  assert.equal(context?.userId, undefined);
  assert.ok(!("userId" in (context ?? {})), "userId should be absent, not undefined");
});

test("handleIncomingMessage excludes the inbound message and placeholder from history", async () => {
  // conversations.replies is fetched after the placeholder is posted, so the
  // raw payload contains both the question we're answering and our own "…".
  const { client } = makeChatClient({
    replies: async () => ({
      messages: [
        { ts: "099.000", user: "U_HUMAN", text: "earlier question" },
        { ts: "099.500", user: "U_BOT", bot_id: "B1", text: "earlier answer" },
        { ts: "100.001", user: "U_HUMAN", text: "hello" },
        { ts: "T1", user: "U_BOT", bot_id: "B1", text: "…" },
      ],
    }),
  });

  let history: HistoryMessage[] = [];
  await handleIncomingMessage(
    makeInput({
      client,
      say: async () => ({ ts: "T1" }),
      botUserId: "U_BOT",
      onMessage: async (request) => {
        history = request.history;
        return "response";
      },
    })
  );

  assert.deepEqual(history, [
    { role: "user", text: "earlier question" },
    { role: "assistant", text: "earlier answer" },
  ]);
});

test("handleIncomingMessage attributes only our own messages as assistant", async () => {
  const { client } = makeChatClient({
    replies: async () => ({
      messages: [
        { ts: "099.000", user: "U_HUMAN", text: "human says" },
        { ts: "099.100", user: "U_BOT", bot_id: "B1", text: "we say" },
        // A different bot in the channel must not be mistaken for us.
        { ts: "099.200", user: "U_OTHERBOT", bot_id: "B2", text: "other bot says" },
      ],
    }),
  });

  let history: HistoryMessage[] = [];
  await handleIncomingMessage(
    makeInput({
      client,
      say: async () => ({ ts: "T1" }),
      botUserId: "U_BOT",
      onMessage: async (request) => {
        history = request.history;
        return "response";
      },
    })
  );

  assert.deepEqual(history, [
    { role: "user", text: "human says" },
    { role: "assistant", text: "we say" },
    { role: "user", text: "other bot says" },
  ]);
});

test("handleIncomingMessage returns history newest-last so the agent keeps the recent tail", async () => {
  const messages = Array.from({ length: 40 }, (_value, index) => ({
    ts: `0${index}.000`,
    user: "U_HUMAN",
    text: `message ${index}`,
  }));
  const { client } = makeChatClient({ replies: async () => ({ messages }) });

  let history: HistoryMessage[] = [];
  await handleIncomingMessage(
    makeInput({
      client,
      say: async () => ({ ts: "T1" }),
      botUserId: "U_BOT",
      onMessage: async (request) => {
        history = request.history;
        return "response";
      },
    })
  );

  // slack.ts no longer imposes its own cap — agent.ts owns the trim, so the
  // ordering is what matters here.
  assert.equal(history.at(-1)?.text, "message 39");
  assert.equal(history[0]?.text, "message 0");
});

test("handleIncomingMessage follows the reply cursor to reach the newest messages", async () => {
  // conversations.replies pages oldest-first, so the messages the question
  // actually depends on are on the LAST page. A single fetch would return
  // page 1 and miss them entirely.
  const pages = [
    {
      messages: [{ ts: "001", user: "U_HUMAN", text: "oldest" }],
      has_more: true,
      response_metadata: { next_cursor: "cur-2" },
    },
    {
      messages: [{ ts: "002", user: "U_HUMAN", text: "middle" }],
      has_more: true,
      response_metadata: { next_cursor: "cur-3" },
    },
    {
      messages: [{ ts: "003", user: "U_HUMAN", text: "newest" }],
      has_more: false,
    },
  ];
  const cursors: Array<string | undefined> = [];

  const client = {
    conversations: {
      replies: async (params: { cursor?: string }) => {
        cursors.push(params.cursor);
        return pages[cursors.length - 1] ?? { messages: [] };
      },
    },
    chat: { update: async () => {} },
    reactions: { add: async () => {}, remove: async () => {} },
  };

  let history: HistoryMessage[] = [];
  await handleIncomingMessage(
    makeInput({
      client,
      say: async () => ({ ts: "T1" }),
      botUserId: "U_BOT",
      onMessage: async (request) => {
        history = request.history;
        return "response";
      },
    })
  );

  assert.deepEqual(cursors, [undefined, "cur-2", "cur-3"]);
  assert.deepEqual(
    history.map((m) => m.text),
    ["oldest", "middle", "newest"]
  );
});

test("handleIncomingMessage stops paging when the thread has no more pages", async () => {
  let calls = 0;
  const client = {
    conversations: {
      replies: async () => {
        calls += 1;
        return {
          messages: [{ ts: "001", user: "U_HUMAN", text: "only" }],
          has_more: false,
          response_metadata: { next_cursor: "" },
        };
      },
    },
    chat: { update: async () => {} },
    reactions: { add: async () => {}, remove: async () => {} },
  };

  await handleIncomingMessage(
    makeInput({
      client,
      say: async () => ({ ts: "T1" }),
      onMessage: async () => "response",
    })
  );

  assert.equal(calls, 1, "an empty next_cursor must not trigger another page");
});

test("handleIncomingMessage bounds paging on a pathological thread", async () => {
  let calls = 0;
  const client = {
    conversations: {
      replies: async () => {
        calls += 1;
        // Never stops advertising more pages.
        return {
          messages: [{ ts: `t${calls}`, user: "U_HUMAN", text: `m${calls}` }],
          has_more: true,
          response_metadata: { next_cursor: `cur-${calls}` },
        };
      },
    },
    chat: { update: async () => {} },
    reactions: { add: async () => {}, remove: async () => {} },
  };

  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: unknown) => {
    warnings.push(String(message));
  };

  try {
    await handleIncomingMessage(
      makeInput({
        client,
        say: async () => ({ ts: "T1" }),
        onMessage: async () => "response",
      })
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(calls, MAX_THREAD_PAGES);
  assert.ok(
    warnings.some((w) => /exceeds/.test(w)),
    "truncated history should be logged, not silent"
  );
});

test("handleIncomingMessage strips mentions from thread history", async () => {
  const { client } = makeChatClient({
    replies: async () => ({
      messages: [{ ts: "099.000", user: "U_HUMAN", text: "<@U12345> what's new?" }],
    }),
  });

  let history: HistoryMessage[] = [];
  await handleIncomingMessage(
    makeInput({
      client,
      say: async () => ({ ts: "T1" }),
      botUserId: "U_BOT",
      onMessage: async (request) => {
        history = request.history;
        return "response";
      },
    })
  );

  assert.deepEqual(history, [{ role: "user", text: "what's new?" }]);
});

test("handleIncomingMessage updates placeholder with error message on failure", async () => {
  const { client, updates, reactions } = makeChatClient({
    replies: async () => ({ messages: [{ ts: "099.000", text: "prior" }] }),
  });
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await handleIncomingMessage(
      makeInput({
        client,
        say: async () => ({ ts: "T1" }),
        onMessage: async () => {
          throw new Error("boom");
        },
      })
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.ok(
    updates.some((text) => /hit an error/i.test(text)),
    `expected error update, got: ${JSON.stringify(updates)}`
  );
  // The working reaction is always cleaned up, even on failure.
  assert.deepEqual(reactions, [`+${WORKING_REACTION}`, `-${WORKING_REACTION}`]);
});

test("handleIncomingMessage falls back to non-streaming say() when placeholder post fails", async () => {
  const { client, updates, reactions } = makeChatClient();
  const sent: Array<{ text: string; thread_ts: string }> = [];
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    // No messageTs at all — the reaction falls back to threadTs.
    await handleIncomingMessage({
      client,
      channel: "C1",
      threadTs: "100.000",
      text: "hello",
      say: async (message) => {
        sent.push(message);
        return undefined;
      },
      onMessage: async () => "response",
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(sent.map((m) => m.text), ["…", "response"]);
  assert.equal(updates.length, 0);
  assert.deepEqual(reactions, [`+${WORKING_REACTION}`, `-${WORKING_REACTION}`]);
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

test("createEventDeduper reports a repeated channel/ts pair as duplicate", () => {
  const seen = createEventDeduper();

  assert.equal(seen.isDuplicate("C1", "100.000"), false);
  assert.equal(seen.isDuplicate("C1", "100.000"), true);
  // Same ts in a different channel is a different event.
  assert.equal(seen.isDuplicate("C2", "100.000"), false);
  assert.equal(seen.isDuplicate("C1", "100.001"), false);
});

test("createEventDeduper forgets entries older than the TTL", () => {
  let now = 0;
  const seen = createEventDeduper(1_000, 100, () => now);

  assert.equal(seen.isDuplicate("C1", "100.000"), false);
  now = 500;
  assert.equal(seen.isDuplicate("C1", "100.000"), true);

  now = 2_000;
  assert.equal(seen.isDuplicate("C1", "100.000"), false);
});

test("createEventDeduper bounds how many entries it retains", () => {
  const seen = createEventDeduper(60_000, 2);

  seen.isDuplicate("C1", "1");
  seen.isDuplicate("C1", "2");
  seen.isDuplicate("C1", "3");

  // "1" was evicted to stay within the cap, so it reads as new again.
  assert.equal(seen.isDuplicate("C1", "1"), false);
  assert.equal(seen.isDuplicate("C1", "3"), true);
});

test("handleIncomingMessage disables link unfurling on every outbound message", async () => {
  const updateCalls: Array<{
    text: string;
    unfurl_links?: boolean;
    unfurl_media?: boolean;
  }> = [];
  const client = {
    conversations: { replies: async () => ({ messages: [] as MockReplyMessage[] }) },
    chat: {
      update: async (params: {
        text: string;
        unfurl_links?: boolean;
        unfurl_media?: boolean;
      }) => {
        updateCalls.push(params);
      },
    },
    reactions: { add: async () => {}, remove: async () => {} },
  };

  const sayCalls: Array<{
    text: string;
    unfurl_links?: boolean;
    unfurl_media?: boolean;
  }> = [];

  await handleIncomingMessage(
    makeInput({
      client,
      say: async (message) => {
        sayCalls.push(message);
        return { ts: "T1" };
      },
      onMessage: async () => "answer with a link https://example.com",
    })
  );

  for (const call of sayCalls) {
    assert.equal(call.unfurl_links, false, "say() unfurl_links should be false");
    assert.equal(call.unfurl_media, false, "say() unfurl_media should be false");
  }
  for (const call of updateCalls) {
    assert.equal(call.unfurl_links, false, "chat.update unfurl_links should be false");
    assert.equal(call.unfurl_media, false, "chat.update unfurl_media should be false");
  }
  assert.ok(sayCalls.length > 0 && updateCalls.length > 0, "both paths must have been exercised");
});

test("handleIncomingMessage chunks long responses across multiple messages", async () => {
  const { client, updates, reactions } = makeChatClient();
  const sent: Array<{ text: string; thread_ts: string }> = [];
  const longResponse = `${"para1 ".repeat(700).trim()}\n\n${"para2 ".repeat(700).trim()}`;

  await handleIncomingMessage(
    makeInput({
      client,
      say: async (message) => {
        sent.push(message);
        return { ts: "T1" };
      },
      onMessage: async () => longResponse,
    })
  );

  // Placeholder posted via say(); chunk[0] via chat.update; chunk[1..] via say().
  assert.equal(sent[0]?.text, "…");
  assert.ok(sent.length > 1, "expected at least one follow-up message");
  assert.ok(updates.length >= 1, "expected at least one chat.update for chunk[0]");
  assert.ok(
    updates.every((text) => text.length <= MAX_CHUNK_SIZE),
    `chat.update payloads exceeded chunk limit: ${updates.map((t) => t.length).join(", ")}`
  );
  assert.ok(
    sent.slice(1).every((message) => message.text.length <= MAX_CHUNK_SIZE),
    `follow-up say() payloads exceeded chunk limit`
  );
  assert.deepEqual(reactions, [`+${WORKING_REACTION}`, `-${WORKING_REACTION}`]);
});

test("the onMessage contract matches AgentRequest", async () => {
  // Compile-time guard: slack.ts must keep speaking agent.ts's request shape.
  const { client } = makeChatClient();
  const received: AgentRequest[] = [];

  await handleIncomingMessage(
    makeInput({
      client,
      say: async () => ({ ts: "T1" }),
      onMessage: async (request: AgentRequest) => {
        received.push(request);
        return "ok";
      },
    })
  );

  assert.equal(received.length, 1);
  assert.equal(received[0]?.text, "hello");
  assert.ok(Array.isArray(received[0]?.history));
  assert.equal(typeof received[0]?.context.channelId, "string");
});
