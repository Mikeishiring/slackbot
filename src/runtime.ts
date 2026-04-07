import { join } from "node:path";

import { LocalCaseExporter, formatHealthSnapshot, formatRetentionPruneResult } from "./admin.js";
import { LocalArtifactStore, LocalReportPublisher, PlaywrightCaptureService } from "./artifacts.js";
import { BraveSearchClient, GoogleCustomSearchClient, RemoteOfacDatasetClient, createDefaultConnectors, type OfacDatasetClient } from "./connectors.js";
import { AnthropicAdverseClassifier } from "./classifier.js";
import { GoogleDriveUploader } from "./drive.js";
import type { AppConfig } from "./config.js";
import { loadPolicyBundle } from "./policy.js";
import { PolicyBotStorage } from "./storage.js";
import type {
  CaseSnapshot,
  CaseExportResult,
  CreateCaseInput,
  HealthSnapshot,
  IssueRecord,
  PolicyBundle,
  ReportRecord,
  ReviewOutcome,
  ReviewTaskRecord,
  RetentionPruneResult,
  UpdateCaseScreeningInput,
  WorkflowStepKey,
  WorkflowStepStatus,
} from "./types.js";
import type { ToolContext } from "./tools.js";
import { asNullableString } from "./utils.js";
import { PolicyWorkflow } from "./workflow.js";

export interface RuntimeOverrides {
  datasetClient?: OfacDatasetClient;
  captureEnabled?: boolean;
}

export interface SlackControllerRequest {
  text: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  actorId: string | null;
  actorLabel: string | null;
  threadHistory: string[];
}

export type StepCompleteNotifier = (
  caseId: string,
  stepKey: WorkflowStepKey,
  status: WorkflowStepStatus,
  summary: string
) => Promise<void>;

class UserCommandError extends Error {}

export class PolicyBotRuntime {
  public readonly policy: PolicyBundle;
  public readonly storage: PolicyBotStorage;
  public readonly artifactStore: LocalArtifactStore;
  public readonly captureService: PlaywrightCaptureService | null;
  public readonly workflow: PolicyWorkflow;
  public readonly exporter: LocalCaseExporter;
  public slackBot: import("./slack.js").SlackBotHandle | null = null;

  public constructor(
    private readonly config: AppConfig,
    private readonly overrides: RuntimeOverrides = {}
  ) {
    this.policy = loadPolicyBundle(this.config.policyDirectory);
    this.storage = new PolicyBotStorage(this.config.databasePath);
    this.artifactStore = new LocalArtifactStore(
      this.storage,
      this.config.artifactRoot,
      this.config.reportRoot
    );
    this.captureService =
      this.overrides.captureEnabled === false
        ? null
        : new PlaywrightCaptureService(
            this.artifactStore,
            this.config.browserHeadless
          );
    this.workflow = new PolicyWorkflow(
      this.storage,
      this.policy,
      createDefaultConnectors(
        this.overrides.datasetClient ??
          new RemoteOfacDatasetClient(
            join(this.config.dataDirectory, "ofac-dataset-cache.json"),
            this.config.ofacDatasetUrls ?? undefined
          ),
        {
          cacheDirectory: this.config.entityEvidenceCacheDirectory,
          cacheTtlMs: this.config.entityEvidenceCacheHours * 60 * 60 * 1000,
          browserAttempts: this.config.entityEvidenceBrowserAttempts,
          browserWaitMs: this.config.entityEvidenceBrowserWaitMs,
          loadTimeoutMs: this.config.entityEvidenceLoadTimeoutMs,
        }
      ),
      this.artifactStore,
      this.captureService,
      new LocalReportPublisher(
        this.storage,
        this.artifactStore,
        this.config.googleDriveServiceAccountKey && this.config.googleDriveFolderId
          ? new GoogleDriveUploader(
              this.config.googleDriveServiceAccountKey,
              this.config.googleDriveFolderId
            )
          : null
      ),
      {
        jobMaxAttempts: this.config.jobMaxAttempts,
        jobRetryDelayMs: this.config.jobRetryDelayMs,
        jobLockTimeoutMs: this.config.jobLockTimeoutMs,
      },
      this.config.braveSearchApiKey
        ? new BraveSearchClient(this.config.braveSearchApiKey)
        : this.config.googleSearchApiKey && this.config.googleSearchEngineId
          ? new GoogleCustomSearchClient(
              this.config.googleSearchApiKey,
              this.config.googleSearchEngineId
            )
          : null,
      this.config.anthropicApiKey
        ? new AnthropicAdverseClassifier(this.config.anthropicApiKey)
        : null
    );
    this.exporter = new LocalCaseExporter(this.artifactStore, this.config.exportRoot);
  }

  public setNotifier(notifier: StepCompleteNotifier): void {
    this.workflow.setOnStepComplete(notifier);
  }

  public close(): void {
    this.storage.close();
  }

