import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

export function nowIso(): string {
  return new Date().toISOString();
}

export function generateId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function slugify(value: string): string {
  return normalizeName(value).replace(/\s+/g, "-").slice(0, 80) || "artifact";
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function asNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function addDays(isoTimestamp: string, days: number): string {
  const date = new Date(isoTimestamp);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export function subtractDays(isoTimestamp: string, days: number): string {
  return addDays(isoTimestamp, -days);
}

export function includesAny(text: string, candidates: string[]): boolean {
  return candidates.some((candidate) => text.includes(candidate));
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
