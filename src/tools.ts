/**
 * Tools — what the LLM can do. THIS IS YOUR FILE.
 *
 * Each tool is one self-contained value: its schema and its implementation
 * live together, so adding a tool is one object and forgetting to implement
 * one is a compile error rather than a wrong answer at runtime.
 *
 * To make this bot yours, you change two things here:
 *   1. `loadSampleFile()` — point it at your database, API, or file
 *   2. The tool list — what your team can ask for
 *
 * Every tool's `run` receives a `ToolContext` (who asked, which channel,
 * which thread), so authorization, rate limiting, and audit logging are an
 * `if` at the top of a tool — no core file changes.
 */

import { readFile } from "fs/promises";
import type { Tool, ToolUnion } from "@anthropic-ai/sdk/resources/messages.js";

import type { ToolContext } from "./agent.js";

const DEFAULT_LIMIT = 10;
const DEFAULT_RECENT_DAYS = 7;
const MAX_LIMIT = 50;
const MAX_RECENT_DAYS = 3650;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A tool Claude can call. `run` may be sync or async; whatever it returns is
 * JSON-serialized and handed back to Claude (capped by MAX_TOOL_RESULT_CHARS).
 */
export interface LocalTool {
  name: string;
  description: string;
  inputSchema: Tool["input_schema"];
  run: (
    input: Record<string, unknown>,
    context: ToolContext
  ) => unknown | Promise<unknown>;
}

interface Item {
  id: string;
  title: string;
  date: string;
  source: string;
  tags: string[];
  summary: string;
  content?: string;
}

type ItemPreview = Omit<Item, "content">;

// ---------------------------------------------------------------------------
// Your data
// ---------------------------------------------------------------------------

/**
 * REPLACE THIS BODY with your own source. It's async so a database or HTTP
 * call drops straight in:
 *
 *   const { rows } = await pool.query("SELECT * FROM items");
 *   return rows;
 *
 * If your source is remote, either drop the cache below or give it a TTL.
 */
async function loadSampleFile(): Promise<Item[]> {
  const raw = await readFile(
    new URL("../data/sample-data.json", import.meta.url),
    "utf-8"
  );

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("sample-data.json must contain a JSON array of items");
  }

  return rebaseSampleDates(parsed as Item[]);
}

/**
 * Slides the sample dates onto the current week, newest first.
 *
 * The fixture ships with fixed dates, so "what's new this week?" — the demo
 * the README tells you to run first — returned nothing once the file aged
 * past a week. Rebasing keeps the starter's first impression working forever
 * while leaving the file a plain, readable JSON array.
 *
 * Delete this the moment you point `loadSampleFile` at real data: your rows
 * have real dates and shifting them would be a lie.
 */
function rebaseSampleDates(items: Item[]): Item[] {
  const ordered = [...items].sort(sortByDateDescending);
  const today = startOfUtcDay(new Date());

  const shifted = new Map<string, string>();
  ordered.forEach((item, index) => {
    // Newest lands today, then one item per day going back.
    shifted.set(item.id, toIsoDate(today - index * MS_PER_DAY));
  });

  return items.map((item) => ({ ...item, date: shifted.get(item.id) ?? item.date }));
}

function toIsoDate(msSinceEpoch: number): string {
  return new Date(msSinceEpoch).toISOString().slice(0, 10);
}

type ItemSource = () => Promise<Item[]>;

let itemSource: ItemSource = loadSampleFile;
let cachedItems: Item[] | undefined;

/**
 * TESTS ONLY. Swap in a fixture so tool tests don't need your real data
 * source. Call `resetItemSource()` afterwards.
 */
export function setItemSource(source: ItemSource): void {
  itemSource = source;
  cachedItems = undefined;
}

/** TESTS ONLY. Restores the shipped sample-data loader. */
export function resetItemSource(): void {
  itemSource = loadSampleFile;
  cachedItems = undefined;
}

async function loadItems(): Promise<Item[]> {
  cachedItems ??= await itemSource();
  return cachedItems;
}

/**
 * Called on shutdown, before the process exits. If you opened a connection
 * pool in `loadItems`, close it here:  await pool.end();
 */
export async function closeTools(): Promise<void> {
  cachedItems = undefined;
}

// ---------------------------------------------------------------------------
// Your tools
// ---------------------------------------------------------------------------

const searchItems: LocalTool = {
  name: "search_items",
  description:
    "Search the knowledge base by keyword. Returns matching items with title, date, source, and summary. Use this when someone asks about a topic, company, or concept.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search term — a keyword, name, or phrase",
      },
      tag: {
        type: "string",
        description: "Optional tag to filter by (e.g. 'engineering', 'product')",
      },
      limit: {
        type: "number",
        description: "Max results to return (default 10)",
      },
    },
    required: ["query"],
  },
  run: (input) =>
    runSearch(
      readRequiredString(input.query, "query"),
      readOptionalString(input.tag, "tag"),
      readPositiveInteger(input.limit, DEFAULT_LIMIT, MAX_LIMIT, "limit")
    ),
};

const getItem: LocalTool = {
  name: "get_item",
  description:
    "Get full details for a specific item by its ID. Use this when someone wants to read the full content of something found via search.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The item ID",
      },
    },
    required: ["id"],
  },
  run: (input) => runGetItem(readRequiredString(input.id, "id")),
};

