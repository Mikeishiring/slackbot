import "dotenv/config";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { formatHealthSnapshot, formatRetentionPruneResult } from "./admin.js";
import { createAgent } from "./agent.js";
import { getConfig } from "./config.js";
import { PolicyBotRuntime } from "./runtime.js";
import { startSlackBot } from "./slack.js";
import { createToolRunner, getToolDefinitions, type ToolContext } from "./tools.js";
import type { CaseSnapshot, CreateCaseInput } from "./types.js";
import { asNullableString } from "./utils.js";

export async function main(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const config = getConfig(env);
  const runtime = new PolicyBotRuntime(config);
  const cliArgs = process.argv.slice(2);

  if (cliArgs.length > 0) {
    await runCli(runtime, config, cliArgs);
    runtime.close();
    return;
  }

  if (config.runtimeMode === "worker") {
    const processed = await runtime.runWorkerUntilIdle();
    console.log(`Processed ${processed} queued job(s).`);
    runtime.close();
    return;
  }

  if (config.runtimeMode === "local") {
    console.log("Policy Bot runtime initialized in local mode.");
    console.log(`Database: ${config.databasePath}`);
    console.log(`Policy version: ${runtime.policy.version}`);
    return;
  }

  runPreflightChecks(config);

  const respond = createSlackResponder(runtime, config);
  const stopBackgroundWorker = startBackgroundWorkerLoop(
    runtime,
    config.workerPollMs,
    config.batchWorkerCount
  );
  registerShutdown(runtime, stopBackgroundWorker);
  let bot;
  try {
    bot = await startSlackBot({
      botToken: config.slackBotToken ?? "",
      appToken: config.slackAppToken ?? "",
      onMessage: (request) => runtime.handleSlackRequest(request, respond),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("invalid_auth")) {
      throw new Error(
        "Slack authentication failed. Check that SLACK_BOT_TOKEN and SLACK_APP_TOKEN are valid. " +
          "Get them from api.slack.com/apps > your app > OAuth & Socket Mode settings."
      );
    }
    throw error;
  }

  runtime.slackBot = bot;

  runtime.setNotifier(async (caseId, stepKey, status, summary) => {
    let caseRecord;
    try {
      caseRecord = runtime.storage.getCase(caseId);
    } catch {
      return;
    }
    if (!caseRecord.slackChannelId || !caseRecord.slackThreadTs) {
      return;
    }

    const stepLabel = stepKey.replace(/_/g, " ");
    const truncatedSummary = summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
    const line =
      status === "passed" ? `:white_check_mark: *${stepLabel}*`
        : status === "failed" ? `:x: *${stepLabel}* -- ${truncatedSummary || "failed"}`
        : status === "manual_review_required" ? `:eyes: *${stepLabel}* -- ${truncatedSummary || "needs review"}`
        : status === "blocked" ? `:no_entry: *${stepLabel}* -- ${truncatedSummary || "blocked"}`
        : status === "skipped" ? `:fast_forward: *${stepLabel}*`
        : `:hourglass_flowing_sand: *${stepLabel}* ${status}`;

    await bot.postMessage(
      caseRecord.slackChannelId,
      caseRecord.slackThreadTs,
      line
    );
  });
}

function createSlackResponder(
  runtime: PolicyBotRuntime,
  config: ReturnType<typeof getConfig>
): (text: string, threadHistory: string[], context: ToolContext) => Promise<string> {
  if (!config.anthropicApiKey) {
    return async () =>
      "Anthropic API key is not configured. Set ANTHROPIC_API_KEY to enable natural language interaction.";
  }

  const tools = getToolDefinitions();
  const agent = createAgent({
    anthropicApiKey: config.anthropicApiKey,
    tools,
    model: config.anthropicModel,
    requestTimeoutMs: config.anthropicRequestTimeoutMs,
    maxRetries: config.anthropicMaxRetries,
  });

  return async (text, threadHistory, context) => {
    const runTool = createToolRunner(runtime, context);
    return agent.respond(text, threadHistory, runTool);
  };
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  void main().catch((error) => {
    console.error("Failed to start Policy Bot", error);
    process.exit(1);
  });
}

function runPreflightChecks(config: ReturnType<typeof getConfig>): void {
  if (!config.anthropicApiKey) {
    console.warn(
      "WARNING: ANTHROPIC_API_KEY is not set. The bot will respond to every message with an error. " +
        "Set ANTHROPIC_API_KEY in your .env file to enable natural language interaction."
    );
  }

  if (!checkPlaywrightInstalled()) {
    console.warn(
      "WARNING: Playwright browsers may not be installed. Evidence capture will fail on first use. " +
        "Run `npm run setup` to install Chromium."
    );
  }

  if (
    config.slackBotToken?.startsWith("xoxb-your") ||
    config.slackAppToken?.startsWith("xapp-your")
  ) {
    console.warn(
      "WARNING: Slack tokens appear to be placeholder values from .env.example. " +
        "Replace them with real tokens from api.slack.com/apps."
    );
  }

  if (!config.braveSearchApiKey && !config.googleSearchApiKey) {
    console.warn(
      "WARNING: No search API configured. Reputation search will produce ZERO results " +
        "because Google blocks headless browsers. This is effectively required. " +
        "Set BRAVE_SEARCH_API_KEY (free at https://brave.com/search/api/)"
    );
  }
}

function checkPlaywrightInstalled(): boolean {
  const locations = [
    resolve("node_modules", "playwright-core", ".local-browsers"),
    resolve(process.env.HOME ?? process.env.USERPROFILE ?? "", ".cache", "ms-playwright"),
  ];
  return locations.some((location) => existsSync(location));
}

function isEntrypoint(moduleUrl: string, entrypointPath?: string): boolean {
  if (!entrypointPath) {
    return false;
  }

  return moduleUrl === pathToFileURL(entrypointPath).href;
}

export async function runCli(
  runtime: PolicyBotRuntime,
  config: ReturnType<typeof getConfig>,
  args: string[],
  logger: Pick<typeof console, "log"> = console
): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case "health":
      logger.log(formatHealthSnapshot(runtime.getHealthSnapshot()));
      return;
    case "run-jobs": {
      const workers = rest[0]
        ? parseCliPositiveInteger(rest[0], "WORKERS")
        : config.batchWorkerCount;
      const processed =
        workers === 1
          ? await runtime.runWorkerUntilIdle("cli")
          : await runtime.runWorkersUntilIdle("cli", workers);
      logger.log(`Processed ${processed} queued job(s) with ${workers} worker(s).`);
      return;
    }
    case "show-case": {
      const caseId = requireCliArg(rest[0], "CASE_ID");
      logger.log(renderJson(runtime.workflow.getCaseSnapshot(caseId)));
      return;
    }
    case "rebuild-report": {
      const caseId = requireCliArg(rest[0], "CASE_ID");
      const snapshot = await runtime.rebuildCaseReport(caseId);
      logger.log(
        `Rebuilt reports for ${snapshot.caseRecord.id} (${snapshot.reports.length} report records).`
      );
      return;
    }
    case "export-case": {
      const caseId = requireCliArg(rest[0], "CASE_ID");
      const result = await runtime.exportCase(caseId);
      logger.log(
        `Exported ${result.caseId} to ${result.bundleDirectory}\nManifest: ${result.manifestPath}`
      );
      return;
    }
    case "prune-retention": {
      const retentionDays = rest[0] ? parseCliPositiveInteger(rest[0], "RETENTION_DAYS") : config.retentionDays;
      logger.log(formatRetentionPruneResult(await runtime.pruneRetention(retentionDays)));
      return;
    }
    case "list-cases":
      logger.log(renderJson(runtime.workflow.listCases(rest[0] ? parseCliPositiveInteger(rest[0], "LIMIT") : undefined)));
      return;
    case "review-queue":
      logger.log(renderJson(runtime.workflow.listReviewTasks(rest[0] || undefined)));
      return;
    case "list-jobs":
      logger.log(renderJson(runtime.storage.listJobs(rest[0] || undefined)));
      return;
    case "run-batch": {
      const inputPath = requireCliArg(rest[0], "INPUT_PATH");
      const workers = rest[1]
        ? parseCliPositiveInteger(rest[1], "WORKERS")
        : config.batchWorkerCount;
      const batchInputs = await readBatchCreateCaseInputs(inputPath);
      const createdSnapshots: CaseSnapshot[] = [];

      for (const input of batchInputs) {
        createdSnapshots.push(await runtime.createCase(input));
      }

      const processed =
        workers === 1
          ? await runtime.runWorkerUntilIdle("cli-batch")
          : await runtime.runWorkersUntilIdle("cli-batch", workers);
      const finalSnapshots = createdSnapshots.map((snapshot) =>
        runtime.workflow.getCaseSnapshot(snapshot.caseRecord.id)
      );
      logger.log(
        formatBatchRunSummary(resolve(inputPath), processed, finalSnapshots, workers)
      );
      return;
    }
    default:
      throw new Error(
        `Unknown CLI command: ${command}. Supported commands: health, run-jobs [WORKERS], show-case, rebuild-report, export-case, prune-retention, list-cases, review-queue, list-jobs, run-batch INPUT_PATH [WORKERS]`
      );
  }
}