  public async handleSlackRequest(
    request: SlackControllerRequest,
    respond: (text: string, threadHistory: string[], context: ToolContext) => Promise<string>
  ): Promise<string> {
    const linkedCase = this.storage.findCaseByThread(request.channelId, request.threadTs);
    this.storage.appendMessage({
      caseId: linkedCase?.id ?? null,
      direction: "inbound",
      transport: "slack",
      channelId: request.channelId,
      threadTs: request.threadTs,
      externalMessageId: request.messageTs,
      actorId: request.actorId,
      actorLabel: request.actorLabel,
      body: request.text,
    });

    const context = {
      threadCaseId: linkedCase?.id ?? null,
      channelId: request.channelId,
      threadTs: request.threadTs,
      actorId: request.actorId,
      reviewerUserIds: this.config.reviewerUserIds ?? null,
      slackBot: this.slackBot ?? null,
    };

    let response: string;
    try {
      response = await respond(request.text, request.threadHistory, context);
    } catch (error) {
      console.error("Claude respond failed", error);
      response = "I hit an unexpected error processing that. Please try again.";
    }

    const finalCaseId =
      linkedCase?.id ??
      this.storage.findCaseByThread(request.channelId, request.threadTs)?.id ??
      null;
    this.storage.appendMessage({
      caseId: finalCaseId,
      direction: "outbound",
      transport: "slack",
      channelId: request.channelId,
      threadTs: request.threadTs,
      externalMessageId: null,
      actorId: "policy-bot",
      actorLabel: "Policy Bot",
      body: response,
    });

    return response;
  }

  public async runWorkerUntilIdle(workerId = "policy-bot-worker"): Promise<number> {
    return this.workflow.runUntilIdle(workerId);
  }

  public async runWorkersUntilIdle(
    workerPrefix = "policy-bot-worker",
    workerCount = this.config.batchWorkerCount
  ): Promise<number> {
    return this.workflow.runUntilIdleConcurrent(workerPrefix, workerCount);
  }

  public getHealthSnapshot(): HealthSnapshot {
    return this.storage.buildHealthSnapshot();
  }

  public async exportCase(caseId: string): Promise<CaseExportResult> {
    const snapshot = this.workflow.getCaseSnapshot(caseId);
    const result = await this.exporter.exportCase(
      snapshot,
      this.storage.listAuditEvents(caseId)
    );
    this.storage.recordAuditEvent({
      caseId,
      eventType: "case.exported",
      actorType: "system",
      actorId: null,
      payload: {
        bundleDirectory: result.bundleDirectory,
        manifestPath: result.manifestPath,
      },
    });
    return result;
  }

  public async rebuildCaseReport(caseId: string): Promise<CaseSnapshot> {
    const snapshot = await this.workflow.rebuildCaseReport(caseId);
    this.storage.recordAuditEvent({
      caseId,
      eventType: "report.rebuilt",
      actorType: "system",
      actorId: null,
      payload: {
        reportCount: snapshot.reports.length,
        artifactCount: snapshot.artifacts.length,
      },
    });
    return snapshot;
  }

  public async createCase(input: CreateCaseInput): Promise<CaseSnapshot> {
    validateCreateCaseInput(input);
    return this.workflow.createCase(input);
  }

  public async pruneRetention(
    retentionDays = this.config.retentionDays
  ): Promise<RetentionPruneResult> {
    const baseResult = this.storage.pruneRetention(retentionDays);
    const expiredArtifacts = this.storage.listArtifactsBefore(baseResult.cutoff);
    const deletedArtifacts = expiredArtifacts.length;
    await this.artifactStore.deleteArtifacts(expiredArtifacts);
    const deletedReports = this.storage.deleteReportsBefore(baseResult.cutoff);
    const deletedExports = await this.exporter.pruneExportsBefore(baseResult.cutoff);

    this.storage.recordAuditEvent({
      caseId: null,
      eventType: "retention.pruned.assets",
      actorType: "system",
      actorId: null,
      payload: {
        cutoff: baseResult.cutoff,
        deletedArtifacts,
        deletedReports,
        deletedExports,
      },
    });

    return {
      ...baseResult,
      deletedArtifacts,
      deletedReports,
      deletedExports,
    };
  }

  public async resolveReviewTask(
    taskId: string,
    outcome: ReviewOutcome,
    notes: string,
    actorId: string | null
  ): Promise<CaseSnapshot> {
    const task = this.storage.getReviewTask(taskId);
    const snapshot = await this.workflow.resolveReviewTask(taskId, outcome, notes);
    this.storage.recordAuditEvent({
      caseId: task.caseId,
      eventType: "review.resolved",
      actorType: "user",
      actorId,
      payload: {
        reviewTaskId: taskId,
        stepKey: task.stepKey,
        outcome,
        notes,
      },
    });
    return snapshot;
  }

  /** Create a command-based responder for testing and CLI compatibility. */
  public createCommandResponder(): (
    text: string,
    threadHistory: string[],
    context: ToolContext
  ) => Promise<string> {
    return async (text, _threadHistory, context) => {
      try {
        return await this.dispatchCommand(
          {
            text,
            channelId: context.channelId,
            threadTs: context.threadTs,
            messageTs: "",
            actorId: context.actorId,
            actorLabel: context.actorId,
            threadHistory: [],
          },
          context.threadCaseId
        );
      } catch (error) {
        if (error instanceof UserCommandError) {
          return error.message;
        }
        throw error;
      }
    };
  }

