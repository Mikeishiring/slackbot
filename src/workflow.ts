import type { ArtifactStore, CaptureService, ReportPublisher } from "./artifacts.js";
import type { AdverseClassifier, ConnectorContext, WebSearchClient, StepConnector } from "./connectors.js";
import { getApplicableSteps, isTopExchange } from "./policy.js";
import { PolicyBotStorage } from "./storage.js";
import type {
  CaseRecord,
  CaseSnapshot,
  CreateCaseInput,
  NewFactInput,
  NewIssueInput,
  NewReviewTaskInput,
  PolicyBundle,
  ReviewOutcome,
  ReviewTaskRecord,
  UpdateCaseScreeningInput,
  WorkflowStepKey,
  WorkflowStepStatus,
} from "./types.js";
import { parseJson, uniqueStrings } from "./utils.js";

const PUBLIC_SHORTCUT_PENDING_NOTE =
  "Waiting for public-market shortcut review before running downstream screening.";
const PUBLIC_SHORTCUT_SATISFIED_NOTE =
  "Public-market shortcut satisfied; no further screening required.";
const ENTITY_RESOLUTION_PENDING_NOTE =
  "Waiting for entity resolution before attempting official good-standing verification.";

interface WorkflowRuntimeOptions {
  jobMaxAttempts: number;
  jobRetryDelayMs: number;
  jobLockTimeoutMs: number;
}

export type OnStepComplete = (
  caseId: string,
  stepKey: WorkflowStepKey,
  status: WorkflowStepStatus,
  summary: string
) => Promise<void>;

export class PolicyWorkflow {
  private onStepComplete: OnStepComplete | null = null;

  public constructor(
    private readonly storage: PolicyBotStorage,
    private readonly policy: PolicyBundle,
    private readonly connectors: Map<WorkflowStepKey, StepConnector>,
    private readonly artifactStore: ArtifactStore,
    private readonly captureService: CaptureService | null,
    private readonly reportPublisher: ReportPublisher,
    private readonly options: WorkflowRuntimeOptions,
    private readonly webSearchClient: WebSearchClient | null = null,
    private readonly adverseClassifier: AdverseClassifier | null = null
  ) {}

  public setOnStepComplete(callback: OnStepComplete): void {
    this.onStepComplete = callback;
  }

  public async createCase(input: CreateCaseInput): Promise<CaseSnapshot> {
    const caseRecord = this.storage.createCase(
      input,
      this.policy.version,
      this.policy.decisionMatrixVersion
    );

    for (const step of getApplicableSteps(this.policy, caseRecord.counterpartyKind)) {
      this.storage.ensureWorkflowStep(caseRecord.id, step.key, step.hardGate);
    }
    this.enqueueNextRunnableStep(caseRecord.id);

    await this.publishCase(caseRecord.id);
    return this.storage.buildCaseSnapshot(caseRecord.id);
  }

  public getCaseSnapshot(caseId: string): CaseSnapshot {
    return this.storage.buildCaseSnapshot(caseId);
  }

  public listCases(limit?: number) {
    return this.storage.listCases(limit);
  }

  public async rebuildCaseReport(caseId: string): Promise<CaseSnapshot> {
    await this.publishCase(caseId);
    return this.storage.buildCaseSnapshot(caseId);
  }

  public async finalizeCaseDecision(
    caseId: string,
    recommendation: "approved" | "terminate",
    notes: string
  ): Promise<CaseSnapshot> {
    if (recommendation === "approved") {
      this.storage.resolveAllOpenIssues(caseId);
    }

    this.storage.cancelOpenReviewTasks(
      caseId,
      `Case finalized as ${recommendation}: ${notes}`
    );
    this.storage.updateCaseDecision({
      caseId,
      caseStatus: recommendation === "approved" ? "completed" : "terminated",
      recommendation: recommendation === "approved" ? "approved" : "terminate",
      decisionSummary: notes,
    });
    await this.publishCase(caseId);
    return this.storage.buildCaseSnapshot(caseId);
  }

  public listReviewTasks(caseId?: string): ReviewTaskRecord[] {
    return this.storage.listReviewTasks(caseId);
  }

