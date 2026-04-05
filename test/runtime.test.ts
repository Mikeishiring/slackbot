import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getConfig } from "../src/config.js";
import { PolicyBotRuntime } from "../src/runtime.js";

import type { SlackIncomingRequest } from "../src/slack.js";

const policyDirectory = join(process.cwd(), "policy");

function handleCommand(
  runtime: PolicyBotRuntime,
  request: SlackIncomingRequest
): Promise<string> {
  return runtime.handleSlackRequest(request, runtime.createCommandResponder());
}

function createRuntime(
  prefix: string,
  envOverrides: NodeJS.ProcessEnv = {}
): PolicyBotRuntime {
  const tempRoot = mkdtempSync(join(tmpdir(), prefix));
  return new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
      POLICY_BOT_EXPORT_DIR: join(tempRoot, "exports"),
      ...envOverrides,
    }),
    {
      captureEnabled: false,
      datasetClient: {
        async loadCurrentDataset() {
          return {
            names: [],
            sourceUrl: "https://example.test/ofac.xml",
            fetchedAt: new Date().toISOString(),
          };
        },
      },
    }
  );
}

test("handleSlackRequest returns a precise error for invalid create case JSON", async () => {
  const runtime = createRuntime("policy-bot-runtime-invalid-");

  try {
    const response = await handleCommand(runtime, {
      text: "create case {bad json}",
      channelId: "C1",
      threadTs: "100.000",
      messageTs: "100.001",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });

    assert.match(response, /invalid json/i);
  } finally {
    runtime.close();
  }
});

test("runtime can export a case bundle and report health", async () => {
  const runtime = createRuntime("policy-bot-runtime-export-");

  try {
    const createResponse = await handleCommand(runtime, {
      text:
        'create case {"displayName":"Acme Labs","counterpartyKind":"individual","website":"https://example.com"}',
      channelId: "C1",
      threadTs: "400.000",
      messageTs: "400.001",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });
    const caseId = /Case ID:\s+(\S+)/.exec(createResponse)?.[1];
    assert.ok(caseId);

    const health = runtime.getHealthSnapshot();
    assert.equal(health.caseCounts.draft, 1);
    assert.equal(health.openReviewTaskCount, 0);

    const exportResult = await runtime.exportCase(caseId!);
    assert.ok(existsSync(exportResult.bundleDirectory));
    assert.ok(existsSync(exportResult.manifestPath));

    const manifestBody = await readFile(exportResult.manifestPath, "utf8");
    assert.match(manifestBody, /Acme Labs/);
    assert.match(manifestBody, /Working Report/);
  } finally {
    runtime.close();
  }
});