  private async dispatchCommand(
    request: SlackControllerRequest,
    threadCaseId: string | null
  ): Promise<string> {
    const text = request.text.trim();
    const lower = text.toLowerCase();

    if (lower === "help") {
      return buildHelpText();
    }

    if (lower === "health") {
      return formatHealthSnapshot(this.getHealthSnapshot());
    }

    if (lower.startsWith("create case ")) {
      const payload = text.slice("create case ".length);
      const snapshot = await this.createCaseFromJson(
        payload,
        request.channelId,
        request.threadTs,
        request.actorId
      );
      return formatCaseSummary(snapshot, true, this.artifactStore);
    }

    if (lower.startsWith("update case ")) {
      const parsed = parseUpdateCaseCommand(
        text.slice("update case ".length),
        threadCaseId
      );
      const snapshot = await this.updateCaseFromJson(
        parsed.caseId,
        parsed.payload,
        request.actorId
      );
      return [
        `Updated case ${parsed.caseId} and requeued screening.`,
        formatCaseSummary(snapshot, false, this.artifactStore),
      ].join("\n");
    }

    const listCasesMatch = /^list cases(?:\s+(\d+))?$/i.exec(text);
    if (listCasesMatch) {
      const limit = listCasesMatch[1] ? parsePositiveInteger(listCasesMatch[1], "limit") : 10;
      const cases = this.workflow.listCases(limit);
      return cases.length === 0
        ? "No cases yet."
        : cases
            .map(
              (item) =>
                `- ${item.id}: ${item.displayName} (${item.caseStatus} / ${item.recommendation})`
            )
            .join("\n");
    }

    const reviewQueueMatch = /^review queue(?:\s+(\S+))?$/i.exec(text);
    if (reviewQueueMatch) {
      const caseId = reviewQueueMatch[1]?.trim() || threadCaseId || undefined;
      return formatReviewQueue(this.workflow.listReviewTasks(caseId));
    }

    const runJobsMatch = /^run jobs(?:\s+(\d+))?$/i.exec(text);
    if (runJobsMatch) {
      const workers = runJobsMatch[1]
        ? parsePositiveInteger(runJobsMatch[1], "workers")
        : this.config.batchWorkerCount;
      const processed =
        workers === 1
          ? await this.runWorkerUntilIdle("slack-manual")
          : await this.runWorkersUntilIdle("slack-manual", workers);
      return `Processed ${processed} queued job(s) with ${workers} worker(s).`;
    }

    const listJobsMatch = /^list jobs(?:\s+(\S+))?$/i.exec(text);
    if (listJobsMatch) {
      const caseId = listJobsMatch[1]?.trim() || threadCaseId || undefined;
      return formatJobs(this.storage.listJobs(caseId));
    }

    if (lower === "status") {
      if (!threadCaseId) {
        return "This thread is not linked to a case yet.";
      }
      return formatCaseSummary(
        this.workflow.getCaseSnapshot(threadCaseId),
        false,
        this.artifactStore
      );
    }

    if (lower === "show case") {
      if (!threadCaseId) {
        throw new UserCommandError(
          "No case is linked to this thread. Use `show case CASE_ID` or create a case here first."
        );
      }
      return formatCaseSummary(
        this.workflow.getCaseSnapshot(threadCaseId),
        false,
        this.artifactStore
      );
    }

    if (lower.startsWith("show case ")) {
      const caseId = text.slice("show case ".length).trim();
      if (!caseId) {
        throw new UserCommandError("Usage: show case CASE_ID");
      }
      return formatCaseSummary(
        this.workflow.getCaseSnapshot(caseId),
        false,
        this.artifactStore
      );
    }

    const reviewPacketMatch = /^review packet(?:\s+(\S+))?$/i.exec(text);
    if (reviewPacketMatch) {
      const caseId = reviewPacketMatch[1]?.trim() || threadCaseId;
      if (!caseId) {
        throw new UserCommandError(
          "No case is linked to this thread. Use `review packet CASE_ID` or run it inside a case thread."
        );
      }
      return formatReviewerHandoff(
        this.workflow.getCaseSnapshot(caseId),
        this.artifactStore
      );
    }

    if (lower.startsWith("show review ")) {
      const taskId = text.slice("show review ".length).trim();
      if (!taskId) {
        throw new UserCommandError("Usage: show review REVIEW_ID");
      }
      const task = this.storage.getReviewTask(taskId);
      return formatReviewTaskDetail(
        task,
        this.workflow.getCaseSnapshot(task.caseId),
        this.artifactStore
      );
    }

    if (lower.startsWith("finalize case ")) {
      const payload = text.slice("finalize case ".length).trim();
      const parsed = parseFinalizeCaseCommand(payload, threadCaseId);
      const snapshot = await this.workflow.finalizeCaseDecision(
        parsed.caseId,
        parsed.recommendation,
        parsed.notes
      );
      this.storage.recordAuditEvent({
        caseId: parsed.caseId,
        eventType: "case.finalized",
        actorType: "user",
        actorId: request.actorId,
        payload: {
          recommendation: parsed.recommendation,
          notes: parsed.notes,
        },
      });
      return [
        `Finalized case ${parsed.caseId} as ${parsed.recommendation}.`,
        formatCaseSummary(snapshot, false, this.artifactStore),
      ].join("\n");
    }

    const rebuildReportMatch = /^rebuild report(?:\s+(\S+))?$/i.exec(text);
    if (rebuildReportMatch) {
      const caseId = rebuildReportMatch[1]?.trim() || threadCaseId;
      if (!caseId) {
        throw new UserCommandError(
          "No case is linked to this thread. Use `rebuild report CASE_ID` or run it inside a case thread."
        );
      }
      const snapshot = await this.rebuildCaseReport(caseId);
      return [
        `Rebuilt reports for ${snapshot.caseRecord.id}.`,
        formatCaseSummary(snapshot, false, this.artifactStore),
      ].join("\n");
    }

    const exportCaseMatch = /^export case(?:\s+(\S+))?$/i.exec(text);
    if (exportCaseMatch) {
      const caseId = exportCaseMatch[1]?.trim() || threadCaseId;
      if (!caseId) {
        throw new UserCommandError(
          "No case is linked to this thread. Use `export case CASE_ID` or run it inside a case thread."
        );
      }
      const result = await this.exportCase(caseId);
      return [
        `Exported case ${result.caseId}.`,
        `Bundle directory: ${result.bundleDirectory}`,
        `Manifest: ${result.manifestPath}`,
      ].join("\n");
    }

    const pruneRetentionMatch = /^prune retention(?:\s+(\d+))?$/i.exec(text);
    if (pruneRetentionMatch) {
      const retentionDays = pruneRetentionMatch[1]
        ? parsePositiveInteger(pruneRetentionMatch[1], "retentionDays")
        : this.config.retentionDays;
      return formatRetentionPruneResult(await this.pruneRetention(retentionDays));
    }

    if (lower.startsWith("resolve review ")) {
      const match =
        /^resolve review\s+(\S+)\s+(clear|concern|reject)\s+([\s\S]+)$/i.exec(
          text
        );
      if (!match) {
        throw new UserCommandError(
          "Usage: resolve review REVIEW_ID clear|concern|reject notes..."
        );
      }

      const taskId = match[1];
      const outcomeValue = match[2];
      const notes = match[3];
      if (!taskId || !outcomeValue || !notes) {
        throw new UserCommandError(
          "Usage: resolve review REVIEW_ID clear|concern|reject notes..."
        );
      }
      const snapshot = await this.resolveReviewTask(
        taskId,
        outcomeValue.toLowerCase() as ReviewOutcome,
        notes.trim(),
        request.actorId
      );
      return formatCaseSummary(snapshot, false, this.artifactStore);
    }

    for (const action of [
      { prefix: "clear review ", outcome: "clear" as const },
      { prefix: "concern review ", outcome: "concern" as const },
      { prefix: "reject review ", outcome: "reject" as const },
    ]) {
      if (lower.startsWith(action.prefix)) {
        const payload = text.slice(action.prefix.length).trim();
        const firstSpace = payload.indexOf(" ");
        if (firstSpace === -1) {
          throw new UserCommandError(
            `Usage: ${action.prefix.trim()} REVIEW_ID notes...`
          );
        }
        const taskId = payload.slice(0, firstSpace).trim();
        const notes = payload.slice(firstSpace + 1).trim();
        if (!taskId || !notes) {
          throw new UserCommandError(
            `Usage: ${action.prefix.trim()} REVIEW_ID notes...`
          );
        }
        const snapshot = await this.resolveReviewTask(
          taskId,
          action.outcome,
          notes,
          request.actorId
        );
        return formatCaseSummary(snapshot, false, this.artifactStore);
      }
    }

    const rerunStepMatch = /^rerun step(?:\s+(\S+))?\s+(public_market_shortcut|entity_resolution|good_standing|reputation_search|bbb_review|ofac_precheck|ofac_search)$/i.exec(
      text
    );
    if (rerunStepMatch) {
      const caseId = rerunStepMatch[1]?.trim() || threadCaseId;
      const stepKey = rerunStepMatch[2]?.trim() as WorkflowStepKey | undefined;
      if (!caseId || !stepKey) {
        throw new UserCommandError(
          "Usage: rerun step [CASE_ID] STEP_KEY"
        );
      }
      const snapshot = await this.workflow.rerunStep(caseId, stepKey);
      this.storage.recordAuditEvent({
        caseId,
        eventType: "step.rerun",
        actorType: "user",
        actorId: request.actorId,
        payload: {
          stepKey,
        },
      });
      return [
        `Requeued ${stepKey} for case ${caseId}.`,
        formatCaseSummary(snapshot, false, this.artifactStore),
      ].join("\n");
    }

    return "Unknown command. Send `help` for supported commands.";
  }

