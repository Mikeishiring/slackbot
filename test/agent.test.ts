import assert from "node:assert/strict";
import test from "node:test";

import type Anthropic from "@anthropic-ai/sdk";
import { buildMessages, runConversation } from "../src/agent.js";

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

test("buildMessages handles empty history", () => {
  const messages = buildMessages([], "hello");

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { role: "user", content: "hello" });
});

test("buildMessages skips blank history entries", () => {
  const messages = buildMessages(["user: ", "assistant:   ", "user: real message"], "latest");

  // Blank entries should be filtered out
  assert.ok(messages.length >= 1);
  assert.deepEqual(messages.at(-1), { role: "user", content: "latest" });
});

test("buildMessages replaces empty user text with placeholder", () => {
  const messages = buildMessages([], "   ");

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { role: "user", content: "(empty message)" });
});

test("runConversation executes tool calls and joins final text blocks", async () => {
  const createCalls: Array<Record<string, unknown>> = [];
  const responses = [
    {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "search_items",
          input: { query: "roadmap" },
        },
      ],
    },
    {
      stop_reason: "end_turn",
      content: [
        { type: "text", text: "*3 items this week*" },
        { type: "text", text: "- Q1 roadmap update" },
      ],
    },
  ];

  const client = {
    messages: {
      create: async (params: Record<string, unknown>) => {
        createCalls.push(params);
        const nextResponse = responses.shift();
        if (!nextResponse) {
          throw new Error("Unexpected extra model call");
        }

        return nextResponse;
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
  assert.equal(createCalls.length, 2);

  const secondRequest = createCalls[1];
  assert.ok(secondRequest);
  const secondRequestMessages = secondRequest["messages"] as Array<Record<string, unknown>>;
  const lastMessage = secondRequestMessages.at(-1);

  assert.equal(lastMessage?.["role"], "user");
  assert.match(JSON.stringify(lastMessage), /tool_result/);
});

test("runConversation returns a clear fallback on max_tokens", async () => {
  const client = {
    messages: {
      create: async () => ({
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
      create: async () => {
        attempts += 1;
        throw new Error("fetch failed");
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

test("runConversation handles tool execution errors gracefully", async () => {
  const responses = [
    {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "failing_tool",
          input: {},
        },
      ],
    },
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "The tool failed, sorry." }],
    },
  ];

  const client = {
    messages: {
      create: async () => {
        const nextResponse = responses.shift();
        if (!nextResponse) throw new Error("Unexpected call");
        return nextResponse;
      },
    },
  } as unknown as Anthropic;

  const output = await runConversation(
    client,
    "test-model",
    [],
    async () => {
      throw new Error("database connection lost");
    },
    buildMessages([], "search for something")
  );

  assert.equal(output, "The tool failed, sorry.");
});

test("runConversation returns fallback on unknown stop reason", async () => {
  const client = {
    messages: {
      create: async () => ({
        stop_reason: "content_filter",
        content: [],
      }),
    },
  } as unknown as Anthropic;

  const output = await runConversation(
    client,
    "test-model",
    [],
    async () => ({}),
    buildMessages([], "anything")
  );

  assert.match(output, /couldn't complete/i);
});
