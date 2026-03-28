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