  private async createCaseFromJson(
    payload: string,
    channelId: string,
    threadTs: string,
    actorId: string | null
  ): Promise<CaseSnapshot> {
    const parsed = parseCreateCaseJson(payload);
    const input: CreateCaseInput = {
      displayName: requireString(parsed.displayName, "displayName"),
      counterpartyKind: requireCounterpartyKind(parsed.counterpartyKind),
      legalName: asNullableString(parsed.legalName),
      incorporationCountry: asNullableString(parsed.incorporationCountry),
      incorporationState: asNullableString(parsed.incorporationState),
      website: asNullableString(parsed.website),
      registrySearchUrl: asNullableString(parsed.registrySearchUrl),
      publicListingUrl: asNullableString(parsed.publicListingUrl),
      exchangeName: asNullableString(parsed.exchangeName),
      stockSymbol: asNullableString(parsed.stockSymbol),
      requestedBy: actorId,
      notes: asNullableString(parsed.notes),
      slackChannelId: channelId,
      slackThreadTs: threadTs,
    };
    validateCreateCaseInput(input);

    const snapshot = await this.workflow.createCase(input);
    this.storage.bindCaseToThread(snapshot.caseRecord.id, channelId, threadTs);
    return this.workflow.getCaseSnapshot(snapshot.caseRecord.id);
  }

