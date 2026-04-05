import assert from "node:assert/strict";
import test from "node:test";

import { getConfig } from "../src/config.js";

test("getConfig reads local-mode defaults without live credentials", () => {
  const config = getConfig({
    POLICY_BOT_RUNTIME: "local",
  });

  assert.equal(config.runtimeMode, "local");
  assert.equal(config.slackBotToken, null);
  assert.equal(config.slackAppToken, null);
  assert.equal(config.anthropicApiKey, null);
  assert.equal(config.databasePath, "./var/policy-bot.sqlite");
  assert.equal(config.artifactRoot, "./var/artifacts");
  assert.equal(config.reportRoot, "./var/reports");
  assert.equal(config.exportRoot, "./var/exports");
  assert.equal(config.browserHeadless, true);
  assert.equal(config.workerPollMs, 5000);
  assert.equal(config.retentionDays, 365);
  assert.equal(config.entityEvidenceCacheDirectory, "./var/entity-evidence-cache");
  assert.equal(config.entityEvidenceCacheHours, 24);
  assert.equal(config.entityEvidenceBrowserAttempts, 3);
  assert.equal(config.entityEvidenceBrowserWaitMs, 4000);
  assert.equal(config.entityEvidenceLoadTimeoutMs, 20000);
  assert.equal(config.batchWorkerCount, 3);
  assert.equal(config.jobMaxAttempts, 3);
  assert.equal(config.jobRetryDelayMs, 5000);
  assert.equal(config.jobLockTimeoutMs, 600000);
});

test("getConfig requires Slack credentials in slack runtime", () => {
  assert.throws(
    () =>
      getConfig({
        POLICY_BOT_RUNTIME: "slack",
        SLACK_BOT_TOKEN: "xoxb-test",
      }),
    /SLACK_APP_TOKEN/
  );
});

test("getConfig accepts optional anthropic settings and runtime paths", () => {
  const config = getConfig({
    POLICY_BOT_RUNTIME: "worker",
    POLICY_BOT_DB_PATH: "./tmp/custom.sqlite",
    POLICY_BOT_ARTIFACT_DIR: "./tmp/artifacts",
    POLICY_BOT_REPORT_DIR: "./tmp/reports",
    POLICY_BOT_EXPORT_DIR: "./tmp/exports",
    POLICY_BOT_BROWSER_HEADLESS: "false",
    POLICY_BOT_WORKER_POLL_MS: "2500",
    POLICY_BOT_RETENTION_DAYS: "90",
    POLICY_BOT_ENTITY_EVIDENCE_CACHE_DIR: "./tmp/entity-cache",
    POLICY_BOT_ENTITY_EVIDENCE_CACHE_HOURS: "12",
    POLICY_BOT_ENTITY_EVIDENCE_BROWSER_ATTEMPTS: "5",
    POLICY_BOT_ENTITY_EVIDENCE_BROWSER_WAIT_MS: "1500",
    POLICY_BOT_ENTITY_EVIDENCE_LOAD_TIMEOUT_MS: "8000",
    POLICY_BOT_BATCH_WORKERS: "6",
    POLICY_BOT_JOB_MAX_ATTEMPTS: "4",
    POLICY_BOT_JOB_RETRY_DELAY_MS: "250",
    POLICY_BOT_JOB_LOCK_TIMEOUT_MS: "120000",
    ANTHROPIC_API_KEY: "sk-ant-test",
  });

  assert.equal(config.runtimeMode, "worker");
  assert.equal(config.databasePath, "./tmp/custom.sqlite");
  assert.equal(config.artifactRoot, "./tmp/artifacts");
  assert.equal(config.reportRoot, "./tmp/reports");
  assert.equal(config.exportRoot, "./tmp/exports");
  assert.equal(config.browserHeadless, false);
  assert.equal(config.workerPollMs, 2500);
  assert.equal(config.retentionDays, 90);
  assert.equal(config.entityEvidenceCacheDirectory, "./tmp/entity-cache");
  assert.equal(config.entityEvidenceCacheHours, 12);
  assert.equal(config.entityEvidenceBrowserAttempts, 5);
  assert.equal(config.entityEvidenceBrowserWaitMs, 1500);
  assert.equal(config.entityEvidenceLoadTimeoutMs, 8000);
  assert.equal(config.batchWorkerCount, 6);
  assert.equal(config.jobMaxAttempts, 4);
  assert.equal(config.jobRetryDelayMs, 250);
  assert.equal(config.jobLockTimeoutMs, 120000);
  assert.equal(config.anthropicApiKey, "sk-ant-test");
});

test("getConfig rejects invalid runtime mode", () => {
  assert.throws(
    () =>
      getConfig({
        POLICY_BOT_RUNTIME: "demo",
      }),
    /POLICY_BOT_RUNTIME/
  );
});

test("getConfig rejects invalid numeric overrides", () => {
  assert.throws(
    () =>
      getConfig({
        POLICY_BOT_RUNTIME: "local",
        ANTHROPIC_MAX_RETRIES: "0",
      }),
    /ANTHROPIC_MAX_RETRIES must be a positive integer/
  );
});