  public async updateCaseScreeningInput(
    caseId: string,
    input: UpdateCaseScreeningInput
  ): Promise<CaseSnapshot> {
    const updatedCase = this.storage.updateCaseScreeningFields(caseId, input);
    const applicableSteps = getApplicableSteps(
      this.policy,
      updatedCase.counterpartyKind
    );

    for (const step of applicableSteps) {
      await this.clearStepArtifacts(caseId, step.key);
      this.storage.resetStepOutputs(caseId, step.key);
      this.storage.updateStepStatus({
        caseId,
        stepKey: step.key,
        status: "pending",
        note: null,
      });
    }
    this.storage.cancelPendingJobsForCase(caseId);
    this.enqueueNextRunnableStep(caseId);

    this.storage.updateCaseDecision({
      caseId,
      caseStatus: "in_progress",
      recommendation: "pending",
      decisionSummary: "Case input updated and workflow requeued.",
    });
    await this.publishCase(caseId);
    return this.storage.buildCaseSnapshot(caseId);
  }

  public async rerunStep(
    caseId: string,
    stepKey: WorkflowStepKey
  ): Promise<CaseSnapshot> {
    const snapshot = this.storage.buildCaseSnapshot(caseId);
    const step = snapshot.steps.find((candidate) => candidate.stepKey === stepKey);
    if (!step) {
      throw new Error(`Step not found on case ${caseId}: ${stepKey}`);
    }

    await this.clearStepArtifacts(caseId, stepKey);
    this.storage.resetStepOutputs(caseId, stepKey);
    this.storage.cancelPendingJobsForStep(caseId, stepKey);
    this.storage.updateStepStatus({
      caseId,
      stepKey,
      status: "pending",
      note: null,
    });
    this.storage.updateCaseDecision({
      caseId,
      caseStatus: "in_progress",
      recommendation: "pending",
      decisionSummary: `Requeued ${stepKey}.`,
    });
    this.enqueueNextRunnableStep(caseId);
    await this.publishCase(caseId);
    return this.storage.buildCaseSnapshot(caseId);
  }

  public async runPendingJob(workerId: string) {
    const staleCutoff = new Date(Date.now() - this.options.jobLockTimeoutMs).toISOString();
    const job = this.storage.recoverAndClaimNextJob(workerId, staleCutoff);
    if (!job) {
      return null;
    }

    const stepPayload = job.kind === "run_step"
      ? parseJson<{ stepKey?: string }>(job.payloadJson, {})
      : null;
    const stepKey =
      job.kind === "run_step" && stepPayload?.stepKey && isWorkflowStepKey(stepPayload.stepKey)
        ? stepPayload.stepKey
        : null;

    try {
      if (job.kind === "run_step") {
        if (!job.caseId || !stepKey || !isWorkflowStepKey(stepKey)) {
          throw new Error(`Invalid run_step payload: ${job.payloadJson}`);
        }

        await this.runStep(job.caseId, stepKey);
      } else if (job.kind === "refresh_report") {
        if (!job.caseId) {
          throw new Error("refresh_report job is missing caseId");
        }
        await this.publishCase(job.caseId);
      }

      this.storage.completeJob(job.id);
      return job;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown worker error";
      if (
        stepKey &&
        isTransientWorkerError(message) &&
        job.attempts < this.options.jobMaxAttempts
      ) {
        const retryDelayMs = getRetryDelayMs(
          this.options.jobRetryDelayMs,
          job.attempts
        );
        const retryAt = new Date(Date.now() + retryDelayMs).toISOString();
        this.storage.requeueJob(job.id, message, retryAt);
        if (job.caseId) {
          this.storage.updateStepStatus({
            caseId: job.caseId,
            stepKey,
            status: "pending",
            note: `Transient worker failure; retrying automatically (${job.attempts}/${this.options.jobMaxAttempts}): ${message}`,
          });
          await this.refreshDecisionAndReport(job.caseId).catch(() => undefined);
        }
        return job;
      }

      this.storage.failJob(job.id, message);
      if (job.caseId && stepKey) {
        this.storage.createIssue(job.caseId, {
          stepKey,
          severity: "medium",
          title: "Worker execution failed",
          detail: message,
          evidenceIds: [],
        });
        this.storage.updateStepStatus({
          caseId: job.caseId,
          stepKey,
          status: "blocked",
          note: `Worker execution failed: ${message}`,
        });
        await this.refreshDecisionAndReport(job.caseId).catch(() => undefined);
      }
      return job;
    }
  }