test("report rebuild preserves immutable report history while keeping current reports stable", async () => {
  const runtime = createRuntime("policy-bot-runtime-report-cleanup-");

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Cleanup Check",
      counterpartyKind: "individual",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: "https://example.com",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    await runtime.runWorkerUntilIdle("test-worker");
    await runtime.rebuildCaseReport(snapshot.caseRecord.id);
    const finalSnapshot = await runtime.rebuildCaseReport(snapshot.caseRecord.id);

    const localReportArtifacts = finalSnapshot.artifacts.filter(
      (artifact) => artifact.storageBackend === "local-report"
    );
    const expectedStageReportCount = finalSnapshot.steps.filter(
      (step) => step.status !== "pending" && step.status !== "running"
    ).length;
    assert.equal(finalSnapshot.reports.length, 4);
    assert.ok(finalSnapshot.reports.every((report) => report.isCurrent));
    assert.ok(
      finalSnapshot.reports.some((report) => report.kind === "review_packet")
    );
    assert.ok(
      finalSnapshot.reports.some((report) => report.kind === "traceability")
    );

    const workingReport = finalSnapshot.reports.find(
      (report) => report.kind === "working"
    );
    assert.ok(workingReport?.artifactId);
    assert.ok((workingReport?.versionNumber ?? 0) >= 2);
    const workingArtifact = finalSnapshot.artifacts.find(
      (artifact) => artifact.id === workingReport!.artifactId
    );
    assert.ok(workingArtifact);

    const workingBody = await readFile(
      runtime.artifactStore.resolveAbsolutePath(workingArtifact!),
      "utf8"
    );
    assert.match(workingBody, /## Stage Reports/);
    assert.match(workingBody, /## Source Index/);
    assert.ok(localReportArtifacts.length > expectedStageReportCount + 4);

    const reportHistory = runtime.storage.listReportHistory(snapshot.caseRecord.id);
    assert.ok(reportHistory.some((report) => !report.isCurrent));
    const historyCountByKind = reportHistory.reduce<Record<string, number>>(
      (counts, report) => {
        counts[report.kind] = (counts[report.kind] ?? 0) + 1;
        return counts;
      },
      {}
    );
    assert.equal(historyCountByKind.working, workingReport?.versionNumber);
    assert.ok(
      finalSnapshot.reports.every(
        (report) => historyCountByKind[report.kind] === report.versionNumber
      )
    );
  } finally {
    runtime.close();
  }
});

test("runtime retention prune removes aged communication records", async () => {
  const runtime = createRuntime("policy-bot-runtime-retention-");

  try {
    const createResponse = await handleCommand(runtime, {
      text:
        'create case {"displayName":"Retention Test","counterpartyKind":"individual","website":"https://example.com"}',
      channelId: "C1",
      threadTs: "500.000",
      messageTs: "500.001",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });
    const caseId = /Case ID:\s+(\S+)/.exec(createResponse)?.[1];
    assert.ok(caseId);

    runtime.storage.recordAuditEvent({
      caseId,
      eventType: "test.event",
      actorType: "system",
      actorId: null,
      payload: {},
    });
    const exportResult = await runtime.exportCase(caseId!);
    const manifest = JSON.parse(await readFile(exportResult.manifestPath, "utf8")) as {
      generatedAt?: string;
    };
    manifest.generatedAt = "2000-01-01T00:00:00.000Z";
    await writeFile(exportResult.manifestPath, JSON.stringify(manifest), "utf8");

    const ancient = "2000-01-01T00:00:00.000Z";
    // Force records old enough to be pruned.
    const db = (runtime.storage as unknown as { db?: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    assert.ok(db);
    db!.prepare("UPDATE case_messages SET created_at = ?").run(ancient);
    db!.prepare("UPDATE audit_events SET created_at = ? WHERE event_type = 'test.event'").run(ancient);
    db!.prepare("UPDATE artifacts SET created_at = ?").run(ancient);
    db!.prepare("UPDATE reports SET created_at = ?").run(ancient);

    const result = await runtime.pruneRetention(30);
    assert.ok(result.deletedMessages >= 2);
    assert.equal(result.deletedAuditEvents, 1);
    assert.ok(result.deletedArtifacts > 0);
    assert.ok(result.deletedReports > 0);
    assert.equal(result.deletedExports, 1);
    assert.equal(runtime.storage.listMessages(caseId!).length, 0);
    assert.equal(runtime.storage.listArtifacts(caseId!).length, 0);
    assert.equal(runtime.storage.listReports(caseId!).length, 0);
    assert.equal(existsSync(exportResult.bundleDirectory), false);
  } finally {
    runtime.close();
  }
});

test("show review and shorthand review commands expose and resolve reviewer work with audit logging", async () => {
  const runtime = createRuntime("policy-bot-runtime-review-commands-");

  try {
    const createResponse = await handleCommand(runtime, {
      text:
        'create case {"displayName":"Review Commands Test","counterpartyKind":"individual","website":"https://example.com"}',
      channelId: "C1",
      threadTs: "700.000",
      messageTs: "700.001",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });
    const caseId = /Case ID:\s+(\S+)/.exec(createResponse)?.[1];
    assert.ok(caseId);

    await runtime.runWorkerUntilIdle("test-worker");
    const snapshot = runtime.workflow.getCaseSnapshot(caseId!);
    const reviewTask = snapshot.reviewTasks.find((task) => task.status === "open");
    assert.ok(reviewTask);

    const showReview = await handleCommand(runtime, {
      text: `show review ${reviewTask!.id}`,
      channelId: "C1",
      threadTs: "700.000",
      messageTs: "700.002",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });
    assert.match(showReview, new RegExp(`Review task ${reviewTask!.id}`));
    assert.match(showReview, /Resolve with: clear review \| concern review \| reject review/);

    const resolveResponse = await handleCommand(runtime, {
      text: `clear review ${reviewTask!.id} Reviewer cleared this stage.`,
      channelId: "C1",
      threadTs: "700.000",
      messageTs: "700.003",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });
    assert.match(resolveResponse, /Case ID:/);
    const auditEvents = runtime.storage.listAuditEvents(caseId!);
    assert.ok(auditEvents.some((event) => event.eventType === "review.resolved"));
  } finally {
    runtime.close();
  }
});

test("rerun step clears stale step outputs before requeueing the step", async () => {
  const runtime = createRuntime("policy-bot-runtime-rerun-step-");

  try {
    const createResponse = await handleCommand(runtime, {
      text:
        'create case {"displayName":"Rerun Step Test","counterpartyKind":"individual","website":"https://example.com"}',
      channelId: "C1",
      threadTs: "800.000",
      messageTs: "800.001",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });
    const caseId = /Case ID:\s+(\S+)/.exec(createResponse)?.[1];
    assert.ok(caseId);

    await runtime.runWorkerUntilIdle("test-worker");
    const before = runtime.workflow.getCaseSnapshot(caseId!);
    assert.ok(before.facts.some((fact) => fact.stepKey === "reputation_search"));
    assert.ok(before.artifacts.some((artifact) => artifact.stepKey === "reputation_search"));

    const rerunResponse = await handleCommand(runtime, {
      text: `rerun step ${caseId} reputation_search`,
      channelId: "C1",
      threadTs: "800.000",
      messageTs: "800.002",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });
    assert.match(rerunResponse, /Requeued reputation_search/);

    const afterRerun = runtime.workflow.getCaseSnapshot(caseId!);
    const reputationStep = afterRerun.steps.find(
      (step) => step.stepKey === "reputation_search"
    );
    assert.equal(reputationStep?.status, "pending");
    assert.equal(
      afterRerun.facts.filter((fact) => fact.stepKey === "reputation_search").length,
      0
    );
    assert.equal(
      afterRerun.artifacts.filter((artifact) => artifact.stepKey === "reputation_search")
        .length,
      0
    );

    await runtime.runWorkerUntilIdle("test-worker-rerun");
    const rerunSnapshot = runtime.workflow.getCaseSnapshot(caseId!);
    assert.ok(
      rerunSnapshot.steps.some(
        (step) =>
          step.stepKey === "reputation_search" &&
          (step.status === "manual_review_required" || step.status === "passed")
      )
    );
  } finally {
    runtime.close();
  }
});

test("finalize case closes a no-task review state and records the final decision", async () => {
  const runtime = createRuntime("policy-bot-runtime-finalize-");

  try {
    const createResponse = await handleCommand(runtime, {
      text:
        'create case {"displayName":"Finalize Test","counterpartyKind":"individual","website":"https://example.com"}',
      channelId: "C1",
      threadTs: "600.000",
      messageTs: "600.001",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });
    const caseId = /Case ID:\s+(\S+)/.exec(createResponse)?.[1];
    assert.ok(caseId);

    await runtime.runWorkerUntilIdle("test-worker");
    let snapshot = runtime.workflow.getCaseSnapshot(caseId!);
    const reputationTask = snapshot.reviewTasks.find(
      (task) => task.stepKey === "reputation_search" && task.status === "open"
    );
    assert.ok(reputationTask);

    snapshot = await runtime.workflow.resolveReviewTask(
      reputationTask!.id,
      "concern",
      "Adverse search results require escalation."
    );

    for (const task of snapshot.reviewTasks.filter((task) => task.status === "open")) {
      snapshot = await runtime.workflow.resolveReviewTask(
        task.id,
        "clear",
        "Cleared."
      );
    }

    assert.equal(
      snapshot.reviewTasks.filter((task) => task.status === "open").length,
      0
    );
    assert.equal(snapshot.caseRecord.caseStatus, "awaiting_review");

    const finalizeResponse = await handleCommand(runtime, {
      text: "finalize case approved Final reviewer approved with caveats documented.",
      channelId: "C1",
      threadTs: "600.000",
      messageTs: "600.002",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });

    assert.match(finalizeResponse, /finalized case/i);
    const finalSnapshot = runtime.workflow.getCaseSnapshot(caseId!);
    assert.equal(finalSnapshot.caseRecord.caseStatus, "completed");
    assert.equal(finalSnapshot.caseRecord.recommendation, "approved");
    assert.equal(
      finalSnapshot.issues.filter((issue) => issue.status === "open").length,
      0
    );
  } finally {
    runtime.close();
  }
});

test("runWorkersUntilIdle can drain multiple queued cases with more than one worker", async () => {
  const runtime = createRuntime("policy-bot-runtime-multiworker-");

  try {
    await runtime.createCase({
      displayName: "Worker Case One",
      counterpartyKind: "individual",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: "https://example.com/one",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });
    await runtime.createCase({
      displayName: "Worker Case Two",
      counterpartyKind: "individual",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: "https://example.com/two",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const processed = await runtime.runWorkersUntilIdle("test-workers", 2);
    const snapshots = runtime.workflow.listCases(10).map((item) =>
      runtime.workflow.getCaseSnapshot(item.id)
    );

    assert.ok(processed >= 2);
    assert.ok(
      snapshots.every(
        (snapshot) =>
          snapshot.caseRecord.caseStatus === "awaiting_review" ||
          snapshot.caseRecord.caseStatus === "completed"
      )
    );
  } finally {
    runtime.close();
  }
});

test("enqueueJob deduplicates identical pending run-step jobs for the same case", async () => {
  const runtime = createRuntime("policy-bot-runtime-job-dedupe-");

  try {
    const snapshot = await runtime.createCase({
      displayName: "Dedupe Case",
      counterpartyKind: "individual",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: "https://example.com/dedupe",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const originalJobs = runtime.storage.listJobs(snapshot.caseRecord.id);
    assert.equal(originalJobs.length, 1);
    const originalPayload = JSON.parse(originalJobs[0]!.payloadJson) as {
      stepKey: string;
    };

    const duplicate = runtime.storage.enqueueJob({
      caseId: snapshot.caseRecord.id,
      kind: "run_step",
      payload: { stepKey: originalPayload.stepKey },
    });
    const jobsAfterDuplicate = runtime.storage.listJobs(snapshot.caseRecord.id);

    assert.equal(jobsAfterDuplicate.length, 1);
    assert.equal(duplicate.id, originalJobs[0]?.id);
  } finally {
    runtime.close();
  }
});

test("transient worker failures are retried automatically before blocking the case", async () => {
  const runtime = createRuntime("policy-bot-runtime-transient-retry-", {
    POLICY_BOT_JOB_RETRY_DELAY_MS: "1",
    POLICY_BOT_JOB_MAX_ATTEMPTS: "3",
  });

  try {
    const snapshot = await runtime.createCase({
      displayName: "Retry Case",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: "US",
      incorporationState: "DE",
      website: "https://example.com/retry",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    let attemptCount = 0;
    const connectors = (runtime.workflow as unknown as {
      connectors?: Map<
        string,
        {
          stepKey: string;
          execute: () => Promise<{
            status: "passed";
            note: string;
            facts: [];
            issues: [];
            reviewTasks: [];
          }>;
        }
      >;
    }).connectors;
    assert.ok(connectors);
    connectors!.set("public_market_shortcut", {
      stepKey: "public_market_shortcut",
      async execute() {
        attemptCount += 1;
        if (attemptCount === 1) {
          throw new Error("Navigation timeout while loading evidence page");
        }

        return {
          status: "passed",
          note: "Recovered after transient failure.",
          facts: [],
          issues: [],
          reviewTasks: [],
        };
      },
    });

    const firstProcessed = await runtime.runWorkerUntilIdle("retry-worker");
    assert.ok(firstProcessed >= 1);

    let finalSnapshot = runtime.workflow.getCaseSnapshot(snapshot.caseRecord.id);
    if (attemptCount === 1) {
      assert.equal(finalSnapshot.caseRecord.caseStatus, "in_progress");
      assert.equal(
        finalSnapshot.steps.find((step) => step.stepKey === "public_market_shortcut")
          ?.status,
        "pending"
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      const secondProcessed = await runtime.runWorkerUntilIdle("retry-worker");
      assert.ok(secondProcessed >= 1);
      finalSnapshot = runtime.workflow.getCaseSnapshot(snapshot.caseRecord.id);
    }

    const jobRecords = runtime.storage.listJobs(snapshot.caseRecord.id);

    assert.equal(attemptCount, 2);
    assert.ok(
      finalSnapshot.caseRecord.caseStatus === "awaiting_review" ||
        finalSnapshot.caseRecord.caseStatus === "completed"
    );
    assert.equal(jobRecords.filter((job) => job.status === "failed").length, 0);
    assert.equal(
      jobRecords.find((job) => /public_market_shortcut/.test(job.payloadJson))?.attempts,
      2
    );
    assert.equal(
      finalSnapshot.issues.some((issue) => /worker execution failed/i.test(issue.title)),
      false
    );
  } finally {
    runtime.close();
  }
});

test("worker failures surface as blocked steps and do not crash the drain", async () => {
  const runtime = createRuntime("policy-bot-runtime-worker-failure-");

  try {
    const snapshot = await runtime.createCase({
      displayName: "Failure Case",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: "US",
      incorporationState: "DE",
      website: "https://example.com/failure",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const connectors = (runtime.workflow as unknown as {
      connectors?: Map<string, { stepKey: string; execute: () => Promise<never> }>;
    }).connectors;
    assert.ok(connectors);
    connectors!.set("public_market_shortcut", {
      stepKey: "public_market_shortcut",
      async execute() {
        throw new Error("simulated connector failure");
      },
    });

    const processed = await runtime.runWorkerUntilIdle("test-worker");
    const finalSnapshot = runtime.workflow.getCaseSnapshot(snapshot.caseRecord.id);
    const failedJobs = runtime.storage
      .listJobs(snapshot.caseRecord.id)
      .filter((job) => job.status === "failed");

    assert.ok(processed >= 1);
    assert.equal(finalSnapshot.caseRecord.caseStatus, "blocked");
    assert.equal(finalSnapshot.caseRecord.recommendation, "blocked");
    assert.ok(
      finalSnapshot.issues.some((issue) =>
        /worker execution failed/i.test(issue.title)
      )
    );
    assert.equal(
      finalSnapshot.steps.find((step) => step.stepKey === "public_market_shortcut")?.status,
      "blocked"
    );
    assert.equal(failedJobs.length, 1);
  } finally {
    runtime.close();
  }
});

test("stale running jobs are reclaimed and completed on the next drain", async () => {
  const runtime = createRuntime("policy-bot-runtime-stale-job-", {
    POLICY_BOT_JOB_LOCK_TIMEOUT_MS: "1",
  });

  try {
    const snapshot = await runtime.createCase({
      displayName: "Stale Job Case",
      counterpartyKind: "individual",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: "https://example.com/stale",
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const claimed = runtime.storage.claimNextJob("stale-worker");
    assert.ok(claimed);

    const db = (runtime.storage as unknown as {
      db?: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } };
    }).db;
    assert.ok(db);
    db!
      .prepare("UPDATE jobs SET locked_at = ?, updated_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", claimed!.id);

    const processed = await runtime.runWorkerUntilIdle("recovery-worker");
    const finalSnapshot = runtime.workflow.getCaseSnapshot(snapshot.caseRecord.id);
    const runningJobs = runtime.storage
      .listJobs(snapshot.caseRecord.id)
      .filter((job) => job.status === "running");

    assert.ok(processed >= 1);
    assert.equal(runningJobs.length, 0);
    assert.ok(
      finalSnapshot.caseRecord.caseStatus === "awaiting_review" ||
        finalSnapshot.caseRecord.caseStatus === "completed"
    );
  } finally {
    runtime.close();
  }
});

test("handleSlackRequest accepts fenced JSON and supports show case in-thread", async () => {
  const runtime = createRuntime("policy-bot-runtime-fenced-");

  try {
    const createResponse = await handleCommand(runtime, {
      text: [
        "create case ```json",
        '{"displayName":"Acme Labs","counterpartyKind":"individual","website":"https://example.com"}',
        "```",
      ].join("\n"),
      channelId: "C1",
      threadTs: "200.000",
      messageTs: "200.001",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });

    const caseId = /Case ID:\s+(\S+)/.exec(createResponse)?.[1];
    assert.ok(caseId);

    const showResponse = await handleCommand(runtime, {
      text: "show case",
      channelId: "C1",
      threadTs: "200.000",
      messageTs: "200.002",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });

    assert.match(showResponse, new RegExp(caseId ?? ""));
    assert.match(showResponse, /facts:/i);
    assert.match(showResponse, /artifacts:/i);
    assert.match(showResponse, /reviewer packet:/i);
  } finally {
    runtime.close();
  }
});

test("update case can unblock a blocked entity-resolution case and requeue screening", async () => {
  const runtime = createRuntime("policy-bot-runtime-update-");
  const server = await startServer(
    "<html><body><h1>Example Entity LLC</h1><p>Company status: Active</p></body></html>"
  );

  try {
    const createResponse = await handleCommand(runtime, {
      text:
        'create case {"displayName":"Example Entity","counterpartyKind":"entity","incorporationCountry":"US","incorporationState":"DE"}',
      channelId: "C1",
      threadTs: "700.000",
      messageTs: "700.001",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });
    const caseId = /Case ID:\s+(\S+)/.exec(createResponse)?.[1];
    assert.ok(caseId);

    await runtime.runWorkerUntilIdle("test-worker");
    let snapshot = runtime.workflow.getCaseSnapshot(caseId!);
    assert.equal(snapshot.caseRecord.caseStatus, "blocked");
    assert.equal(snapshot.caseRecord.recommendation, "blocked");

    const updateResponse = await handleCommand(runtime, {
      text: `update case {"registrySearchUrl":"${server.url}"}`,
      channelId: "C1",
      threadTs: "700.000",
      messageTs: "700.002",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });
    assert.match(updateResponse, /updated case/i);

    await runtime.runWorkerUntilIdle("test-worker");
    snapshot = runtime.workflow.getCaseSnapshot(caseId!);
    assert.equal(
      snapshot.steps.find((step) => step.stepKey === "entity_resolution")?.status,
      "passed"
    );
    assert.equal(
      snapshot.steps.find((step) => step.stepKey === "good_standing")?.status,
      "manual_review_required"
    );
    assert.equal(snapshot.caseRecord.caseStatus, "awaiting_review");
    assert.equal(snapshot.caseRecord.recommendation, "manual_review");
  } finally {
    runtime.close();
    await server.close();
  }
});

test("handleSlackRequest rejects entity-only fields for individual cases", async () => {
  const runtime = createRuntime("policy-bot-runtime-individual-");

  try {
    const response = await handleCommand(runtime, {
      text:
        'create case {"displayName":"OpenAI","counterpartyKind":"individual","registrySearchUrl":"https://example.com/registry"}',
      channelId: "C1",
      threadTs: "300.000",
      messageTs: "300.001",
      actorId: "U1",
      actorLabel: "U1",
      threadHistory: [],
    });

    assert.match(response, /individuals should not include `registrySearchUrl`/i);
  } finally {
    runtime.close();
  }
});

async function startServer(body: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not expose an address");
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