export function startBackgroundWorkerLoop(
  runtime: Pick<PolicyBotRuntime, "runWorkerUntilIdle"> &
    Partial<Pick<PolicyBotRuntime, "runWorkersUntilIdle">>,
  pollMs: number,
  workerCountOrLogger: number | Pick<typeof console, "log" | "error"> = 1,
  maybeLogger: Pick<typeof console, "log" | "error"> = console
): () => Promise<void> {
  const workerCount =
    typeof workerCountOrLogger === "number" ? workerCountOrLogger : 1;
  const logger =
    typeof workerCountOrLogger === "number" ? maybeLogger : workerCountOrLogger;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) {
      return;
    }

    running = true;
    try {
      const processed =
        workerCount <= 1 || !runtime.runWorkersUntilIdle
          ? await runtime.runWorkerUntilIdle("slack-background")
          : await runtime.runWorkersUntilIdle("slack-background", workerCount);
      if (processed > 0) {
        logger.log(`Background worker processed ${processed} job(s).`);
      }
    } catch (error) {
      logger.error("Background worker tick failed", error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, pollMs);
  timer.unref?.();

  return (): Promise<void> => {
    stopped = true;
    clearInterval(timer);
    if (!running) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!running) {
          clearInterval(check);
          resolve();
        }
      }, 200);
      check.unref?.();
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 30_000).unref?.();
    });
  };
}

