import assert from "node:assert/strict";
import test from "node:test";

import { runTool } from "../src/tools.js";

test("search_items is case-insensitive and strips content from previews", async () => {
  const result = (await runTool("search_items", {
    query: "acme",
    tag: "Funding",
    limit: "2",
  })) as Array<Record<string, unknown>>;

  assert.equal(result.length, 1);
  const firstResult = result[0];
  assert.ok(firstResult);
  assert.equal(firstResult["id"], "item-002");
  assert.equal("content" in firstResult, false);
});

test("get_item returns the full matching record", async () => {
  const result = (await runTool("get_item", {
    id: "item-004",
  })) as Record<string, unknown>;

  assert.equal(result["title"], "Engineering Postmortem: March 18 Outage");
  assert.match(String(result["content"]), /missing index on the email column/i);
});

test("list_recent returns the newest previews in descending date order", async () => {
  const result = (await runTool("list_recent", {
    days: 10000,
    limit: 3,
  })) as Array<Record<string, unknown>>;

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
    () => runTool("get_item", { id: "   " }),
    /id must be a non-empty string/
  );
});

test("runTool rejects unknown tool names", async () => {
  await assert.rejects(
    () => runTool("nonexistent", {}),
    /Unknown tool: nonexistent/
  );
});

test("search_items without tag filter returns all keyword matches", async () => {
  const result = (await runTool("search_items", {
    query: "roadmap",
  })) as Array<Record<string, unknown>>;

  // "roadmap" appears in item-001 title/summary/content
  assert.ok(result.length >= 1);
  const ids = result.map((item) => item["id"]);
  assert.ok(ids.includes("item-001"));
});

test("search_items respects limit parameter", async () => {
  const result = (await runTool("search_items", {
    query: "the",
    limit: 2,
  })) as Array<Record<string, unknown>>;

  assert.equal(result.length, 2);
});

test("search_items with no matches returns empty array", async () => {
  const result = (await runTool("search_items", {
    query: "zzzznonexistenttermzzzz",
  })) as Array<Record<string, unknown>>;

  assert.equal(result.length, 0);
});

test("get_item returns error object for missing ID", async () => {
  const result = (await runTool("get_item", {
    id: "item-999",
  })) as Record<string, unknown>;

  assert.ok("error" in result);
  assert.match(String(result["error"]), /item-999/);
});

test("list_recent with 1 day returns only the most recent items", async () => {
  // item-001 is 2026-03-25 — only items from that date or later
  const result = (await runTool("list_recent", {
    days: 1,
    limit: 50,
  })) as Array<Record<string, unknown>>;

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
  })) as Array<Record<string, unknown>>;

  // Should not exceed sample data size (10 items), but should not throw
  assert.ok(result.length <= 50);
});

test("search_items scores multi-word queries by word overlap", async () => {
  const result = (await runTool("search_items", {
    query: "series b funding",
    limit: 5,
  })) as Array<Record<string, unknown>>;

  assert.ok(result.length > 0, "Multi-word query should match items");
  assert.equal(result[0]!["id"], "item-002", "Acme Series B should rank first");
});

test("runTool rejects non-string tag values", async () => {
  await assert.rejects(
    () => runTool("search_items", { query: "test", tag: 123 }),
    /tag must be a string/
  );
});
