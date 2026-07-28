export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";
/**
 * Generous by design. Claude Opus 5 thinks before answering, so a single
 * streamed turn can legitimately take a while. The SDK timeout is per attempt.
 */
export const DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_ANTHROPIC_MAX_RETRIES = 2;
/**
 * `max_tokens` caps thinking + visible text together. Leave headroom or a
 * thinking-heavy turn truncates mid-answer.
 */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 16_000;
/** Thinking depth and overall token spend. See ANTHROPIC_EFFORT in .env.example. */
export const DEFAULT_ANTHROPIC_EFFORT = "medium";

export const ANTHROPIC_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AnthropicEffort = (typeof ANTHROPIC_EFFORT_LEVELS)[number];

const LEGACY_ANTHROPIC_MAX_ATTEMPTS_ENV = "ANTHROPIC_MAX_ATTEMPTS" as const;

export interface AppConfig {
  slackBotToken: string;
  slackAppToken: string;
  slackAllowedChannels?: ReadonlySet<string>;
  anthropicApiKey: string;
  anthropicModel: string;
  anthropicRequestTimeoutMs: number;
  anthropicMaxRetries: number;
  anthropicMaxTokens: number;
  anthropicEffort: AnthropicEffort;
  anthropicSystemPromptAppend?: string;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const slackAllowedChannels = readChannelAllowlist(env, "SLACK_ALLOWED_CHANNELS");
  // Deliberately has no DEFAULT_ constant: the shipped prompt lives in
  // agent.ts, and duplicating a default here would give it two owners.
  const anthropicSystemPromptAppend = readOptionalEnv(
    env,
    "ANTHROPIC_SYSTEM_PROMPT_APPEND"
  );

  return {
    ...(anthropicSystemPromptAppend ? { anthropicSystemPromptAppend } : {}),
    slackBotToken: readRequiredEnv(env, "SLACK_BOT_TOKEN"),
    slackAppToken: readRequiredEnv(env, "SLACK_APP_TOKEN"),
    ...(slackAllowedChannels ? { slackAllowedChannels } : {}),
    anthropicApiKey: readRequiredEnv(env, "ANTHROPIC_API_KEY"),
    anthropicModel:
      readOptionalEnv(env, "ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL,
    anthropicRequestTimeoutMs: readPositiveIntegerEnv(
      env,
      "ANTHROPIC_REQUEST_TIMEOUT_MS",
      DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS
    ),
    anthropicMaxRetries: readPositiveIntegerEnvFromNames(
      env,
      ["ANTHROPIC_MAX_RETRIES", LEGACY_ANTHROPIC_MAX_ATTEMPTS_ENV],
      DEFAULT_ANTHROPIC_MAX_RETRIES
    ),
    anthropicMaxTokens: readPositiveIntegerEnv(
      env,
      "ANTHROPIC_MAX_TOKENS",
      DEFAULT_ANTHROPIC_MAX_TOKENS
    ),
    anthropicEffort: readEffortEnv(env, "ANTHROPIC_EFFORT"),
  };
}

function readChannelAllowlist(
  env: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv
): ReadonlySet<string> | undefined {
  const value = readOptionalEnv(env, name);
  if (!value) return undefined;

  const channels = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return channels.length > 0 ? new Set(channels) : undefined;
}

function readEffortEnv(
  env: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv
): AnthropicEffort {
  const value = readOptionalEnv(env, name);
  if (!value) {
    return DEFAULT_ANTHROPIC_EFFORT;
  }

  const normalized = value.toLowerCase();
  if (!isEffortLevel(normalized)) {
    throw new Error(
      `${name} must be one of: ${ANTHROPIC_EFFORT_LEVELS.join(", ")}`
    );
  }

  return normalized;
}

function isEffortLevel(value: string): value is AnthropicEffort {
  return (ANTHROPIC_EFFORT_LEVELS as readonly string[]).includes(value);
}

function readRequiredEnv(
  env: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv
): string {
  const value = readOptionalEnv(env, name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readOptionalEnv(
  env: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv
): string | undefined {
  const value = env[name];
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function readPositiveIntegerEnvFromNames(
  env: NodeJS.ProcessEnv,
  names: Array<keyof NodeJS.ProcessEnv>,
  fallback: number
): number {
  for (const name of names) {
    const value = readOptionalEnv(env, name);
    if (!value) {
      continue;
    }

    return parsePositiveInteger(value, name);
  }

  return fallback;
}

function readPositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv,
  fallback: number
): number {
  const value = readOptionalEnv(env, name);
  if (!value) {
    return fallback;
  }

  return parsePositiveInteger(value, name);
}

function parsePositiveInteger(
  value: string,
  name: keyof NodeJS.ProcessEnv
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}