  private async updateCaseFromJson(
    caseId: string,
    payload: string,
    actorId: string | null
  ): Promise<CaseSnapshot> {
    const parsed = parseUpdateCaseJson(payload);
    const input = readUpdateCaseInput(parsed);
    const existing = this.workflow.getCaseSnapshot(caseId).caseRecord;
    const mergedInput: CreateCaseInput = {
      displayName: existing.displayName,
      counterpartyKind: existing.counterpartyKind,
      legalName: input.legalName === undefined ? existing.legalName : input.legalName,
      incorporationCountry:
        input.incorporationCountry === undefined
          ? existing.incorporationCountry
          : input.incorporationCountry,
      incorporationState:
        input.incorporationState === undefined
          ? existing.incorporationState
          : input.incorporationState,
      website: input.website === undefined ? existing.website : input.website,
      registrySearchUrl:
        input.registrySearchUrl === undefined
          ? existing.registrySearchUrl
          : input.registrySearchUrl,
      publicListingUrl:
        input.publicListingUrl === undefined
          ? existing.publicListingUrl
          : input.publicListingUrl,
      exchangeName:
        input.exchangeName === undefined ? existing.exchangeName : input.exchangeName,
      stockSymbol:
        input.stockSymbol === undefined ? existing.stockSymbol : input.stockSymbol,
      requestedBy: existing.requestedBy,
      notes: input.notes === undefined ? existing.notes : input.notes,
      slackChannelId: existing.slackChannelId,
      slackThreadTs: existing.slackThreadTs,
    };
    validateCreateCaseInput(mergedInput);

    const snapshot = await this.workflow.updateCaseScreeningInput(caseId, input);
    this.storage.recordAuditEvent({
      caseId,
      eventType: "case.updated",
      actorType: "user",
      actorId,
      payload: { ...input },
    });
    return snapshot;
  }
}

function formatCaseSummary(
  snapshot: CaseSnapshot,
  includeCreated: boolean,
  artifactStore?: LocalArtifactStore
): string {
  const openReviewTasks = snapshot.reviewTasks.filter((task) => task.status === "open");
  const openIssues = snapshot.issues.filter((issue) => issue.status === "open");
  const factSourceGaps = snapshot.facts.filter((fact) => {
    const hasEvidence = fact.evidenceIds.some((evidenceId) =>
      snapshot.artifacts.some((artifact) => artifact.id === evidenceId)
    );
    const hasUrlSource = /https?:\/\//i.test(fact.valueJson);
    return !hasEvidence && !hasUrlSource;
  }).length;
  const lines = [
    `*${snapshot.caseRecord.displayName}*`,
    `Case ID: ${snapshot.caseRecord.id}`,
    `Status: ${snapshot.caseRecord.caseStatus}`,
    `Recommendation: ${snapshot.caseRecord.recommendation}`,
  ];

  if (includeCreated) {
    lines.push("Case created and queued for processing.");
  }

  if (snapshot.caseRecord.decisionSummary) {
    lines.push(`Decision summary: ${snapshot.caseRecord.decisionSummary}`);
  }

  if (snapshot.caseRecord.legalName) {
    lines.push(`Legal name: ${snapshot.caseRecord.legalName}`);
  }
  if (snapshot.caseRecord.incorporationCountry) {
    lines.push(
      `Jurisdiction: ${snapshot.caseRecord.incorporationState ? `${snapshot.caseRecord.incorporationState}, ` : ""}${snapshot.caseRecord.incorporationCountry}`
    );
  }
  if (snapshot.caseRecord.registrySearchUrl) {
    lines.push(`Registry URL: ${snapshot.caseRecord.registrySearchUrl}`);
  }

  if (artifactStore) {
    const workingReport = readReportPath(snapshot, artifactStore, "working");
    const traceabilityReport = readReportPath(
      snapshot,
      artifactStore,
      "traceability"
    );
    const reviewerPacketReport = readReportPath(
      snapshot,
      artifactStore,
      "review_packet"
    );
    if (workingReport) {
      lines.push(
        `Working report: ${workingReport.path} (v${workingReport.report.versionNumber})`
      );
    }
    if (traceabilityReport) {
      lines.push(
        `Traceability manifest: ${traceabilityReport.path} (v${traceabilityReport.report.versionNumber})`
      );
    }
    if (reviewerPacketReport) {
      lines.push(
        `Reviewer packet: ${reviewerPacketReport.path} (v${reviewerPacketReport.report.versionNumber})`
      );
    }
  }

  lines.push(
    `Open review tasks: ${openReviewTasks.length}`,
    `Open issues: ${openIssues.length}`,
    `Source-gap facts: ${factSourceGaps}`,
    `Facts: ${snapshot.facts.length}`,
    `Artifacts: ${snapshot.artifacts.length}`,
    `Reports: ${snapshot.reports.length}`,
    `Steps: ${snapshot.steps
      .map((step) => `${step.stepKey}=${step.status}`)
      .join(", ")}`
  );

  if (openReviewTasks.length > 0) {
    lines.push("Open review tasks:");
    lines.push(...openReviewTasks.map((task) => `- ${task.id}: ${task.title} [${task.stepKey}]`));
    if (artifactStore) {
      const stageReportLines = listOpenReviewStageReportPaths(snapshot, artifactStore);
      if (stageReportLines.length > 0) {
        lines.push("Review stage reports:");
        lines.push(...stageReportLines.map((line) => `- ${line}`));
      }
    }
  }

  if (openIssues.length > 0) {
    lines.push("Open issues:");
    lines.push(...openIssues.slice(0, 5).map(formatIssueSummary));
  }

  return lines.join("\n");
}