  public async runUntilIdle(workerId: string, maxJobs = 100): Promise<number> {
    let processed = 0;
    while (processed < maxJobs) {
      const job = await this.runPendingJob(workerId);
      if (!job) {
        break;
      }
      processed += 1;
    }

    return processed;
  }

  public async runUntilIdleConcurrent(
    workerPrefix: string,
    workerCount: number,
    maxJobsPerWorker = 100
  ): Promise<number> {
    if (workerCount <= 1) {
      return this.runUntilIdle(workerPrefix, maxJobsPerWorker);
    }

    const processedCounts = await Promise.all(
      Array.from({ length: workerCount }, (_value, index) =>
        this.runUntilIdle(`${workerPrefix}-${index + 1}`, maxJobsPerWorker)
      )
    );

    return processedCounts.reduce((sum, count) => sum + count, 0);
  }

  public async runStep(
    caseId: string,
    stepKey: WorkflowStepKey
  ): Promise<CaseSnapshot> {
    const connector = this.connectors.get(stepKey);
    if (!connector) {
      throw new Error(`No connector registered for step: ${stepKey}`);
    }

    const currentSnapshot = this.storage.buildCaseSnapshot(caseId);
    if (shouldShortCircuit(currentSnapshot, stepKey)) {
      this.storage.updateStepStatus({
        caseId,
        stepKey,
        status: "skipped",
        note: "Step skipped because the case already reached a terminal state.",
      });
      await this.refreshDecisionAndReport(caseId);
      return this.storage.buildCaseSnapshot(caseId);
    }

    const publicShortcutPendingNote = this.getPublicShortcutPendingNote(
      currentSnapshot,
      stepKey
    );
    if (publicShortcutPendingNote) {
      this.storage.updateStepStatus({
        caseId,
        stepKey,
        status: "pending",
        note: publicShortcutPendingNote,
      });
      await this.refreshDecisionAndReport(caseId);
      return this.storage.buildCaseSnapshot(caseId);
    }

    const entityResolutionPendingNote = this.getEntityResolutionPendingNote(
      currentSnapshot,
      stepKey
    );
    if (entityResolutionPendingNote) {
      this.storage.updateStepStatus({
        caseId,
        stepKey,
        status: "pending",
        note: entityResolutionPendingNote,
      });
      await this.refreshDecisionAndReport(caseId);
      return this.storage.buildCaseSnapshot(caseId);
    }

    await this.clearStepArtifacts(caseId, stepKey);
    this.storage.resetStepOutputs(caseId, stepKey);
    this.storage.updateStepStatus({
      caseId,
      stepKey,
      status: "running",
      note: null,
    });

    const freshSnapshot = this.storage.buildCaseSnapshot(caseId);
    const result = await connector.execute(this.buildConnectorContext(freshSnapshot));

    for (const fact of result.facts) {
      this.storage.upsertFact(caseId, fact);
    }

    for (const issue of result.issues) {
      this.storage.createIssue(caseId, issue);
    }

    for (const reviewTask of result.reviewTasks) {
      this.storage.createReviewTask(caseId, reviewTask);
    }

    this.storage.updateStepStatus({
      caseId,
      stepKey,
      status: result.status,
      note: result.note,
    });

    await this.refreshDecisionAndReport(caseId);
    this.enqueueNextRunnableStep(caseId);

    if (this.onStepComplete) {
      await this.onStepComplete(caseId, stepKey, result.status, result.note ?? "").catch(() => undefined);
    }

    return this.storage.buildCaseSnapshot(caseId);
  }

  public async resolveReviewTask(
    taskId: string,
    outcome: ReviewOutcome,
    notes: string
  ): Promise<CaseSnapshot> {
    const task = this.storage.getReviewTask(taskId);
    const snapshot = this.storage.buildCaseSnapshot(task.caseId);
    const resolution = buildReviewResolution(snapshot, task, outcome, notes);

    this.storage.resolveReviewTask(taskId, outcome, notes);
    this.storage.resolveIssuesForStep(task.caseId, task.stepKey);
    for (const fact of resolution.facts) {
      this.storage.upsertFact(task.caseId, fact);
    }
    for (const issue of resolution.issues) {
      this.storage.createIssue(task.caseId, issue);
    }
    this.storage.updateStepStatus({
      caseId: task.caseId,
      stepKey: task.stepKey,
      status: resolution.stepStatus,
      note: notes,
    });
    this.handlePublicShortcutResolution(task, outcome);

    await this.refreshDecisionAndReport(task.caseId);
    return this.storage.buildCaseSnapshot(task.caseId);
  }

