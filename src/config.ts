export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
export const DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_ANTHROPIC_MAX_RETRIES = 2;
export const DEFAULT_RUNTIME_MODE = "local";
export const DEFAULT_WORKER_POLL_MS = 5_000;
export const DEFAULT_ENTITY_EVIDENCE_CACHE_HOURS = 24;
export const DEFAULT_ENTITY_EVIDENCE_BROWSER_ATTEMPTS = 3;
export const DEFAULT_ENTITY_EVIDENCE_BROWSER_WAIT_MS = 4_000;
export const DEFAULT_ENTITY_EVIDENCE_LOAD_TIMEOUT_MS = 20_000;
export const DEFAULT_BATCH_WORKER_COUNT = 3;
export const DEFAULT_JOB_MAX_ATTEMPTS = 3;
export const DEFAULT_JOB_RETRY_DELAY_MS = 5_000;
export const DEFAULT_JOB_LOCK_TIMEOUT_MS = 10 * 60 * 1_000;
const LEGACY_ANTHROPIC_MAX_ATTEMPTS_ENV = "ANTHROPIC_MAX_ATTEMPTS" as const;

export interface AppConfig {
  runtimeMode: "local" | "slack" | "worker";
  reviewerUserIds: string[] | null;
  slackBotToken: string | null;
  slackAppToken: string | null;
  anthropicApiKey: string | null;
  anthropicModel: string;
  anthropicRequestTimeoutMs: number;
  anthropicMaxRetries: number;
  policyDirectory: string;
  dataDirectory: string;
  databasePath: string;
  artifactRoot: string;
  reportRoot: string;
  exportRoot: string;
  browserHeadless: boolean;
  workerPollMs: number;
  retentionDays: number;
  entityEvidenceCacheDirectory: string;
  entityEvidenceCacheHours: number;
  entityEvidenceBrowserAttempts: number;
  entityEvidenceBrowserWaitMs: number;
  entityEvidenceLoadTimeoutMs: number;
  batchWorkerCount: number;
  jobMaxAttempts: number;
  jobRetryDelayMs: number;
  jobLockTimeoutMs: number;
  ofacDatasetUrls: string[] | null;
  braveSearchApiKey: string | null;
  googleSearchApiKey: string | null;
  googleSearchEngineId: string | null;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const runtimeMode = readRuntimeMode(env);
  const dataDirectory = readOptionalEnv(env, "POLICY_BOT_DATA_DIR") ?? "./var";