function formatReviewerHandoff(
  snapshot: CaseSnapshot,
  artifactStore: LocalArtifactStore
): string {
  const reviewerPacket = readReportPath(snapshot, artifactStore, "review_packet");
  const workingReport = readReportPath(snapshot, artifactStore, "working");
  const finalReport = readReportPath(snapshot, artifactStore, "final");
  const traceability = readReportPath(snapshot, artifactStore, "traceability");
  const openReviewTasks = snapshot.reviewTasks.filter((task) => task.status === "open");
  const lines = [
    `Reviewer handoff for ${snapshot.caseRecord.displayName}`,
    `Case ID: ${snapshot.caseRecord.id}`,
    `Status: ${snapshot.caseRecord.caseStatus}`,
    `Recommendation snapshot: ${snapshot.caseRecord.recommendation}`,
  ];

  if (reviewerPacket) {
    lines.push(
      `Reviewer packet: ${reviewerPacket.path} (v${reviewerPacket.report.versionNumber})`
    );
  }
  if (workingReport) {
    lines.push(
      `Working report: ${workingReport.path} (v${workingReport.report.versionNumber})`
    );
  }
  if (finalReport) {
    lines.push(`Final PDF: ${finalReport.path} (v${finalReport.report.versionNumber})`);
  }
  if (traceability) {
    lines.push(
      `Traceability manifest: ${traceability.path} (v${traceability.report.versionNumber})`
    );
  }

  if (openReviewTasks.length === 0) {
    lines.push("Open review tasks: 0");
  } else {
    lines.push("Open review tasks:");
    lines.push(
      ...openReviewTasks.map(
        (task) => `- ${task.id}: ${task.title} [${task.stepKey}]`
      )
    );
  }

  const stageReportLines = listOpenReviewStageReportPaths(snapshot, artifactStore);
  if (stageReportLines.length > 0) {
    lines.push("Stage reports:");
    lines.push(...stageReportLines.map((line) => `- ${line}`));
  }

  return lines.join("\n");
}

function readReportPath(
  snapshot: CaseSnapshot,
  artifactStore: LocalArtifactStore,
  kind: "working" | "final" | "review_packet" | "traceability"
): { report: ReportRecord; path: string } | null {
  const report = snapshot.reports.find(
    (candidate) => candidate.kind === kind && candidate.isCurrent
  );
  if (!report?.artifactId) {
    return null;
  }
  const artifact = snapshot.artifacts.find(
    (candidate) => candidate.id === report.artifactId
  );
  return artifact
    ? {
        report,
        path: artifactStore.resolveAbsolutePath(artifact),
      }
    : null;
}

function listOpenReviewStageReportPaths(
  snapshot: CaseSnapshot,
  artifactStore: LocalArtifactStore
): string[] {
  const openStepKeys = new Set(
    snapshot.reviewTasks
      .filter((task) => task.status === "open")
      .map((task) => task.stepKey)
  );
  return snapshot.artifacts
    .filter((artifact) => {
      if (
        artifact.storageBackend !== "local-report" ||
        artifact.stepKey === "report" ||
        !openStepKeys.has(artifact.stepKey)
      ) {
        return false;
      }
      try {
        return JSON.parse(artifact.metadataJson).reportType === "step";
      } catch {
        return false;
      }
    })
    .map(
      (artifact) =>
        `${artifact.stepKey}: ${artifactStore.resolveAbsolutePath(artifact)}`
    );
}

function formatReviewQueue(tasks: ReviewTaskRecord[]): string {
  const openTasks = tasks.filter((task) => task.status === "open");
  if (openTasks.length === 0) {
    return "Review queue is empty.";
  }

  return openTasks
    .map(
      (task) =>
        `- ${task.id}: ${task.title} [${task.stepKey}] case=${task.caseId}`
    )
    .join("\n");
}

