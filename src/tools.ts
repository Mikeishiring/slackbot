/**
 * Tools — what the LLM can do.
 *
 * This is the only file you need to modify first.
 *
 * Two things live here:
 *   1. Tool DEFINITIONS — Claude reads these to know what it can call
 *   2. Tool IMPLEMENTATIONS — your code that actually runs when Claude calls a tool
 */

import { readFileSync } from "fs";
import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";

const DEFAULT_LIMIT = 10;
const DEFAULT_RECENT_DAYS = 7;
const MAX_LIMIT = 50;
const MAX_RECENT_DAYS = 3650;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const tools: Tool[] = [
  {
    name: "search_items",
    description:
      "Search the knowledge base by keyword. Returns matching items with title, date, source, and summary. Use this when someone asks about a topic, company, or concept.",
    input_schema: {
      type: "object" as const,
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
  },
  {
    name: "get_item",
    description:
      "Get full details for a specific item by its ID. Use this when someone wants to read the full content of something found via search.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The item ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "list_recent",
    description:
      "List the most recent items in the knowledge base. Use this when someone asks 'what's new' or 'what happened this week'.",
    input_schema: {
      type: "object" as const,
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
  },
];

export async function runTool(
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "search_items":
      return searchItems(
        readRequiredString(input.query, "query"),
        readOptionalString(input.tag, "tag"),
        readPositiveInteger(input.limit, DEFAULT_LIMIT, MAX_LIMIT, "limit")
      );

    case "get_item":
      return getItem(readRequiredString(input.id, "id"));

    case "list_recent":
      return listRecent(
        readPositiveInteger(
          input.days,
          DEFAULT_RECENT_DAYS,
          MAX_RECENT_DAYS,
          "days"
        ),
        readPositiveInteger(input.limit, DEFAULT_LIMIT, MAX_LIMIT, "limit")
      );

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
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

function searchItems(
  query: string,
  tag?: string,
  limit = DEFAULT_LIMIT
): ItemPreview[] {
  const data = loadData();
  const normalizedQuery = query.toLowerCase();
  const normalizedTag = tag?.toLowerCase();

  return data
    .filter((item) => {
      const matchesQuery =
        item.title.toLowerCase().includes(normalizedQuery) ||
        item.summary.toLowerCase().includes(normalizedQuery) ||
        (item.content ?? "").toLowerCase().includes(normalizedQuery);
      const matchesTag =
        !normalizedTag ||
        item.tags.some((itemTag) => itemTag.toLowerCase() === normalizedTag);
      return matchesQuery && matchesTag;
    })
    .sort(sortByDateDescending)
    .slice(0, limit)
    .map(toPreview);
}

function getItem(id: string): Item | { error: string } {
  const data = loadData();
  return data.find((item) => item.id === id) ?? { error: `Item '${id}' not found` };
}

function listRecent(
  days = DEFAULT_RECENT_DAYS,
  limit = DEFAULT_LIMIT
): ItemPreview[] {
  const data = loadData();
  const cutoff = startOfUtcDay(new Date()) - (days - 1) * MS_PER_DAY;

  return data
    .filter((item) => parseItemDate(item.date) >= cutoff)
    .sort(sortByDateDescending)
    .slice(0, limit)
    .map(toPreview);
}

function loadData(): Item[] {
  const raw = readFileSync(
    new URL("../data/sample-data.json", import.meta.url),
    "utf-8"
  );
  return JSON.parse(raw) as Item[];
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
