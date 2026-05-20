import assert from "node:assert/strict";
import test from "node:test";

import type Anthropic from "@anthropic-ai/sdk";
import { buildMessages, runConversation } from "../src/agent.js";

interface MockStream {
  on(event: "text", cb: (delta: string) => void): MockStream;
  finalMessage(): Promise<Record<string, unknown>>;
}

function makeStream(
  message: Record<string, unknown>,
  textChunks: string[] = []
): MockStream {
  const handlers: Array<(delta: string) => void> = [];
  return {
    on(event, cb) {
      if (event === "text") handlers.push(cb);
      return this;
    },
    async finalMessage() {
      for (const chunk of textChunks) {
        for (const handler of handlers) handler(chunk);
      }
      return message;
    },
  };
}

function makeErroringStream(error: Error): MockStream {
  return {
    on() {
      return this;
    },
    async finalMessage() {
      throw error;
    },
  };
}

test("buildMessages preserves thread roles and appends the latest user input", () => {
  const messages = buildMessages(
    ["user: first question", "assistant: first answer"],
    "follow-up"
  );

  assert.deepEqual(messages, [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "follow-up" },
  ]);
});

test("buildMessages trims history to the most recent messages", () => {
  const history = Array.from({ length: 20 }, (_value, index) => `user: item ${index}`);
  const messages = buildMessages(history, "latest");

  assert.equal(messages.length, 13);
  assert.deepEqual(messages[0], { role: "user", content: "item 8" });
  assert.deepEqual(messages.at(-1), { role: "user", content: "latest" });
});

test("runConversation executes tool calls and joins final text blocks", async () => {
  const streamCalls: Array<Record<string, unknown>> = [];
  const responses = [
    makeStream({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "search_items",
          input: { query: "roadmap" },
        },
      ],
    }),
    makeStream({
      stop_reason: "end_turn",
      content: [
        { type: "text", text: "*3 items this week*" },
        { type: "text", text: "- Q1 roadmap update" },
      ],
    }),
  ];

  const client = {
    messages: {
      stream: (params: Record<string, unknown>) => {
        streamCalls.push(params);
        const next = responses.shift();
        if (!next) throw new Error("Unexpected extra model call");
        return next;
      },
    },
  } as unknown as Anthropic;

  const output = await runConversation(
    client,
    "test-model",
    [],
    async (name, input) => ({ ok: true, name, input }),
    buildMessages([], "what changed this week?")
  );

  assert.equal(output, "*3 items this week*\n\n- Q1 roadmap update");
  assert.equal(streamCalls.length, 2);

  const secondRequest = streamCalls[1];
  assert.ok(secondRequest);
  const secondRequestMessages = secondRequest["messages"] as Array<Record<string, unknown>>;
  const lastMessage = secondRequestMessages.at(-1);

  assert.equal(lastMessage?.["role"], "user");
  assert.match(JSON.stringify(lastMessage), /tool_result/);
});

test("runConversation streams text deltas via the onTextDelta callback", async () => {
  const stream = makeStream(
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "hello world" }],
    },
    ["hello ", "world"]
  );

  const client = {
    messages: {
      stream: () => stream,
    },
  } as unknown as Anthropic;

  const deltas: Array<{ delta: string; fullText: string }> = [];
  const output = await runConversation(
    client,
    "test-model",
    [],
    async () => ({}),
    buildMessages([], "hi"),
    (delta, fullText) => deltas.push({ delta, fullText })
  );

  assert.equal(output, "hello world");
  assert.deepEqual(deltas.map((d) => d.delta), ["hello ", "world"]);
  assert.equal(deltas.at(-1)?.fullText, "hello world");
});

test("runConversation inserts a paragraph break between tool steps in streamed text", async () => {
  const responses = [
    makeStream(
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me check" },
          {
            type: "tool_use",
            id: "tool-1",
            name: "search_items",
            input: { query: "roadmap" },
          },
        ],
      },
      ["Let me check"]
    ),
    makeStream(
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Found it." }],
      },
      ["Found it."]
    ),
  ];

  const client = {
    messages: {
      stream: () => {
        const next = responses.shift();
        if (!next) throw new Error("extra call");
        return next;
      },
    },
  } as unknown as Anthropic;

  const fullTexts: string[] = [];
  await runConversation(
    client,
    "test-model",
    [],
    async () => ({}),
    buildMessages([], "what's new?"),
    (_delta, fullText) => fullTexts.push(fullText)
  );

  assert.equal(fullTexts.at(-1), "Let me check\n\nFound it.");
});

test("runConversation returns a clear fallback on max_tokens", async () => {
  const client = {
    messages: {
      stream: () =>
        makeStream({
          stop_reason: "max_tokens",
          content: [],
        }),
    },
  } as unknown as Anthropic;

  const output = await runConversation(
    client,
    "test-model",
    [],
    async () => ({}),
    buildMessages([], "summarize everything")
  );

  assert.match(output, /response limit/i);
});

test("runConversation returns a clear fallback when the model request throws", async () => {
  let attempts = 0;
  const client = {
    messages: {
      stream: () => {
        attempts += 1;
        return makeErroringStream(new Error("fetch failed"));
      },
    },
  } as unknown as Anthropic;
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const output = await runConversation(
      client,
      "test-model",
      [],
      async () => ({}),
      buildMessages([], "retry please")
    );

    assert.match(output, /couldn't reach the model/i);
    assert.equal(attempts, 1);
  } finally {
    console.error = originalConsoleError;
  }
});