function formatReviewTaskDetail(
  task: ReviewTaskRecord,
  snapshot: CaseSnapshot,
  artifactStore: LocalArtifactStore
): string {
  const stageReport = snapshot.artifacts.find((artifact) => {
    if (
      artifact.storageBackend !== "local-report" ||
      artifact.stepKey !== task.stepKey
    ) {
      return false;
    }
    try {
      return JSON.parse(artifact.metadataJson).reportType === "step";
    } catch {
      return false;
    }
  });
  const evidenceArtifacts = snapshot.artifacts
    .filter(
      (artifact) =>
        artifact.stepKey === task.stepKey && artifact.storageBackend !== "local-report"
    )
    .slice(0, 3);

  return [
    `Review task ${task.id}`,
    `- Case: ${task.caseId}`,
    `- Step: ${task.stepKey}`,
    `- Status: ${task.status}`,
    `- Title: ${task.title}`,
    `- Instructions: ${task.instructions}`,
    `- Stage report: ${
      stageReport ? artifactStore.resolveAbsolutePath(stageReport) : "none"
    }`,
    `- Evidence files: ${
      evidenceArtifacts.length === 0
        ? "none"
        : evidenceArtifacts
            .map((artifact) => artifactStore.resolveAbsolutePath(artifact))
            .join("; ")
    }`,
    `- Resolve with: clear review | concern review | reject review`,
  ].join("\n");
}

function formatJobs(
  jobs: Array<{
    id: string;
    caseId: string | null;
    kind: string;
    status: string;
    attempts: number;
    lastError: string | null;
    runAfter?: string;
    lockedBy?: string | null;
  }>
): string {
  if (jobs.length === 0) {
    return "No jobs found.";
  }

  return jobs
    .map(
      (job) =>
        `- ${job.id}: ${job.kind} status=${job.status} case=${job.caseId ?? "none"} attempts=${job.attempts}${job.lockedBy ? ` worker=${job.lockedBy}` : ""}${job.runAfter ? ` run_after=${job.runAfter}` : ""}${job.lastError ? ` error=${job.lastError}` : ""}`
    )
    .join("\n");
}



function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new UserCommandError(`${field} must be a non-empty string`);
  }

  return value.trim();
}

function requireCounterpartyKind(value: unknown): CreateCaseInput["counterpartyKind"] {
  if (value === "entity" || value === "individual") {
    return value;
  }

  throw new UserCommandError("counterpartyKind must be 'entity' or 'individual'");
}

function parseCreateCaseJson(payload: string): Record<string, unknown> {
  const normalized = stripOptionalCodeFence(payload);
  try {
    return JSON.parse(normalized) as Record<string, unknown>;
  } catch (error) {
    throw new UserCommandError(
      `Invalid JSON for \`create case\`: ${
        error instanceof Error ? error.message : "Unable to parse payload."
      }`
    );
  }
}

function parseUpdateCaseJson(payload: string): Record<string, unknown> {
  const normalized = stripOptionalCodeFence(payload);
  try {
    return JSON.parse(normalized) as Record<string, unknown>;
  } catch (error) {
    throw new UserCommandError(
      `Invalid JSON for \`update case\`: ${
        error instanceof Error ? error.message : "Unable to parse payload."
      }`
    );
  }
}

function stripOptionalCodeFence(payload: string): string {
  const trimmed = payload.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function validateCreateCaseInput(input: CreateCaseInput): void {
  for (const [field, value] of [
    ["website", input.website],
    ["registrySearchUrl", input.registrySearchUrl],
    ["publicListingUrl", input.publicListingUrl],
  ] as const) {
    if (value) {
      assertHttpUrl(value, field);
    }
  }

  if (input.counterpartyKind === "individual") {
    if (input.registrySearchUrl) {
      throw new UserCommandError(
        "Individuals should not include `registrySearchUrl`; that field only applies to entity checks."
      );
    }
    if (input.publicListingUrl || input.exchangeName || input.stockSymbol) {
      throw new UserCommandError(
        "Individuals cannot use the public-market shortcut fields (`publicListingUrl`, `exchangeName`, `stockSymbol`)."
      );
    }
  }

  if ((input.publicListingUrl && !input.exchangeName) || (!input.publicListingUrl && input.exchangeName)) {
    throw new UserCommandError(
      "`publicListingUrl` and `exchangeName` must be supplied together when using the public-market shortcut."
    );
  }
}

function readUpdateCaseInput(parsed: Record<string, unknown>): UpdateCaseScreeningInput {
  const allowedKeys = new Set([
    "legalName",
    "incorporationCountry",
    "incorporationState",
    "website",
    "registrySearchUrl",
    "publicListingUrl",
    "exchangeName",
    "stockSymbol",
    "notes",
  ]);

  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) {
      throw new UserCommandError(`Unknown update field: ${key}`);
    }
  }

  const input: UpdateCaseScreeningInput = {};
  assignNullableUpdateField(input, "legalName", parsed);
  assignNullableUpdateField(input, "incorporationCountry", parsed);
  assignNullableUpdateField(input, "incorporationState", parsed);
  assignNullableUpdateField(input, "website", parsed);
  assignNullableUpdateField(input, "registrySearchUrl", parsed);
  assignNullableUpdateField(input, "publicListingUrl", parsed);
  assignNullableUpdateField(input, "exchangeName", parsed);
  assignNullableUpdateField(input, "stockSymbol", parsed);
  assignNullableUpdateField(input, "notes", parsed);

  if (Object.values(input).every((value) => value === undefined)) {
    throw new UserCommandError("`update case` requires at least one supported field.");
  }

  for (const [field, value] of [
    ["website", input.website],
    ["registrySearchUrl", input.registrySearchUrl],
    ["publicListingUrl", input.publicListingUrl],
  ] as const) {
    if (value) {
      assertHttpUrl(value, field);
    }
  }

  return input;
}