  private buildConnectorContext(snapshot: CaseSnapshot): ConnectorContext {
    return {
      snapshot,
      policy: this.policy,
      storage: this.storage,
      artifactStore: this.artifactStore,
      captureService: this.captureService,
      webSearchClient: this.webSearchClient,
      adverseClassifier: this.adverseClassifier,
    };
  }

  private async refreshDecisionAndReport(caseId: string): Promise<void> {
    this.evaluateDecision(caseId);
    await this.publishCase(caseId);
  }

  private evaluateDecision(caseId: string): CaseRecord {
    const snapshot = this.storage.buildCaseSnapshot(caseId);
    const failedHardGate = snapshot.steps.find(
      (step) =>
        step.hardGate && step.status === "failed"
    );

    if (failedHardGate) {
      return this.storage.updateCaseDecision({
        caseId,
        caseStatus: "terminated",
        recommendation: "terminate",
        decisionSummary: `${failedHardGate.stepKey} failed.`,
      });
    }

    const blockedStep = snapshot.steps.find((step) => step.status === "blocked");
    if (blockedStep) {
      return this.storage.updateCaseDecision({
        caseId,
        caseStatus: "blocked",
        recommendation: "blocked",
        decisionSummary: blockedStep.note ?? `${blockedStep.stepKey} is blocked.`,
      });
    }

    if (snapshot.reviewTasks.some((task) => task.status === "open")) {
      return this.storage.updateCaseDecision({
        caseId,
        caseStatus: "awaiting_review",
        recommendation: "manual_review",
        decisionSummary: "Open review tasks remain.",
      });
    }

    if (
      snapshot.steps.some((step) => step.status === "pending" || step.status === "running")
    ) {
      return this.storage.updateCaseDecision({
        caseId,
        caseStatus: "in_progress",
        recommendation: "pending",
        decisionSummary: "Workflow steps are still running.",
      });
    }

    const openCriticalIssue = snapshot.issues.find(
      (issue) => issue.status === "open" && issue.severity === "critical"
    );
    if (openCriticalIssue) {
      return this.storage.updateCaseDecision({
        caseId,
        caseStatus: "awaiting_review",
        recommendation: "manual_review",
        decisionSummary: openCriticalIssue.title,
      });
    }

    const openHighOrMediumIssue = snapshot.issues.find(
      (issue) =>
        issue.status === "open" &&
        (issue.severity === "high" || issue.severity === "medium")
    );
    if (openHighOrMediumIssue) {
      return this.storage.updateCaseDecision({
        caseId,
        caseStatus: "awaiting_review",
        recommendation: "manual_review",
        decisionSummary: openHighOrMediumIssue.title,
      });
    }

    return this.storage.updateCaseDecision({
      caseId,
      caseStatus: "completed",
      recommendation: "approved",
      decisionSummary: "All active steps completed without unresolved issues.",
    });
  }

  private async publishCase(caseId: string): Promise<void> {
    const snapshot = this.storage.buildCaseSnapshot(caseId);
    await this.reportPublisher.publish(snapshot);
  }

  private async clearStepArtifacts(
    caseId: string,
    stepKey: WorkflowStepKey
  ): Promise<void> {
    const existingArtifacts = this.storage.listArtifactsForStep(caseId, stepKey);
    if (existingArtifacts.length === 0) {
      return;
    }
    await this.artifactStore.deleteArtifacts(existingArtifacts);
  }

  private getPublicShortcutPendingNote(
    snapshot: CaseSnapshot,
    stepKey: WorkflowStepKey
  ): string | null {
    if (stepKey === "public_market_shortcut") {
      return null;
    }

    if (
      snapshot.caseRecord.counterpartyKind !== "entity" ||
      !snapshot.caseRecord.publicListingUrl ||
      !snapshot.caseRecord.exchangeName ||
      !isTopExchange(this.policy, snapshot.caseRecord.exchangeName)
    ) {
      return null;
    }

    const publicShortcutStep = snapshot.steps.find(
      (step) => step.stepKey === "public_market_shortcut"
    );
    if (!publicShortcutStep) {
      return null;
    }

    return publicShortcutStep.status === "pending" ||
      publicShortcutStep.status === "running" ||
      publicShortcutStep.status === "manual_review_required"
      ? PUBLIC_SHORTCUT_PENDING_NOTE
      : null;
  }