  return {
    runtimeMode,
    reviewerUserIds: readOptionalCsvEnv(env, "POLICY_BOT_REVIEWER_USER_IDS"),
    slackBotToken:
      runtimeMode === "slack" ? readRequiredEnv(env, "SLACK_BOT_TOKEN") : null,
    slackAppToken:
      runtimeMode === "slack" ? readRequiredEnv(env, "SLACK_APP_TOKEN") : null,
    anthropicApiKey: readOptionalEnv(env, "ANTHROPIC_API_KEY") ?? null,
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
    policyDirectory: readOptionalEnv(env, "POLICY_BOT_POLICY_DIR") ?? "./policy",
    dataDirectory,
    databasePath:
      readOptionalEnv(env, "POLICY_BOT_DB_PATH") ??
      `${dataDirectory}/policy-bot.sqlite`,
    artifactRoot:
      readOptionalEnv(env, "POLICY_BOT_ARTIFACT_DIR") ??
      `${dataDirectory}/artifacts`,
    reportRoot:
      readOptionalEnv(env, "POLICY_BOT_REPORT_DIR") ??
      `${dataDirectory}/reports`,
    exportRoot:
      readOptionalEnv(env, "POLICY_BOT_EXPORT_DIR") ??
      `${dataDirectory}/exports`,
    browserHeadless: readBooleanEnv(env, "POLICY_BOT_BROWSER_HEADLESS", true),
    workerPollMs: readPositiveIntegerEnv(
      env,
      "POLICY_BOT_WORKER_POLL_MS",
      DEFAULT_WORKER_POLL_MS
    ),
    retentionDays: readPositiveIntegerEnv(
      env,
      "POLICY_BOT_RETENTION_DAYS",
      365
    ),
    entityEvidenceCacheDirectory:
      readOptionalEnv(env, "POLICY_BOT_ENTITY_EVIDENCE_CACHE_DIR") ??
      `${dataDirectory}/entity-evidence-cache`,
    entityEvidenceCacheHours: readPositiveIntegerEnv(
      env,
      "POLICY_BOT_ENTITY_EVIDENCE_CACHE_HOURS",
      DEFAULT_ENTITY_EVIDENCE_CACHE_HOURS
    ),
    entityEvidenceBrowserAttempts: readPositiveIntegerEnv(
      env,
      "POLICY_BOT_ENTITY_EVIDENCE_BROWSER_ATTEMPTS",
      DEFAULT_ENTITY_EVIDENCE_BROWSER_ATTEMPTS
    ),
    entityEvidenceBrowserWaitMs: readPositiveIntegerEnv(
      env,
      "POLICY_BOT_ENTITY_EVIDENCE_BROWSER_WAIT_MS",
      DEFAULT_ENTITY_EVIDENCE_BROWSER_WAIT_MS
    ),
    entityEvidenceLoadTimeoutMs: readPositiveIntegerEnv(
      env,
      "POLICY_BOT_ENTITY_EVIDENCE_LOAD_TIMEOUT_MS",
      DEFAULT_ENTITY_EVIDENCE_LOAD_TIMEOUT_MS
    ),
    batchWorkerCount: readPositiveIntegerEnv(
      env,
      "POLICY_BOT_BATCH_WORKERS",
      DEFAULT_BATCH_WORKER_COUNT
    ),
    jobMaxAttempts: readPositiveIntegerEnv(
      env,
      "POLICY_BOT_JOB_MAX_ATTEMPTS",
      DEFAULT_JOB_MAX_ATTEMPTS
    ),
    jobRetryDelayMs: readPositiveIntegerEnv(
      env,
      "POLICY_BOT_JOB_RETRY_DELAY_MS",
      DEFAULT_JOB_RETRY_DELAY_MS
    ),
    jobLockTimeoutMs: readPositiveIntegerEnv(
      env,
      "POLICY_BOT_JOB_LOCK_TIMEOUT_MS",
      DEFAULT_JOB_LOCK_TIMEOUT_MS
    ),
    ofacDatasetUrls: readOptionalCsvEnv(env, "POLICY_BOT_OFAC_DATASET_URLS"),
    braveSearchApiKey: readOptionalEnv(env, "BRAVE_SEARCH_API_KEY") ?? null,
    googleSearchApiKey: readOptionalEnv(env, "GOOGLE_SEARCH_API_KEY") ?? null,
    googleSearchEngineId: readOptionalEnv(env, "GOOGLE_SEARCH_ENGINE_ID") ?? null,
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

function readRuntimeMode(
  env: NodeJS.ProcessEnv
): AppConfig["runtimeMode"] {
  const value =
    readOptionalEnv(env, "POLICY_BOT_RUNTIME") ?? DEFAULT_RUNTIME_MODE;

  if (value === "local" || value === "slack" || value === "worker") {
    return value;
  }

  throw new Error(
    "POLICY_BOT_RUNTIME must be one of: local, slack, worker"
  );
}

function readBooleanEnv(
  env: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv,
  fallback: boolean
): boolean {
  const value = readOptionalEnv(env, name);
  if (!value) {
    return fallback;
  }

  if (value === "true" || value === "1") {
    return true;
  }

  if (value === "false" || value === "0") {
    return false;
  }

  throw new Error(`${name} must be true/false or 1/0`);
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

function readOptionalCsvEnv(
  env: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv
): string[] | null {
  const value = readOptionalEnv(env, name);
  if (!value) {
    return null;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