function readNullableUpdateField(
  parsed: Record<string, unknown>,
  field: keyof UpdateCaseScreeningInput
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(parsed, field)) {
    return undefined;
  }

  const value = parsed[field];
  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    return value.trim();
  }

  throw new UserCommandError(`${field} must be a string or null`);
}

function assignNullableUpdateField(
  target: UpdateCaseScreeningInput,
  field: keyof UpdateCaseScreeningInput,
  parsed: Record<string, unknown>
): void {
  const value = readNullableUpdateField(parsed, field);
  if (value !== undefined) {
    target[field] = value;
  }
}

function assertHttpUrl(value: string, field: string): void {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return;
    }
  } catch {
    // Fall through to the user-facing error.
  }

  throw new UserCommandError(`${field} must be a valid http(s) URL`);
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UserCommandError(`${field} must be a positive integer`);
  }

  return parsed;
}

function buildHelpText(): string {
  return [
    "Commands:",
    "- `health`",
    "- `create case {json}`",
    "- `update case [CASE_ID] {json}`",
    "- `show case`",
    "- `show case CASE_ID`",
    "- `list cases [limit]`",
    "- `review queue [CASE_ID]`",
    "- `show review REVIEW_ID`",
    "- `review packet [CASE_ID]`",
    "- `list jobs [CASE_ID]`",
    "- `finalize case [CASE_ID] approved|terminate notes...`",
    "- `resolve review REVIEW_ID clear|concern|reject notes...`",
    "- `clear review REVIEW_ID notes...`",
    "- `concern review REVIEW_ID notes...`",
    "- `reject review REVIEW_ID notes...`",
    "- `rerun step [CASE_ID] STEP_KEY`",
    "- `run jobs [workers]`",
    "- `rebuild report [CASE_ID]`",
    "- `export case [CASE_ID]`",
    "- `prune retention [days]`",
    "- `status`",
    "",
    "Example:",
    "```json",
    'create case {"displayName":"Acme Labs","counterpartyKind":"entity","registrySearchUrl":"https://example.com/registry"}',
    "```",
  ].join("\n");
}

function parseUpdateCaseCommand(
  payload: string,
  threadCaseId: string | null
): {
  caseId: string;
  payload: string;
} {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new UserCommandError("Usage: update case [CASE_ID] {json}");
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("```")) {
    if (!threadCaseId) {
      throw new UserCommandError(
        "No case is linked to this thread. Use `update case CASE_ID {json}` or run it inside a case thread."
      );
    }
    return {
      caseId: threadCaseId,
      payload: trimmed,
    };
  }

  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    throw new UserCommandError("Usage: update case [CASE_ID] {json}");
  }

  const caseId = trimmed.slice(0, firstSpace).trim();
  const jsonPayload = trimmed.slice(firstSpace + 1).trim();
  if (!caseId || !jsonPayload) {
    throw new UserCommandError("Usage: update case [CASE_ID] {json}");
  }

  return {
    caseId,
    payload: jsonPayload,
  };
}

function formatIssueSummary(issue: IssueRecord): string {
  return `- [${issue.severity}] ${issue.stepKey}: ${issue.title}${issue.detail ? ` - ${issue.detail}` : ""}`;
}

function parseFinalizeCaseCommand(
  payload: string,
  threadCaseId: string | null
): {
  caseId: string;
  recommendation: "approved" | "terminate";
  notes: string;
} {
  const parts = payload.split(/\s+/);
  if (parts.length < 2) {
    throw new UserCommandError(
      "Usage: finalize case [CASE_ID] approved|terminate notes..."
    );
  }

  let caseId = threadCaseId;
  let recommendationToken: string | undefined;
  let notesStartIndex = 1;

  if (parts[0] === "approved" || parts[0] === "terminate") {
    recommendationToken = parts[0];
    notesStartIndex = 1;
  } else {
    caseId = parts[0] ?? null;
    recommendationToken = parts[1];
    notesStartIndex = 2;
  }

  if (!caseId) {
    throw new UserCommandError(
      "No case is linked to this thread. Use `finalize case CASE_ID approved|terminate notes...` or run it inside a case thread."
    );
  }

  if (recommendationToken !== "approved" && recommendationToken !== "terminate") {
    throw new UserCommandError(
      "Usage: finalize case [CASE_ID] approved|terminate notes..."
    );
  }

  const notes = parts.slice(notesStartIndex).join(" ").trim();
  if (!notes) {
    throw new UserCommandError(
      "Finalization requires reviewer notes. Usage: finalize case [CASE_ID] approved|terminate notes..."
    );
  }

  return {
    caseId,
    recommendation: recommendationToken,
    notes,
  };
}