  private getEntityResolutionPendingNote(
    snapshot: CaseSnapshot,
    stepKey: WorkflowStepKey
  ): string | null {
    if (stepKey !== "good_standing") {
      return null;
    }

    const resolutionStep = snapshot.steps.find(
      (step) => step.stepKey === "entity_resolution"
    );
    if (!resolutionStep) {
      return null;
    }

    return resolutionStep.status === "pending" ||
      resolutionStep.status === "running" ||
      resolutionStep.status === "manual_review_required" ||
      resolutionStep.status === "blocked"
      ? ENTITY_RESOLUTION_PENDING_NOTE
      : null;
  }

  private handlePublicShortcutResolution(
    task: ReviewTaskRecord,
    outcome: ReviewOutcome
  ): void {
    if (task.stepKey !== "public_market_shortcut") {
      return;
    }

    const snapshot = this.storage.buildCaseSnapshot(task.caseId);
    const downstreamSteps = getApplicableSteps(
      this.policy,
      snapshot.caseRecord.counterpartyKind
    ).filter((step) => step.key !== "public_market_shortcut");

    if (outcome === "clear") {
      for (const step of downstreamSteps) {
        const current = snapshot.steps.find((item) => item.stepKey === step.key);
        if (!current || !isDeferredForPublicShortcut(current)) {
          continue;
        }

        this.storage.updateStepStatus({
          caseId: task.caseId,
          stepKey: step.key,
          status: "skipped",
          note: PUBLIC_SHORTCUT_SATISFIED_NOTE,
        });
      }
      return;
    }

    for (const step of downstreamSteps) {
      const current = snapshot.steps.find((item) => item.stepKey === step.key);
      if (!current || !isDeferredForPublicShortcut(current)) {
        continue;
      }

      this.storage.updateStepStatus({
        caseId: task.caseId,
        stepKey: step.key,
        status: "pending",
        note: null,
      });
    }
    this.enqueueNextRunnableStep(task.caseId);
  }

  private enqueueNextRunnableStep(caseId: string): void {
    const snapshot = this.storage.buildCaseSnapshot(caseId);
    if (
      snapshot.caseRecord.caseStatus === "terminated" ||
      snapshot.caseRecord.caseStatus === "completed"
    ) {
      return;
    }

    const applicableSteps = getApplicableSteps(
      this.policy,
      snapshot.caseRecord.counterpartyKind
    );
    for (const step of applicableSteps) {
      const current = snapshot.steps.find((item) => item.stepKey === step.key);
      if (!current || current.status !== "pending") {
        continue;
      }

      const publicShortcutNote = this.getPublicShortcutPendingNote(
        snapshot,
        step.key
      );
      if (publicShortcutNote) {
        if (current.note !== publicShortcutNote) {
          this.storage.updateStepStatus({
            caseId,
            stepKey: step.key,
            status: "pending",
            note: publicShortcutNote,
          });
        }
        continue;
      }

      const entityResolutionNote = this.getEntityResolutionPendingNote(
        snapshot,
        step.key
      );
      if (entityResolutionNote) {
        if (current.note !== entityResolutionNote) {
          this.storage.updateStepStatus({
            caseId,
            stepKey: step.key,
            status: "pending",
            note: entityResolutionNote,
          });
        }
        continue;
      }

      if (current.note) {
        this.storage.updateStepStatus({
          caseId,
          stepKey: step.key,
          status: "pending",
          note: null,
        });
      }

      this.storage.enqueueJob({
        caseId,
        kind: "run_step",
        payload: { stepKey: step.key },
      });
      return;
    }
  }
}

