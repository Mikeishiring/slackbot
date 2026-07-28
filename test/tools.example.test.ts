/**
 * TEMPLATE — copy this file when you replace the sample data with your own.
 *
 * `setItemSource` swaps the data source for a fixture, so these tests keep
 * passing after you point `loadSampleFile()` at Postgres or an API. No live
 * database, no network, no mocking library.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ToolContext } from "../src/agent.js";
import { resetItemSource, runTool, setItemSource } from "../src/tools.js";

const CTX: ToolContext = { channelId: "C1", threadTs: "1.0", userId: "U_TEST" };

const FIXTURE = [
  {
    id: "fix-001",
    title: "Widget pricing update",
    date: "2026-07-01",
    source: "pricing-team",
    tags: ["pricing"],
    summary: "Widgets go to $49 in August.",
    content: "Full memo about the widget price change.",
  },
  {
    id: "fix-002",
    title: "Gadget launch retro",
    date: "2026-06-15",
    source: "product",
    tags: ["product"],
    summary: "What we learned launching gadgets.",
  },
];

test("tools answer from a fixture instead of the shipped sample data", async (t) => {
  setItemSource(async () => structuredClone(FIXTURE));
  t.after(resetItemSource);

  const found = (await runTool(
    "search_items",
    { query: "widget pricing" },
    CTX
  )) as Array<Record<string, unknown>>;

  assert.equal(found.length, 1);
  assert.equal(found[0]?.["id"], "fix-001");
  // Previews omit the full body.
  assert.equal("content" in (found[0] ?? {}), false);
});

test("get_item returns the full record from the fixture", async (t) => {
  setItemSource(async () => structuredClone(FIXTURE));
  t.after(resetItemSource);

  const item = (await runTool("get_item", { id: "fix-001" }, CTX)) as Record<
    string,
    unknown
  >;

  assert.match(String(item["content"]), /widget price change/i);
});

test("list_recent orders the fixture newest first", async (t) => {
  setItemSource(async () => structuredClone(FIXTURE));
  t.after(resetItemSource);

  const recent = (await runTool(
    "list_recent",
    { days: 10_000, limit: 10 },
    CTX
  )) as Array<Record<string, unknown>>;

  assert.deepEqual(
    recent.map((item) => item["id"]),
    ["fix-001", "fix-002"]
  );
});

test("a tool can refuse based on who is asking", async (t) => {
  // The pattern for gating a tool: read context.userId inside `run`.
  // Prefer an allowlist — it fails closed when Slack omits the user.
  setItemSource(async () => structuredClone(FIXTURE));
  t.after(resetItemSource);

  const ALLOWED = new Set(["U_ADMIN"]);
  const gate = (context: ToolContext): boolean =>
    Boolean(context.userId && ALLOWED.has(context.userId));

  assert.equal(gate(CTX), false);
  assert.equal(gate({ ...CTX, userId: "U_ADMIN" }), true);
  assert.equal(gate({ channelId: "C1", threadTs: "1.0" }), false);
});