const listRecent: LocalTool = {
  name: "list_recent",
  description:
    "List the most recent items in the knowledge base. Use this when someone asks 'what's new' or 'what happened this week'.",
  inputSchema: {
    type: "object",
    properties: {
      days: {
        type: "number",
        description: "How many days back to look (default 7)",
      },
      limit: {
        type: "number",
        description: "Max results to return (default 10)",
      },
    },
  },
  run: (input) =>
    runListRecent(
      readPositiveInteger(input.days, DEFAULT_RECENT_DAYS, MAX_RECENT_DAYS, "days"),
      readPositiveInteger(input.limit, DEFAULT_LIMIT, MAX_LIMIT, "limit")
    ),
};

/**
 * Add your tools here. To gate one by Slack user, start its `run` with:
 *   if (!ALLOWED.has(context.userId ?? "")) return { error: "Not authorized" };
 *
 * Use an allowlist, not a deny-list: `context.userId` is optional, so
 * `!==` fails *open* when Slack omits the user.
 *
 * And note what this does NOT do. It authorizes the person who asked; it does
 * not restrict who can read the answer. The reply goes into the thread, so
 * everyone in that channel sees whatever the tool returned. If data is
 * sensitive to an audience rather than to a requester, gate on
 * `context.channelId` as well.
 */
const LOCAL_TOOLS: LocalTool[] = [searchItems, getItem, listRecent];

/**
 * Anthropic-hosted tools work alongside yours — no implementation needed.
 * Uncomment to let the bot search the web:
 *
 * const SERVER_TOOLS: ToolUnion[] = [
 *   { type: "web_search_20260209", name: "web_search", max_uses: 5 },
 * ];
 */
const SERVER_TOOLS: ToolUnion[] = [];

// ---------------------------------------------------------------------------
// Wiring — you shouldn't need to touch below this line
// ---------------------------------------------------------------------------

export const tools: ToolUnion[] = [
  ...LOCAL_TOOLS.map(
    (tool): ToolUnion => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })
  ),
  ...SERVER_TOOLS,
];

const dispatch = new Map(LOCAL_TOOLS.map((tool) => [tool.name, tool]));

/**
 * A duplicate name is otherwise silent: `tools` advertises both entries while
 * `dispatch` keeps only the last, so Claude sees a tool that resolves to the
 * wrong implementation. One file makes that eyeball-checkable; this makes it
 * impossible. Spans SERVER_TOOLS too, since they share the namespace.
 */
export function assertUniqueToolNames(candidates: ToolUnion[]): void {
  const seen = new Set<string>();

  for (const tool of candidates) {
    const name = "name" in tool ? tool.name : undefined;
    if (!name) continue;

    if (seen.has(name)) {
      throw new Error(
        `Duplicate tool name: ${name}. Every entry in LOCAL_TOOLS and SERVER_TOOLS needs a unique name.`
      );
    }
    seen.add(name);
  }
}

assertUniqueToolNames(tools);

export async function runTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext
): Promise<unknown> {
  const tool = dispatch.get(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return tool.run(input, context);
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

async function runSearch(
  query: string,
  tag?: string,
  limit = DEFAULT_LIMIT
): Promise<ItemPreview[]> {
  const data = await loadItems();
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (queryTerms.length === 0) return [];
  const normalizedTag = tag?.toLowerCase();

  const scored: Array<{ item: Item; score: number }> = [];

  for (const item of data) {
    const matchesTag =
      !normalizedTag ||
      item.tags.some((itemTag) => itemTag.toLowerCase() === normalizedTag);
    if (!matchesTag) continue;

    const titleLower = item.title.toLowerCase();
    const textLower = [
      item.title,
      item.summary,
      item.content ?? "",
      item.tags.join(" "),
    ]
      .join(" ")
      .toLowerCase();

    let score = 0;
    for (const term of queryTerms) {
      if (!textLower.includes(term)) continue;
      score += titleLower.includes(term) ? 3 : 1;
    }

    if (score > 0) {
      if (queryTerms.every((t) => textLower.includes(t))) {
        score += queryTerms.length;
      }
      scored.push({ item, score });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || sortByDateDescending(a.item, b.item))
    .slice(0, limit)
    .map(({ item }) => toPreview(item));
}

async function runGetItem(id: string): Promise<Item | { error: string }> {
  const data = await loadItems();
  return data.find((item) => item.id === id) ?? { error: `Item '${id}' not found` };
}

async function runListRecent(
  days = DEFAULT_RECENT_DAYS,
  limit = DEFAULT_LIMIT
): Promise<ItemPreview[]> {
  const data = await loadItems();
  const cutoff = startOfUtcDay(new Date()) - (days - 1) * MS_PER_DAY;

  return data
    .filter((item) => parseItemDate(item.date) >= cutoff)
    .sort(sortByDateDescending)
    .slice(0, limit)
    .map(toPreview);
}

function toPreview({ content: _content, ...rest }: Item): ItemPreview {
  return rest;
}

function sortByDateDescending(a: Item, b: Item): number {
  return parseItemDate(b.date) - parseItemDate(a.date);
}

function parseItemDate(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    return Number.NEGATIVE_INFINITY;
  }

  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

// ---------------------------------------------------------------------------
// KEEP THESE — input validation
//
// Claude supplies these values, so they are untrusted input. These helpers
// clamp rather than throw where a sensible bound exists. If you replace the
// sample tools, keep this section and use it in your own `run` functions.
// ---------------------------------------------------------------------------

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function readOptionalString(
  value: unknown,
  fieldName: string
): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function readPositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
  fieldName: string
): number {
  if (value == null) {
    return fallback;
  }

  const parsed =
    typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : value;

  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a number`);
  }

  return Math.min(Math.max(Math.floor(parsed), 1), max);
}