function buildReviewResolution(
  snapshot: CaseSnapshot,
  task: ReviewTaskRecord,
  outcome: ReviewOutcome,
  notes: string
): {
  stepStatus: "passed" | "failed" | "skipped";
  facts: NewFactInput[];
  issues: NewIssueInput[];
} {
  const factKey = `${task.stepKey}_review_resolution`;
  const evidenceIds = collectStepEvidenceIds(snapshot, task.stepKey);
  if (task.stepKey === "public_market_shortcut" && outcome !== "clear") {
    return {
      stepStatus: "skipped",
      facts: [],
      issues: [],
    };
  }

  if (outcome === "clear") {
    return {
      stepStatus: "passed",
      facts: [
        {
          stepKey: task.stepKey,
          factKey,
          summary: `Manual review cleared ${task.stepKey}.`,
          value: { outcome, notes },
          verificationStatus: "verified",
          sourceId: "manual_review",
          evidenceIds,
          freshnessExpiresAt: null,
        },
      ],
      issues: [],
    };
  }

  const issueSeverity = outcome === "reject" ? "critical" : "high";
  const shouldFail =
    outcome === "reject" ||
    task.stepKey === "ofac_precheck" ||
    task.stepKey === "ofac_search";

  return {
    stepStatus: shouldFail ? "failed" : "passed",
    facts: [
      {
        stepKey: task.stepKey,
        factKey,
        summary: `Manual review marked ${task.stepKey} as ${outcome}.`,
        value: { outcome, notes },
        verificationStatus: "verified",
        sourceId: "manual_review",
        evidenceIds,
        freshnessExpiresAt: null,
      },
    ],
    issues: [
      {
        stepKey: task.stepKey,
        severity: issueSeverity,
        title: `${task.title} resolved as ${outcome}`,
        detail: notes,
        evidenceIds,
      },
    ],
  };
}

function collectStepEvidenceIds(
  snapshot: CaseSnapshot,
  stepKey: WorkflowStepKey
): string[] {
  return uniqueStrings([
    ...snapshot.artifacts
      .filter((artifact) => artifact.stepKey === stepKey && artifact.storageBackend !== "local-report")
      .map((artifact) => artifact.id),
    ...snapshot.facts
      .filter((fact) => fact.stepKey === stepKey)
      .flatMap((fact) => fact.evidenceIds),
    ...snapshot.issues
      .filter((issue) => issue.stepKey === stepKey)
      .flatMap((issue) => issue.evidenceIds),
  ]);
}

const ENTITY_RESOLUTION_INDEPENDENT_STEPS: Set<WorkflowStepKey> = new Set([
  "reputation_search",
  "bbb_review",
  "ofac_precheck",
  "ofac_search",
]);

function shouldShortCircuit(
  snapshot: CaseSnapshot,
  stepKey: WorkflowStepKey
): boolean {
  if (snapshot.caseRecord.recommendation === "terminate") {
    return stepKey !== "good_standing";
  }

  if (snapshot.caseRecord.recommendation === "blocked") {
    // If blocked on entity_resolution, still run steps that don't depend on it
    const blockedOnEntityResolution = snapshot.steps.some(
      (step) => step.stepKey === "entity_resolution" && step.status === "blocked"
    );
    if (blockedOnEntityResolution && ENTITY_RESOLUTION_INDEPENDENT_STEPS.has(stepKey)) {
      return false;
    }
    return stepKey !== "entity_resolution";
  }

  return false;
}

function isTransientWorkerError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("timeout") ||
    normalized.includes("temporar") ||
    normalized.includes("network") ||
    normalized.includes("socket hang up") ||
    normalized.includes("target closed") ||
    normalized.includes("navigation failed") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("service unavailable") ||
    normalized.includes("bad gateway") ||
    normalized.includes("gateway timeout") ||
    normalized.includes("econnreset") ||
    normalized.includes("econnrefused") ||
    normalized.includes("eai_again") ||
    normalized.includes("enotfound") ||
    normalized.includes("err_")
  );
}

function getRetryDelayMs(baseDelayMs: number, attempts: number): number {
  const multiplier = Math.min(4, Math.max(1, attempts));
  return baseDelayMs * multiplier;
}

function isWorkflowStepKey(value: string): value is WorkflowStepKey {
  return (
    value === "public_market_shortcut" ||
    value === "entity_resolution" ||
    value === "good_standing" ||
    value === "reputation_search" ||
    value === "bbb_review" ||
    value === "ofac_precheck" ||
    value === "ofac_search"
  );
}

function isDeferredForPublicShortcut(step: {
  status: string;
  note: string | null;
}): boolean {
  return step.status === "pending" && step.note === PUBLIC_SHORTCUT_PENDING_NOTE;
}
