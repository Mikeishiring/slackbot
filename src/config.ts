const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-20250918";
const DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_ANTHROPIC_MAX_RETRIES = 2;
const LEGACY_ANTHROPIC_MAX_ATTEMPTS_ENV = "ANTHROPIC_MAX_ATTEMPTS" as const;

export interface AppConfig {
  slackBotToken: string;
  slackAppToken: string;
  anthropicApiKey: string;
  anthropicModel: string;
  anthropicRequestTimeoutMs: number;
  anthropicMaxRetries: number;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    slackBotToken: readRequiredEnv(env, "SLACK_BOT_TOKEN"),
    slackAppToken: readRequiredEnv(env, "SLACK_APP_TOKEN"),
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
  };
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
