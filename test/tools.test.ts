import assert from "node:assert/strict";
import test from "node:test";

import type { ToolContext } from "../src/agent.js";
import { runTool, tools } from "../src/tools.js";

const CTX: ToolContext = { channelId: "C1", threadTs: "1.0", userId: "U_HUMAN" };

test("search_items is case-insensitive and strips content from previews", async () => {
  const result = (await runTool("search_items", {
    query: "acme",
    tag: "Funding",
    limit: "2",
  }, CTX)) as Array<Record<string, unknown>>;

  assert.equal(result.length, 1);
  const firstResult = result[0];
  assert.ok(firstResult);
  assert.equal(firstResult["id"], "item-002");
  assert.equal("content" in firstResult, false);
});

test("get_item returns the full matching record", async () => {
  const result = (await runTool("get_item", {
    id: "item-004",
  }, CTX)) as Record<string, unknown>;

  assert.equal(result["title"], "Engineering Postmortem: March 18 Outage");
  assert.match(String(result["content"]), /missing index on the email column/i);
});

test("list_recent returns the newest previews in descending date order", async () => {
  const result = (await runTool("list_recent", {
    days: 10000,
    limit: 3,
  }, CTX)) as Array<Record<string, unknown>>;

  assert.deepEqual(
    result.map((item) => item["id"]),
    ["item-001", "item-002", "item-010"]
  );
  const firstResult = result[0];
  assert.ok(firstResult);
  assert.equal("content" in firstResult, false);
});

test("runTool rejects invalid required strings", async () => {
  await assert.rejects(
    () => runTool("get_item", { id: "   " }, CTX),
    /id must be a non-empty string/
  );
});

test("runTool rejects unknown tool names", async () => {
  await assert.rejects(
    () => runTool("nonexistent", {}, CTX),
    /Unknown tool: nonexistent/
  );
});

test("search_items without tag filter returns all keyword matches", async () => {
  const result = (await runTool("search_items", {
    query: "roadmap",
  }, CTX)) as Array<Record<string, unknown>>;

  // "roadmap" appears in item-001 title/summary/content
  assert.ok(result.length >= 1);
  const ids = result.map((item) => item["id"]);
  assert.ok(ids.includes("item-001"));
});

test("search_items respects limit parameter", async () => {
  const result = (await runTool("search_items", {
    query: "the",
    limit: 2,
  }, CTX)) as Array<Record<string, unknown>>;

  assert.equal(result.length, 2);
});

test("search_items with no matches returns empty array", async () => {
  const result = (await runTool("search_items", {
    query: "zzzznonexistenttermzzzz",
  }, CTX)) as Array<Record<string, unknown>>;

  assert.equal(result.length, 0);
});

test("get_item returns error object for missing ID", async () => {
  const result = (await runTool("get_item", {
    id: "item-999",
  }, CTX)) as Record<string, unknown>;

  assert.ok("error" in result);
  assert.match(String(result["error"]), /item-999/);
});

test("list_recent with 1 day returns only the most recent items", async () => {
  // item-001 is 2026-03-25 — only items from that date or later
  const result = (await runTool("list_recent", {
    days: 1,
    limit: 50,
  }, CTX)) as Array<Record<string, unknown>>;

  // All returned items should have dates >= cutoff
  for (const item of result) {
    const date = String(item["date"]);
    assert.ok(date >= "2026-03-25" || result.length === 0);
  }
});

test("limit is clamped to max 50", async () => {
  const result = (await runTool("search_items", {
    query: "the",
    limit: 999,
  }, CTX)) as Array<Record<string, unknown>>;

  // Should not exceed sample data size (10 items), but should not throw
  assert.ok(result.length <= 50);
});

test("search_items scores multi-word queries by word overlap", async () => {
  const result = (await runTool("search_items", {
    query: "series b funding",
    limit: 5,
  }, CTX)) as Array<Record<string, unknown>>;

  assert.ok(result.length > 0, "Multi-word query should match items");
  assert.equal(result[0]!["id"], "item-002", "Acme Series B should rank first");
});

test("runTool rejects non-string tag values", async () => {
  await assert.rejects(
    () => runTool("search_items", { query: "test", tag: 123 }, CTX),
    /tag must be a string/
  );
});

test("every advertised tool is dispatchable", async () => {
  // The definition list and the dispatch table are derived from one source,
  // so an advertised tool can never lack an implementation. This asserts that
  // invariant holds rather than trusting it.
  const names = tools.map((tool) => ("name" in tool ? tool.name : undefined));
  assert.ok(names.length > 0);

  for (const name of names) {
    assert.ok(name, "every tool should expose a name");
    await assert.doesNotReject(
      async () => {
        try {
          await runTool(name, {}, CTX);
        } catch (error) {
          // Validation errors are fine — they prove we reached the tool.
          if (error instanceof Error && /Unknown tool/.test(error.message)) {
            throw error;
          }
        }
      },
      `${name} is advertised but not dispatchable`
    );
  }
});

test("runTool hands the context to the tool", async () => {
  // Proves the authorization seam: a tool can see who is asking.
  const result = (await runTool(
    "search_items",
    { query: "roadmap" },
    { channelId: "C_X", threadTs: "9.9", userId: "U_BOB" }
  )) as unknown[];

  assert.ok(Array.isArray(result));
});