function requireCliArg(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Missing required argument: ${label}`);
  }

  return value;
}

function parseCliPositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function parseBatchCreateCaseInputsBody(
  body: string
): Record<string, unknown>[] {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new Error("Batch input file is empty.");
  }

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Batch JSON must be an array of case payloads.");
    }

    return parsed.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Batch entry ${index + 1} must be an object.`);
      }

      return value as Record<string, unknown>;
    });
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Batch entry ${index + 1} must be an object.`);
      }

      return parsed as Record<string, unknown>;
    });
}

async function readBatchCreateCaseInputs(
  inputPath: string
): Promise<CreateCaseInput[]> {
  const body = await readFile(resolve(inputPath), "utf8");
  return parseBatchCreateCaseInputsBody(body).map(mapBatchCaseInput);
}

function mapBatchCaseInput(
  parsed: Record<string, unknown>
): CreateCaseInput {
  return {
    displayName: requireBatchString(parsed.displayName, "displayName"),
    counterpartyKind: requireBatchCounterpartyKind(parsed.counterpartyKind),
    legalName: asNullableString(parsed.legalName),
    incorporationCountry: asNullableString(parsed.incorporationCountry),
    incorporationState: asNullableString(parsed.incorporationState),
    website: asNullableString(parsed.website),
    registrySearchUrl: asNullableString(parsed.registrySearchUrl),
    publicListingUrl: asNullableString(parsed.publicListingUrl),
    exchangeName: asNullableString(parsed.exchangeName),
    stockSymbol: asNullableString(parsed.stockSymbol),
    requestedBy: asNullableString(parsed.requestedBy),
    notes: asNullableString(parsed.notes),
    slackChannelId: null,
    slackThreadTs: null,
  };
}

function requireBatchString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string in batch input.`);
  }

  return value.trim();
}

function requireBatchCounterpartyKind(
  value: unknown
): CreateCaseInput["counterpartyKind"] {
  if (value === "entity" || value === "individual") {
    return value;
  }

  throw new Error(
    "counterpartyKind must be 'entity' or 'individual' in batch input."
  );
}

function formatBatchRunSummary(
  inputPath: string,
  processedJobs: number,
  snapshots: CaseSnapshot[],
  workers: number
): string {
  const lines = [
    `Batch input: ${inputPath}`,
    `Cases created: ${snapshots.length}`,
    `Workers: ${workers}`,
    `Jobs processed: ${processedJobs}`,
    "",
    "Results:",
  ];

  lines.push(
    ...snapshots.map((snapshot) => {
      const openReviewTasks = snapshot.reviewTasks.filter(
        (task) => task.status === "open"
      ).length;
      const openIssues = snapshot.issues.filter(
        (issue) => issue.status === "open"
      ).length;
      return [
        `- ${snapshot.caseRecord.displayName} (${snapshot.caseRecord.id})`,
        `  ${snapshot.caseRecord.caseStatus} / ${snapshot.caseRecord.recommendation}`,
        `  review_tasks=${openReviewTasks} issues=${openIssues}`,
      ].join("\n");
    })
  );

  return lines.join("\n");
}

function registerShutdown(
  runtime: Pick<PolicyBotRuntime, "close">,
  stopBackgroundWorker: () => Promise<void>
): void {
  let closing = false;
  const shutdown = () => {
    if (closing) {
      return;
    }

    closing = true;
    console.log("Shutting down gracefully...");
    void stopBackgroundWorker().then(() => {
      runtime.close();
      console.log("Shutdown complete.");
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
