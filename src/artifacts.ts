import { unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import PDFDocument from "pdfkit";
import { chromium } from "playwright";

import type { DriveUploader } from "./drive.js";
import type {
  ArtifactRecord,
  CaptureRequest,
  CaseSnapshot,
  FactRecord,
  IssueRecord,
  ReportRecord,
  ReviewTaskRecord,
  SaveArtifactInput,
  WorkflowStepRecord,
} from "./types.js";
import { PolicyBotStorage } from "./storage.js";
import {
  ensureDirectory,
  formatJson,
  generateId,
  parseJson,
  sha256,
  slugify,
  uniqueStrings,
} from "./utils.js";

export interface ArtifactStore {
  saveArtifact(input: SaveArtifactInput): Promise<ArtifactRecord>;
  resolveAbsolutePath(record: ArtifactRecord): string;
  deleteArtifacts(records: ArtifactRecord[]): Promise<void>;
}

export interface CaptureResult {
  artifacts: ArtifactRecord[];
  captureMode: "live_browser" | "http_fetch_render";
  finalUrl: string | null;
  title: string | null;
}

export interface CaptureService {
  capture(request: CaptureRequest): Promise<CaptureResult>;
}

export interface ReportPublisher {
  publish(snapshot: CaseSnapshot): Promise<{
    working: ReportRecord;
    final: ReportRecord;
    traceability: ReportRecord;
    reviewerPacket: ReportRecord;
  }>;
}

interface SourceDescriptor {
  key: string;
  type: "artifact" | "url";
  label: string;
  markdown: string;
  absolutePath: string | null;
  url: string | null;
  sourceId: string | null;
  artifactId: string | null;
}

interface SourceIndexEntry {
  descriptor: SourceDescriptor;
  factSummaries: string[];
  issueTitles: string[];
  sourceIds: string[];
  stepKeys: string[];
}

interface DecisionChecklistEntry {
  stepKey: WorkflowStepRecord["stepKey"];
  step: WorkflowStepRecord | null;
  taskSummaries: string[];
  readiness: { label: string; reviewerAction: string };
  reviewSnapshot: string;
  stageFreshness: "current" | "stale" | "unknown";
  stageFreshnessNote: string;
  rerunRecommendation:
    | "refresh_first"
    | "review_current_evidence"
    | "review_current_evidence_then_refresh_if_needed";
  rerunRecommendationReason: string;
  clearancePath:
    | "additional_evidence_required"
    | "stage_report_then_authoritative_evidence"
    | "authoritative_evidence_only"
    | "multiple_artifacts_required";
  clearancePathReason: string;
  clearanceCondition: string;
  reviewHandoffNote: string;
  reviewCompleteness: "blocked" | "well_supported" | "supported_with_gaps" | "supporting_only" | "thin";
  reviewCompletenessReason: string;
  recommendedOutcome:
    | "gather_more_evidence"
    | "review_evidence_now"
    | "treat_as_adverse"
    | "ready_to_clear_if_evidence_checks_out";
  recommendedOutcomeReason: string;
  reviewPriorityReason: string;
  reviewBlockers: string[];
  supportedFactCount: number;
  stepFactCount: number;
  sourceGapFactCount: number;
  openIssueCount: number;
  evidenceCount: number;
  authoritativeEvidenceCount: number;
  stageReport: ArtifactRecord | null;
  topEvidence: ArtifactRecord[];
  bestNextClickKind: "stage_report" | "authoritative_evidence" | "supporting_evidence" | "none";
  bestNextArtifact: ArtifactRecord | null;
}

export class LocalArtifactStore implements ArtifactStore {
  public constructor(
    private readonly storage: PolicyBotStorage,
    private readonly artifactRoot: string,
    private readonly reportRoot: string
  ) {}

  public async saveArtifact(input: SaveArtifactInput): Promise<ArtifactRecord> {
    const root =
      input.category === "report" ? this.reportRoot : this.artifactRoot;
    const directory = join(root, input.caseId);
    await ensureDirectory(directory);

    const extension = extname(input.fileName);
    const bareName = extension
      ? input.fileName.slice(0, -extension.length)
      : input.fileName;
    const fileName = `${generateId("file")}-${slugify(bareName)}${extension}`;
    const absolutePath = join(directory, fileName);
    const body =
      typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body;

    await writeFile(absolutePath, body);

    return this.storage.createArtifact({
      caseId: input.caseId,
      stepKey: input.stepKey,
      title: input.title,
      sourceId: input.sourceId,
      storageBackend:
        input.category === "report" ? "local-report" : "local-artifact",
      relativePath: `${input.caseId}/${fileName}`,
      contentType: input.contentType,
      sourceUrl: input.sourceUrl,
      metadata: {
        ...input.metadata,
        sha256: sha256(body),
        sizeBytes: body.byteLength,
      },
    });
  }

  public resolveAbsolutePath(record: ArtifactRecord): string {
    const root =
      record.storageBackend === "local-report" ? this.reportRoot : this.artifactRoot;
    return resolve(root, record.relativePath);
  }

  public async deleteArtifacts(records: ArtifactRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    await Promise.all(
      records.map(async (record) => {
        try {
          await unlink(this.resolveAbsolutePath(record));
        } catch (error) {
          if (!isFileMissingError(error)) {
            throw error;
          }
        }
      })
    );

    this.storage.deleteArtifacts(records.map((record) => record.id));
  }
}

export class PlaywrightCaptureService implements CaptureService {
  public constructor(
    private readonly artifactStore: ArtifactStore,
    private readonly headless: boolean
  ) {}

  public async capture(request: CaptureRequest): Promise<CaptureResult> {
    const browser = await chromium.launch({
      headless: this.headless,
      args: [
        "--disable-dev-shm-usage",
        "--disable-http2",
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
      ],
    });

    try {
      const liveCapture = await this.tryLiveBrowserCapture(browser, request);
      if (liveCapture) {
        return liveCapture;
      }

      const fetchedCapture = await this.tryHttpFetchRenderCapture(browser, request);
      if (fetchedCapture) {
        return fetchedCapture;
      }

      throw new Error(
        `Unable to capture ${request.url} via live browser or HTTP fetch fallback.`
      );
    } finally {
      await browser.close();
    }
  }

  private async tryLiveBrowserCapture(
    browser: Awaited<ReturnType<typeof chromium.launch>>,
    request: CaptureRequest
  ): Promise<CaptureResult | null> {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: defaultUserAgent(),
      locale: "en-US",
      viewport: { width: 1280, height: 800 },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    const page = await context.newPage();

    try {
      await page.goto(request.url, {
        waitUntil: "commit",
        timeout: 30_000,
      });
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(
        () => undefined
      );
      await page.waitForTimeout(1_500);

      const html = await page.content();
      const title = await safePageTitle(page);
      if (!html.trim() || isChallengePage(title, html)) {
        return null;
      }

      const artifacts = await this.persistCaptureArtifacts(request, {
        html,
        title,
        finalUrl: page.url(),
        captureMode: "live_browser",
        screenshot: await page.screenshot({ fullPage: true }).catch(() => null),
        pdf: await page
          .pdf({ format: "A4", printBackground: true })
          .catch(() => null),
      });

      return {
        artifacts,
        captureMode: "live_browser",
        finalUrl: page.url(),
        title,
      };
    } catch {
      return null;
    } finally {
      await context.close();
    }
  }

  private async tryHttpFetchRenderCapture(
    browser: Awaited<ReturnType<typeof chromium.launch>>,
    request: CaptureRequest
  ): Promise<CaptureResult | null> {
    let response: Response;
    try {
      response = await fetch(request.url, {
        headers: {
          "User-Agent": defaultUserAgent(),
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return null;
    }

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const title = extractHtmlTitle(html);
    if (!html.trim() || isChallengePage(title, html)) {
      return null;
    }

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: defaultUserAgent(),
      locale: "en-US",
      viewport: { width: 1280, height: 800 },
      javaScriptEnabled: false,
    });
    const page = await context.newPage();

    try {
      await page.setContent(
        sanitizeHtmlForOfflineRender(injectBaseUrl(html, response.url)),
        {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
        }
      );
      await page.waitForTimeout(1_000);

      const renderedTitle = (await safePageTitle(page)) ?? title;
      const artifacts = await this.persistCaptureArtifacts(request, {
        html,
        title: renderedTitle,
        finalUrl: response.url,
        captureMode: "http_fetch_render",
        screenshot: await page.screenshot({ fullPage: true }).catch(() => null),
        pdf: await page
          .pdf({ format: "A4", printBackground: true })
          .catch(() => null),
      });

      return {
        artifacts,
        captureMode: "http_fetch_render",
        finalUrl: response.url,
        title: renderedTitle,
      };
    } catch {
      return null;
    } finally {
      await context.close();
    }
  }

  private async persistCaptureArtifacts(
    request: CaptureRequest,
    input: {
      html: string;
      title: string | null;
      finalUrl: string | null;
      captureMode: "live_browser" | "http_fetch_render";
      screenshot: Buffer | null;
      pdf: Buffer | null;
    }
  ): Promise<ArtifactRecord[]> {
    const artifacts: ArtifactRecord[] = [];
    const metadata = {
      requestedUrl: request.url,
      finalUrl: input.finalUrl,
      title: input.title,
      captureMode: input.captureMode,
    };

    artifacts.push(
      await this.artifactStore.saveArtifact({
        caseId: request.caseId,
        stepKey: request.stepKey,
        title: `${request.title} HTML`,
        sourceId: request.sourceId,
        sourceUrl: input.finalUrl ?? request.url,
        fileName: `${request.title}.html`,
        contentType: "text/html",
        body: input.html,
        category: "evidence",
        metadata: {
          ...metadata,
          captureType: "html",
        },
      })
    );

    if (input.screenshot) {
      artifacts.push(
        await this.artifactStore.saveArtifact({
          caseId: request.caseId,
          stepKey: request.stepKey,
          title: `${request.title} Screenshot`,
          sourceId: request.sourceId,
          sourceUrl: input.finalUrl ?? request.url,
          fileName: `${request.title}.png`,
          contentType: "image/png",
          body: input.screenshot,
          category: "evidence",
          metadata: {
            ...metadata,
            captureType: "screenshot",
          },
        })
      );
    }

    if (input.pdf) {
      artifacts.push(
        await this.artifactStore.saveArtifact({
          caseId: request.caseId,
          stepKey: request.stepKey,
          title: `${request.title} PDF`,
          sourceId: request.sourceId,
          sourceUrl: input.finalUrl ?? request.url,
          fileName: `${request.title}.pdf`,
          contentType: "application/pdf",
          body: input.pdf,
          category: "evidence",
          metadata: {
            ...metadata,
            captureType: "pdf",
          },
        })
      );
    }

    return artifacts;
  }
}

export class LocalReportPublisher implements ReportPublisher {
  public constructor(
    private readonly storage: PolicyBotStorage,
    private readonly artifactStore: ArtifactStore,
    private readonly driveUploader: DriveUploader | null = null
  ) {}

  public async publish(snapshot: CaseSnapshot): Promise<{
    working: ReportRecord;
    final: ReportRecord;
    traceability: ReportRecord;
    reviewerPacket: ReportRecord;
  }> {
    const stepReportArtifacts = await this.publishStepReports(snapshot);
    const markdown = renderCaseReportMarkdown(
      snapshot,
      this.artifactStore,
      stepReportArtifacts
    );
    const markdownArtifact = await this.artifactStore.saveArtifact({
      caseId: snapshot.caseRecord.id,
      stepKey: "report",
      title: "Working Report",
      sourceId: null,
      sourceUrl: null,
      fileName: "working-report.md",
      contentType: "text/markdown",
      body: markdown,
      category: "report",
      metadata: {
        reportType: "working",
      },
    });

    const pdfArtifact = await this.artifactStore.saveArtifact({
      caseId: snapshot.caseRecord.id,
      stepKey: "report",
      title: "Final Report",
      sourceId: null,
      sourceUrl: null,
      fileName: "final-report.pdf",
      contentType: "application/pdf",
      body: await renderPdf(markdown),
      category: "report",
      metadata: {
        reportType: "final",
      },
    });

    const working = this.storage.upsertReport({
      caseId: snapshot.caseRecord.id,
      kind: "working",
      status: "published",
      artifactId: markdownArtifact.id,
      summary: summarizeSnapshot(snapshot),
    });
    const final = this.storage.upsertReport({
      caseId: snapshot.caseRecord.id,
      kind: "final",
      status: "published",
      artifactId: pdfArtifact.id,
      summary: summarizeSnapshot(snapshot),
    });

    const traceabilityArtifact = await this.artifactStore.saveArtifact({
      caseId: snapshot.caseRecord.id,
      stepKey: "report",
      title: "Traceability Manifest",
      sourceId: null,
      sourceUrl: null,
      fileName: "traceability-manifest.json",
      contentType: "application/json",
      body: formatJson(
        buildTraceabilityManifest(snapshot, this.artifactStore, {
          working: markdownArtifact,
          final: pdfArtifact,
          stepReports: stepReportArtifacts,
        })
      ),
      category: "report",
      metadata: {
        reportType: "traceability",
      },
    });
    const traceability = this.storage.upsertReport({
      caseId: snapshot.caseRecord.id,
      kind: "traceability",
      status: "published",
      artifactId: traceabilityArtifact.id,
      summary: summarizeTraceability(snapshot, this.artifactStore),
    });

    const reviewerPacketArtifact = await this.artifactStore.saveArtifact({
      caseId: snapshot.caseRecord.id,
      stepKey: "report",
      title: "Reviewer Packet",
      sourceId: null,
      sourceUrl: null,
      fileName: "reviewer-packet.md",
      contentType: "text/markdown",
      body: renderReviewerPacketMarkdown(
        snapshot,
        this.artifactStore,
        markdownArtifact,
        pdfArtifact,
        traceabilityArtifact,
        stepReportArtifacts
      ),
      category: "report",
      metadata: {
        reportType: "reviewer_packet",
      },
    });
    const reviewerPacket = this.storage.upsertReport({
      caseId: snapshot.caseRecord.id,
      kind: "review_packet",
      status: "published",
      artifactId: reviewerPacketArtifact.id,
      summary: summarizeReviewerPacket(snapshot),
    });

    // Upload to Google Drive if configured
    if (this.driveUploader) {
      try {
        await this.driveUploader.uploadReport(snapshot, final, pdfArtifact, this.artifactStore);
        await this.driveUploader.uploadReport(snapshot, reviewerPacket, reviewerPacketArtifact, this.artifactStore);
      } catch (error) {
        console.error("Google Drive upload failed (non-blocking)", error);
      }
    }

    return { working, final, traceability, reviewerPacket };
  }

  private async publishStepReports(snapshot: CaseSnapshot): Promise<ArtifactRecord[]> {
    const completedOrAwaitingSteps = snapshot.steps.filter(
      (step) => step.status !== "pending" && step.status !== "running"
    );

    return Promise.all(
      completedOrAwaitingSteps.map((step, index) =>
        this.artifactStore.saveArtifact({
          caseId: snapshot.caseRecord.id,
          stepKey: step.stepKey,
          title: `${formatStepLabel(step.stepKey)} Step Report`,
          sourceId: null,
          sourceUrl: null,
          fileName: `${String(index + 1).padStart(2, "0")}-${step.stepKey}-${step.status}-report.md`,
          contentType: "text/markdown",
          body: renderStepReportMarkdown(
            snapshot,
            step,
            index + 1,
            this.artifactStore
          ),
          category: "report",
          metadata: {
            reportType: "step",
            stepKey: step.stepKey,
            stepStatus: step.status,
            stepOrder: index + 1,
          },
        })
      )
    );
  }
}

export function renderCaseReportMarkdown(
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore,
  stepReportArtifacts: ArtifactRecord[] = []
): string {
  const supportedFacts = snapshot.facts.filter((fact) =>
    hasAccessibleFactSources(fact, snapshot, artifactStore)
  );
  const unsupportedFacts = snapshot.facts.filter(
    (fact) => !hasAccessibleFactSources(fact, snapshot, artifactStore)
  );
  const verifiedFacts = supportedFacts.filter((fact) => fact.verificationStatus === "verified");
  const inferredFacts = supportedFacts.filter((fact) => fact.verificationStatus === "inferred");
  const openIssues = snapshot.issues.filter((issue) => issue.status === "open");
  const blockedChecks = snapshot.steps.filter(
    (step) => step.status === "failed" || step.status === "blocked"
  );
  const manualReviewItems = snapshot.reviewTasks.filter(
    (task) => task.status === "open"
  );
  const resolvedReviewItems = snapshot.reviewTasks.filter(
    (task) => task.status === "resolved"
  );
  const evidenceArtifacts = snapshot.artifacts.filter(
    (artifact) => artifact.storageBackend !== "local-report"
  );
  const knownEntityStructure = readKnownEntityStructure(snapshot);
  const caseMetadata = [
    `- Case ID: ${snapshot.caseRecord.id}`,
    `- Counterparty: ${snapshot.caseRecord.displayName}`,
    `- Legal Name: ${snapshot.caseRecord.legalName ?? "None"}`,
    `- Type: ${snapshot.caseRecord.counterpartyKind}`,
    `- Status: ${snapshot.caseRecord.caseStatus}`,
    `- Recommendation: ${snapshot.caseRecord.recommendation}`,
    `- Website: ${snapshot.caseRecord.website ?? "None"}`,
    `- Jurisdiction: ${formatJurisdiction(snapshot)}`,
    `- Requested By: ${snapshot.caseRecord.requestedBy ?? "None"}`,
    `- Created At: ${snapshot.caseRecord.createdAt}`,
    `- Updated At: ${snapshot.caseRecord.updatedAt}`,
    `- Policy Version: ${snapshot.caseRecord.policyVersion}`,
    `- Decision Matrix Version: ${snapshot.caseRecord.decisionMatrixVersion}`,
  ];
  if (snapshot.caseRecord.decisionSummary) {
    caseMetadata.push(`- Decision Summary: ${snapshot.caseRecord.decisionSummary}`);
  }

  const passedCount = snapshot.steps.filter((s) => s.status === "passed" || s.status === "skipped").length;
  const totalSteps = snapshot.steps.length;
  const stepSummaryLines = snapshot.steps.map((step) => {
    const icon = step.status === "passed" ? "[PASSED]"
      : step.status === "skipped" ? "[SKIPPED]"
      : step.status === "failed" ? "[FAILED]"
      : step.status === "blocked" ? "[BLOCKED]"
      : step.status === "manual_review_required" ? "[REVIEW NEEDED]"
      : `[${step.status.toUpperCase()}]`;
    const label = step.stepKey.replace(/_/g, " ");
    return `- ${icon} ${label}${step.note ? ` -- ${step.note.slice(0, 80)}` : ""}`;
  });

  const sections = [
    `# Counterparty Vetting Report`,
    ``,
    `## Executive Summary`,
    `- Counterparty: ${snapshot.caseRecord.displayName}`,
    `- Legal Entity: ${snapshot.caseRecord.legalName ?? "Unknown"}`,
    `- Type: ${snapshot.caseRecord.counterpartyKind}`,
    `- Jurisdiction: ${formatJurisdiction(snapshot)}`,
    `- Status: ${snapshot.caseRecord.caseStatus.toUpperCase()}`,
    `- Recommendation: ${snapshot.caseRecord.recommendation.toUpperCase()}`,
    snapshot.caseRecord.decisionSummary ? `- Decision: ${snapshot.caseRecord.decisionSummary}` : "",
    `- Automated checks passed: ${passedCount}/${totalSteps}`,
    `- Open review tasks: ${manualReviewItems.length}`,
    `- Open issues: ${openIssues.length}`,
    ``,
    `## Screening Progress`,
    ...stepSummaryLines,
    ``,
    ...(manualReviewItems.length > 0 ? [
      `## Action Required`,
      `The following items require manual review before this case can be finalized:`,
      ``,
      ...manualReviewItems.map((task) => {
        const stepLabel = task.stepKey.replace(/_/g, " ");
        const stepSources = snapshot.artifacts
          .filter((a) => a.stepKey === task.stepKey && a.sourceUrl)
          .map((a) => `- Source: [${a.title}](${a.sourceUrl})`);
        const registryUrl = snapshot.caseRecord.registrySearchUrl;
        if (registryUrl && task.stepKey === "good_standing" && !stepSources.some((s) => s.includes(registryUrl))) {
          stepSources.push(`- Registry: [Company Search](${registryUrl})`);
        }
        return [
          `### ${stepLabel}: ${task.title}`,
          `- ${task.instructions}`,
          ...stepSources,
          ``,
        ].join("\n");
      }),
    ] : [
      `## Action Required`,
      `- No manual review items remain. This case is ready for finalization.`,
      ``,
    ]),
    ...(openIssues.length > 0 ? [
      `## Open Issues`,
      ...openIssues.map((issue) => `- [${issue.severity.toUpperCase()}] ${issue.stepKey.replace(/_/g, " ")}: ${issue.title}${issue.detail ? ` -- ${issue.detail.slice(0, 100)}` : ""}`),
      ``,
    ] : []),
    `## Case Details`,
    caseMetadata.join("\n"),
    ``,
    ...(knownEntityStructure ? [
      `## Entity Structure`,
      renderKnownEntityStructureSection(knownEntityStructure),
      ``,
    ] : []),
    `## Verified Facts`,
    verifiedFacts.length === 0
      ? `- None`
      : renderFactList(verifiedFacts, snapshot, artifactStore),
    ``,
    `## Inferred Findings`,
    inferredFacts.length === 0
      ? `- None`
      : renderFactList(inferredFacts, snapshot, artifactStore),
    ``,
    ...(unsupportedFacts.length > 0 ? [
      `## Unsupported Findings`,
      renderFactList(unsupportedFacts, snapshot, artifactStore),
      ``,
    ] : []),
    `## Source Index`,
    renderSourceIndex(snapshot, artifactStore),
    ``,
    ...(blockedChecks.length > 0 ? [
      `## Blocked Checks`,
      ...blockedChecks.map((step) => `- ${step.stepKey}: ${step.note ?? "Step did not complete successfully"}`),
      ``,
    ] : []),
    `## Resolved Review Decisions`,
    resolvedReviewItems.length === 0
      ? `- None`
      : resolvedReviewItems
          .map(
            (task) =>
              `- ${task.id}: ${task.title} outcome=${task.outcome ?? "unknown"}${task.resolutionNotes ? ` notes=${task.resolutionNotes}` : ""}`
          )
          .join("\n"),
    ``,
    `## Stage Reports`,
    stepReportArtifacts.length === 0
      ? `- None`
      : stepReportArtifacts
          .map((artifact) => formatStepReportEntry(artifact, artifactStore))
          .join("\n"),
    ``,
    `## Evidence Index`,
    evidenceArtifacts.length === 0
      ? `- None`
      : evidenceArtifacts
          .map((artifact) => formatArtifactEntry(artifact, artifactStore))
          .join("\n"),
    ``,
    `## Prior Cases`,
    snapshot.priorCases.length === 0
      ? `- None`
      : snapshot.priorCases
          .map(
            (priorCase) =>
              `- ${priorCase.id}: ${priorCase.caseStatus} / ${priorCase.recommendation}`
          )
          .join("\n"),
    ``,
    `## Workflow Snapshot`,
    snapshot.steps
      .map(
        (step) =>
          `- ${step.stepKey}: ${step.status}${step.note ? ` (${step.note})` : ""}`
      )
      .join("\n"),
    ``,
    `## Structured Snapshot`,
    "```json",
    formatJson({
      caseId: snapshot.caseRecord.id,
      recommendation: snapshot.caseRecord.recommendation,
      openReviewTaskIds: manualReviewItems.map((task) => task.id),
      openIssueIds: openIssues.map((issue) => issue.id),
    }),
    "```",
    ``,
    `## Traceability Gaps`,
    renderTraceabilityGaps(snapshot, artifactStore),
  ];

  return sections.join("\n");
}

function summarizeSnapshot(snapshot: CaseSnapshot): string {
  return `${snapshot.caseRecord.recommendation} / ${snapshot.caseRecord.caseStatus}`;
}

function summarizeReviewerPacket(snapshot: CaseSnapshot): string {
  const openReviewCount = snapshot.reviewTasks.filter(
    (task) => task.status === "open"
  ).length;
  return `${snapshot.caseRecord.caseStatus} / open_reviews=${openReviewCount}`;
}

function summarizeTraceability(
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore
): string {
  const factSourceGaps = snapshot.facts.filter(
    (fact) => !hasAccessibleFactSources(fact, snapshot, artifactStore)
  ).length;
  const issueSourceGaps = snapshot.issues.filter(
    (issue) => collectIssueSourceDescriptors(issue, snapshot, artifactStore).length === 0
  ).length;
  return `fact_source_gaps=${factSourceGaps} / issue_source_gaps=${issueSourceGaps}`;
}

function renderReviewerPacketMarkdown(
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore,
  workingReportArtifact: ArtifactRecord,
  finalReportArtifact: ArtifactRecord,
  traceabilityArtifact: ArtifactRecord,
  stepReportArtifacts: ArtifactRecord[]
): string {
  const openReviewTasks = snapshot.reviewTasks.filter((task) => task.status === "open");
  const openIssues = snapshot.issues.filter((issue) => issue.status === "open");
  const supportedFacts = snapshot.facts.filter((fact) =>
    hasAccessibleFactSources(fact, snapshot, artifactStore)
  );
  const unsupportedFacts = snapshot.facts.filter(
    (fact) => !hasAccessibleFactSources(fact, snapshot, artifactStore)
  );
  const verifiedFacts = supportedFacts.filter((fact) => fact.verificationStatus === "verified");
  const unresolvedStepKeys = new Set(openReviewTasks.map((task) => task.stepKey));
  const unresolvedStepReports = stepReportArtifacts.filter((artifact) =>
    unresolvedStepKeys.has(artifact.stepKey as WorkflowStepRecord["stepKey"])
  );
  const decisionChecklistEntries = buildDecisionChecklistEntries(
    snapshot,
    artifactStore,
    openReviewTasks,
    unresolvedStepReports
  );
  const prioritizedStepKeys = decisionChecklistEntries.map((entry) => entry.stepKey);
  const prioritizedStepKeySet = new Set(prioritizedStepKeys);
  const prioritizedUnresolvedStepReports = prioritizedStepKeys
    .map((stepKey) => unresolvedStepReports.find((artifact) => artifact.stepKey === stepKey) ?? null)
    .filter((artifact): artifact is ArtifactRecord => artifact != null);
  const knownEntityStructure = readKnownEntityStructure(snapshot);

  const sections = [
    `# Reviewer Packet`,
    ``,
    `## Case Snapshot`,
    `- Case ID: ${snapshot.caseRecord.id}`,
    `- Counterparty: ${snapshot.caseRecord.displayName}`,
    `- Legal Name: ${snapshot.caseRecord.legalName ?? "None"}`,
    `- Status: ${snapshot.caseRecord.caseStatus}`,
    `- Recommendation Snapshot: ${snapshot.caseRecord.recommendation}`,
    `- Decision Summary: ${snapshot.caseRecord.decisionSummary ?? "None"}`,
    `- Jurisdiction: ${formatJurisdiction(snapshot)}`,
    ``,
    `## Review Readiness`,
    renderCaseReadinessBanner(decisionChecklistEntries, artifactStore),
    ``,
    `## Case Bottlenecks`,
    renderCaseBottlenecks(decisionChecklistEntries),
    ``,
    `## Known Entity Structure`,
    renderKnownEntityStructureSection(knownEntityStructure),
    ``,
    `## Traceability Summary`,
    renderTraceabilitySummary(snapshot, artifactStore),
    ``,
    `## Reviewer Rule`,
    `- Use the linked stage reports and evidence to make the decision.`,
    `- Treat inferred findings as routing/context only unless they are supported by linked official evidence.`,
    `- Resolve each open review task with notes before final case approval.`,
    `- If the counterparty brand maps to multiple legal entities, confirm the in-scope contracting entity before clearing the case.`,
    ``,
    `## Decision Package`,
    renderDecisionPackage(decisionChecklistEntries, artifactStore),
    ``,
    `## Primary Documents`,
    `- ${buildMarkdownFileLink("Working report", artifactStore.resolveAbsolutePath(workingReportArtifact))}`,
    `- ${buildMarkdownFileLink("Current final PDF", artifactStore.resolveAbsolutePath(finalReportArtifact))}`,
    `- ${buildMarkdownFileLink("Traceability manifest", artifactStore.resolveAbsolutePath(traceabilityArtifact))}`,
    ...(prioritizedUnresolvedStepReports.length === 0 ? [`- No unresolved stage reports.`] : []),
    ...prioritizedUnresolvedStepReports.map((artifact) =>
      `- ${buildMarkdownFileLink(`${formatStepLabel(artifact.stepKey)} stage report`, artifactStore.resolveAbsolutePath(artifact))}`
    ),
    ``,
    `## Decision Checklist`,
    renderDecisionChecklist(decisionChecklistEntries, artifactStore),
    ``,
    `## What Requires A Decision`,
    decisionChecklistEntries.length === 0
      ? `- No open review tasks.`
      : renderDecisionTaskList(decisionChecklistEntries, openReviewTasks),
    ``,
    `## Verified Facts Only`,
    verifiedFacts.length === 0
      ? `- None`
      : renderFactList(verifiedFacts, snapshot, artifactStore),
    ``,
    `## Unsupported Findings`,
    unsupportedFacts.length === 0
      ? `- None`
      : renderFactList(unsupportedFacts, snapshot, artifactStore),
    ``,
    `## Source Index`,
    renderSourceIndex(snapshot, artifactStore, prioritizedStepKeySet),
    ``,
    `## Open Issues`,
    openIssues.length === 0
      ? `- None`
      : renderIssueList(openIssues, snapshot, artifactStore),
    ``,
    `## Reviewer Highlights`,
    renderReviewerHighlights(snapshot, prioritizedStepKeys, artifactStore),
    ``,
    `## Evidence By Unresolved Stage`,
    renderReviewerEvidenceSections(snapshot, artifactStore, prioritizedStepKeys),
    ``,
    `## Finalization Sequence`,
    `1. Review each unresolved stage report.`,
    `2. Open the linked evidence for that stage.`,
    `3. Resolve the review task with notes.`,
    `4. Rebuild the case report if needed.`,
    `5. Finalize the case only after all open review tasks are closed.`,
    ``,
    `## Traceability Gaps`,
    renderTraceabilityGaps(snapshot, artifactStore),
  ];

  return sections.join("\n");
}

function formatJurisdiction(snapshot: CaseSnapshot): string {
  const parts = [
    snapshot.caseRecord.incorporationCountry,
    snapshot.caseRecord.incorporationState,
  ].filter((value): value is string => Boolean(value));
  return parts.length === 0 ? "None" : parts.join(" / ");
}

type ReportKnownEntityStructure = {
  brand: string;
  scopeNote: string;
  entities: Array<{
    legalName?: string;
    jurisdiction?: string;
    role?: string;
    registrySearchUrl?: string | null;
    exactEntityName?: string | null;
    fileNumber?: string | null;
    sourceUrls?: string[];
    notes?: string[];
  }>;
};

function readKnownEntityStructure(snapshot: CaseSnapshot): ReportKnownEntityStructure | null {
  const fact = snapshot.facts.find((candidate) => candidate.factKey === "known_entity_structure");
  if (!fact) {
    return null;
  }

  const parsed = parseJson<Partial<ReportKnownEntityStructure>>(fact.valueJson, {});
  if (typeof parsed.brand !== "string" || typeof parsed.scopeNote !== "string") {
    return null;
  }

  return {
    brand: parsed.brand,
    scopeNote: parsed.scopeNote,
    entities: Array.isArray(parsed.entities)
      ? parsed.entities.filter(
          (
            entity
          ): entity is NonNullable<ReportKnownEntityStructure["entities"]>[number] =>
            Boolean(entity) && typeof entity === "object"
        )
      : [],
  };
}

function renderKnownEntityStructureSection(
  entityStructure: ReportKnownEntityStructure | null
): string {
  if (!entityStructure || entityStructure.entities.length === 0) {
    return "- No multi-entity routing structure was identified.";
  }

  return [
    `- Brand: ${entityStructure.brand}`,
    `- Scope Note: ${entityStructure.scopeNote}`,
    ...entityStructure.entities.flatMap((entity, index) => [
      `### Entity ${index + 1}`,
      `- Legal Name: ${entity.legalName ?? "None"}`,
      `- Jurisdiction: ${entity.jurisdiction ?? "None"}`,
      `- Role: ${entity.role ?? "None"}`,
      entity.registrySearchUrl ? `- Registry Route: ${entity.registrySearchUrl}` : null,
      entity.exactEntityName ? `- Exact Registry Target: ${entity.exactEntityName}` : null,
      entity.fileNumber ? `- File Number: ${entity.fileNumber}` : null,
      ...(entity.sourceUrls?.map(
        (url, index) => `- Supporting Source ${index + 1}: ${buildMarkdownUrlLink(url, url)}`
      ) ?? []),
      ...(entity.notes?.map((note) => `- Note: ${note}`) ?? []),
    ]),
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

function formatArtifactEntry(
  artifact: ArtifactRecord,
  artifactStore?: ArtifactStore
): string {
  const metadata = parseJson<Record<string, unknown>>(artifact.metadataJson, {});
  const sourceUrl =
    artifact.sourceUrl ??
    readStringMetadata(metadata, "finalUrl") ??
    readStringMetadata(metadata, "requestedUrl");
  const captureType = readStringMetadata(metadata, "captureType");
  const extras = [
    artifact.contentType,
    captureType,
    sourceUrl ? `source=${sourceUrl}` : null,
    artifactStore
      ? `file=${buildMarkdownFileLink("open", artifactStore.resolveAbsolutePath(artifact))}`
      : `path=${artifact.relativePath}`,
  ].filter((value): value is string => Boolean(value));

  return `- ${artifact.title} [${artifact.stepKey}] ${extras.join(" | ")}`;
}

function renderReviewerEvidenceSections(
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore,
  orderedStepKeys: Array<WorkflowStepRecord["stepKey"]>
): string {
  if (orderedStepKeys.length === 0) {
    return `- None`;
  }

  return orderedStepKeys
    .map((stepKey) => {
      const artifacts = snapshot.artifacts.filter(
        (artifact) =>
          artifact.stepKey === stepKey && artifact.storageBackend !== "local-report"
      );
      if (artifacts.length === 0) {
        return `- ${formatStepLabel(stepKey)}: no captured evidence files.`;
      }

      return [
        `- ${formatStepLabel(stepKey)}:`,
        ...artifacts.map((artifact) => `  - ${formatReviewerEvidenceLink(artifact, artifactStore)}`),
      ].join("\n");
    })
    .join("\n");
}

function selectTopEvidenceArtifacts(
  snapshot: CaseSnapshot,
  stepKey: WorkflowStepRecord["stepKey"],
  limit = 2
): ArtifactRecord[] {
  return snapshot.artifacts
    .filter(
      (artifact) =>
        artifact.stepKey === stepKey && artifact.storageBackend !== "local-report"
    )
    .sort(compareReviewerEvidenceArtifacts)
    .slice(0, limit);
}

function compareReviewerEvidenceArtifacts(
  left: ArtifactRecord,
  right: ArtifactRecord
): number {
  const leftPriority = reviewerEvidencePriority(left);
  const rightPriority = reviewerEvidencePriority(right);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  return left.title.localeCompare(right.title);
}

function reviewerEvidencePriority(artifact: ArtifactRecord): number {
  const metadata = parseJson<Record<string, unknown>>(artifact.metadataJson, {});
  const captureType = readStringMetadata(metadata, "captureType");
  if (captureType === "screenshot") {
    return 0;
  }
  if (captureType === "pdf") {
    return 1;
  }
  if (captureType === "html") {
    return 2;
  }
  if (artifact.contentType === "application/pdf") {
    return 3;
  }
  if (artifact.contentType.startsWith("image/")) {
    return 4;
  }
  if (artifact.contentType === "text/html") {
    return 5;
  }
  return 6;
}

function formatReviewerEvidenceLink(
  artifact: ArtifactRecord,
  artifactStore: ArtifactStore
): string {
  const absolutePath = artifactStore.resolveAbsolutePath(artifact);
  const metadata = parseJson<Record<string, unknown>>(artifact.metadataJson, {});
  const sourceUrl =
    artifact.sourceUrl ??
    readStringMetadata(metadata, "finalUrl") ??
    readStringMetadata(metadata, "requestedUrl");
  const authorityLabel = isAuthoritativeSourceId(artifact.sourceId)
    ? "authoritative"
    : "supporting";
  return `${buildMarkdownFileLink(artifact.title, absolutePath)} [${authorityLabel}]${sourceUrl ? ` source=${sourceUrl}` : ""}`;
}

function isAuthoritativeSourceId(sourceId: string | null): boolean {
  return (
    sourceId === "official_registry" ||
    sourceId === "public_market_listing" ||
    sourceId === "ofac_search" ||
    sourceId === "ofac_dataset"
  );
}

function renderDecisionChecklist(
  entries: DecisionChecklistEntry[],
  artifactStore: ArtifactStore,
): string {
  if (entries.length === 0) {
    return "- No open review stages.";
  }

  const summaryLines = [
    `- Open review stages: ${entries.length}`,
    `- Hard-gate stages: ${entries.filter((entry) => entry.step?.hardGate).length}`,
    `- Blocked on official evidence: ${entries.filter((entry) => isOfficialEvidenceBlocker(entry.readiness.label)).length}`,
    `- Stages with source gaps: ${entries.filter((entry) => entry.sourceGapFactCount > 0).length}`,
    `- Stale stages: ${entries.filter((entry) => entry.stageFreshness === "stale").length}`,
    `- Unknown freshness stages: ${entries.filter((entry) => entry.stageFreshness === "unknown").length}`,
    `- Refresh-first stages: ${entries.filter((entry) => entry.rerunRecommendation === "refresh_first").length}`,
    `- Authoritative-clearance stages: ${entries.filter((entry) => entry.clearancePath === "stage_report_then_authoritative_evidence" || entry.clearancePath === "authoritative_evidence_only").length}`,
    `- Multi-artifact review stages: ${entries.filter((entry) => entry.clearancePath === "multiple_artifacts_required").length}`,
    `- Well-supported stages: ${entries.filter((entry) => entry.reviewCompleteness === "well_supported").length}`,
    `- Thin or supporting-only stages: ${entries.filter((entry) => entry.reviewCompleteness === "supporting_only" || entry.reviewCompleteness === "thin").length}`,
    `- Ready-to-clear stages: ${entries.filter((entry) => entry.recommendedOutcome === "ready_to_clear_if_evidence_checks_out").length}`,
    `- Stages with review blockers: ${entries.filter((entry) => entry.reviewBlockers.length > 0).length}`,
  ];

  const entryLines = entries.map((entry) => {
      const pieces = [
        `status=${entry.step?.status ?? "unknown"}`,
        `hard_gate=${entry.step?.hardGate ? "yes" : "no"}`,
        `readiness=${entry.readiness.label}`,
        `review_snapshot=${entry.reviewSnapshot}`,
        `freshness=${entry.stageFreshness}`,
        `rerun_recommendation=${entry.rerunRecommendation}`,
        `clearance_path=${entry.clearancePath}`,
        `review_completeness=${entry.reviewCompleteness}`,
        `recommended_outcome=${entry.recommendedOutcome}`,
        entry.stageReport
          ? `stage_report=${buildMarkdownFileLink("open", artifactStore.resolveAbsolutePath(entry.stageReport))}`
          : "stage_report=missing",
        `evidence_files=${entry.evidenceCount}`,
        `authoritative_evidence=${entry.authoritativeEvidenceCount > 0 ? "yes" : "no"}${entry.authoritativeEvidenceCount > 0 ? `(${entry.authoritativeEvidenceCount})` : ""}`,
        `facts_with_sources=${entry.supportedFactCount}/${entry.stepFactCount}`,
        `source_gap_facts=${entry.sourceGapFactCount}`,
        `open_issues=${entry.openIssueCount}`,
        `review_tasks=${entry.taskSummaries.length}`,
      ];
      const lines = [
        `- ${formatStepLabel(entry.stepKey)} [${entry.stepKey}]: ${pieces.join(" | ")}`,
      ];
      if (entry.taskSummaries.length > 0) {
        lines.push(`  - Tasks: ${entry.taskSummaries.join("; ")}`);
      }
      lines.push(
        `  - Best next click: ${formatDecisionBestNextClick(entry, artifactStore)}`
      );
      lines.push(`  - Freshness note: ${entry.stageFreshnessNote}`);
      lines.push(`  - Rerun note: ${entry.rerunRecommendationReason}`);
      lines.push(`  - Clearance note: ${entry.clearancePathReason}`);
      lines.push(`  - Clear when: ${entry.clearanceCondition}`);
      lines.push(`  - Handoff note: ${entry.reviewHandoffNote}`);
      lines.push(`  - Priority note: ${entry.reviewPriorityReason}`);
      lines.push(`  - Coverage note: ${entry.reviewCompletenessReason}`);
      lines.push(`  - Outcome note: ${entry.recommendedOutcomeReason}`);
      lines.push(
        `  - Review blockers: ${
          entry.reviewBlockers.length === 0 ? "none" : entry.reviewBlockers.join("; ")
        }`
      );
      lines.push(
        `  - Top evidence: ${
          entry.topEvidence.length === 0
            ? "none captured"
            : entry.topEvidence
                .map((artifact) => formatReviewerEvidenceLink(artifact, artifactStore))
                .join("; ")
        }`
      );
      lines.push(`  - Reviewer action: ${entry.readiness.reviewerAction}`);
      if (entry.step?.note) {
        lines.push(`  - Stage note: ${entry.step.note}`);
      }
      return lines.join("\n");
    });

  return [...summaryLines, ...entryLines].join("\n");
}

function renderDecisionPackage(
  entries: DecisionChecklistEntry[],
  artifactStore: ArtifactStore,
): string {
  if (entries.length === 0) {
    return "- No open review stages.";
  }

  return entries
    .slice(0, 3)
    .map((entry, index) =>
      [
        `### Package ${index + 1}: ${formatStepLabel(entry.stepKey)} [${entry.stepKey}]`,
        `- Start here: ${formatDecisionBestNextClick(entry, artifactStore)}`,
        `- Clearance path: ${entry.clearancePath}`,
        `- Clear when: ${entry.clearanceCondition}`,
        `- Handoff: ${entry.reviewHandoffNote}`,
        `- Snapshot: ${entry.reviewSnapshot}`,
        `- Blockers: ${entry.reviewBlockers.length === 0 ? "none" : entry.reviewBlockers.join("; ")}`,
      ].join("\n")
    )
    .join("\n");
}

function renderCaseBottlenecks(entries: DecisionChecklistEntry[]): string {
  if (entries.length === 0) {
    return "- No unresolved case bottlenecks.";
  }

  return entries
    .slice(0, 2)
    .map((entry, index) => {
      const label = index === 0 ? "Primary blocker" : "Secondary blocker";
      const blockers =
        entry.reviewBlockers.length === 0 ? "none" : entry.reviewBlockers.join("; ");
      return `- ${label}: ${formatStepLabel(entry.stepKey)} [${entry.stepKey}] | ${entry.reviewSnapshot} | clear when ${entry.clearanceCondition} | blockers=${blockers}`;
    })
    .join("\n");
}

function renderCaseReadinessBanner(
  entries: DecisionChecklistEntry[],
  artifactStore: ArtifactStore,
): string {
  const banner = summarizeCaseReadinessBanner(entries);
  const firstEntry = entries[0];
  const firstFileToOpen =
    firstEntry == null ? "none" : formatDecisionBestNextClick(firstEntry, artifactStore);
  const decisionPathLength =
    firstEntry == null
      ? "no_review_work"
      : firstEntry.clearancePath === "authoritative_evidence_only"
        ? "one_file_decision"
        : firstEntry.clearancePath === "stage_report_then_authoritative_evidence"
          ? "two_file_decision"
          : "multi_artifact_decision";
  const primaryBlocker =
    firstEntry == null
      ? "none"
      : firstEntry.reviewBlockers.length > 0
        ? firstEntry.reviewBlockers[0]
        : "none";
  const reviewEntryPoint =
    firstEntry == null
      ? "none"
      : `Start with ${formatStepLabel(firstEntry.stepKey)} [${firstEntry.stepKey}] via ${firstFileToOpen}; clear when ${firstEntry.clearanceCondition}`;
  return `- Status: ${banner.status}\n- Mode: ${banner.mode}\n- Effort: ${banner.effort}\n- Next action: ${banner.nextAction}\n- First file to open: ${firstFileToOpen}\n- Decision path length: ${decisionPathLength}\n- Primary blocker: ${primaryBlocker}\n- Review entry point: ${reviewEntryPoint}\n- Completion target: ${banner.completionTarget}\n- Summary: ${banner.summary}`;
}

function summarizeCaseReadinessBanner(entries: DecisionChecklistEntry[]): {
  status:
    | "no_open_review_stages"
    | "contains_adverse_evidence"
    | "blocked_on_hard_gate_evidence"
    | "needs_evidence_refresh_or_completion"
    | "ready_for_human_review";
  mode:
    | "no_action_required"
    | "adjudicate_adverse_evidence"
    | "gather_evidence"
    | "clear_supported_stages";
  effort: "fast_review" | "moderate_review" | "heavy_review";
  nextAction:
    | "no_action_required"
    | "adjudicate_adverse_record"
    | "capture_hard_gate_evidence"
    | "refresh_or_complete_evidence"
    | "review_supported_stages";
  completionTarget: string;
  summary: string;
} {
  if (entries.length === 0) {
    return {
      status: "no_open_review_stages",
      mode: "no_action_required",
      effort: "fast_review",
      nextAction: "no_action_required",
      completionTarget: "No remaining review work.",
      summary: "Case has no open review stages.",
    };
  }

  const blockerCategories = new Set<string>();
  for (const entry of entries) {
    if ((entry.step?.hardGate ?? false) && isOfficialEvidenceBlocker(entry.readiness.label)) {
      blockerCategories.add("hard_gate_evidence");
    }
    if (entry.readiness.label === "adverse_evidence_present") {
      blockerCategories.add("adverse_evidence");
    }
    if (entry.rerunRecommendation === "refresh_first") {
      blockerCategories.add("refresh_needed");
    }
    if (entry.sourceGapFactCount > 0) {
      blockerCategories.add("source_gaps");
    }
    if (entry.openIssueCount > 0) {
      blockerCategories.add("open_issues");
    }
    if (
      entry.reviewCompleteness === "supporting_only" ||
      entry.reviewCompleteness === "thin"
    ) {
      blockerCategories.add("evidence_coverage");
    }
  }
  const completionTarget =
    blockerCategories.size === 0
      ? `Close ${entries.length} open stage${entries.length === 1 ? "" : "s"}.`
      : `Close ${entries.length} open stage${entries.length === 1 ? "" : "s"} and resolve ${blockerCategories.size} blocker categor${blockerCategories.size === 1 ? "y" : "ies"}.`;

  if (entries.some((entry) => entry.readiness.label === "adverse_evidence_present")) {
    return {
      status: "contains_adverse_evidence",
      mode: "adjudicate_adverse_evidence",
      effort: "heavy_review",
      nextAction: "adjudicate_adverse_record",
      completionTarget,
      summary:
        "Case contains adverse evidence and cannot be cleared until the adverse stage is resolved or disproven.",
    };
  }

  if (
    entries.some(
      (entry) =>
        (entry.step?.hardGate ?? false) && isOfficialEvidenceBlocker(entry.readiness.label)
    )
  ) {
    return {
      status: "blocked_on_hard_gate_evidence",
      mode: "gather_evidence",
      effort:
        entries.length >= 3 ||
        entries.some(
          (entry) =>
            entry.clearancePath === "multiple_artifacts_required" ||
            entry.sourceGapFactCount > 0
        )
          ? "heavy_review"
          : "moderate_review",
      nextAction: "capture_hard_gate_evidence",
      completionTarget,
      summary:
        "Case is blocked on hard-gate evidence and cannot be cleared until the required authoritative evidence is linked.",
    };
  }

  if (
    entries.some(
      (entry) =>
        entry.rerunRecommendation === "refresh_first" ||
        entry.reviewCompleteness === "supporting_only" ||
        entry.reviewCompleteness === "thin"
    )
  ) {
    return {
      status: "needs_evidence_refresh_or_completion",
      mode: "gather_evidence",
      effort:
        entries.filter(
          (entry) =>
            entry.rerunRecommendation === "refresh_first" ||
            entry.clearancePath === "multiple_artifacts_required" ||
            entry.sourceGapFactCount > 0
        ).length >= 2
          ? "heavy_review"
          : "moderate_review",
      nextAction: "refresh_or_complete_evidence",
      completionTarget,
      summary:
        "Case still needs fresher or stronger evidence before all unresolved stages are ready for final review.",
    };
  }

  return {
    status: "ready_for_human_review",
    mode: "clear_supported_stages",
    effort:
      entries.some(
        (entry) =>
          entry.clearancePath === "multiple_artifacts_required" ||
          entry.sourceGapFactCount > 0 ||
          entry.openIssueCount > 0
      )
        ? "moderate_review"
        : "fast_review",
    nextAction: "review_supported_stages",
    completionTarget,
    summary:
      "Case is ready for human evidence review; linked materials are present but still require reviewer judgment.",
  };
}

function formatDecisionBestNextClick(
  entry: DecisionChecklistEntry,
  artifactStore: ArtifactStore
): string {
  if (!entry.bestNextArtifact) {
    return "no linked file available";
  }

  if (entry.bestNextClickKind === "stage_report") {
    return `${buildMarkdownFileLink(
      `${formatStepLabel(entry.stepKey)} stage report`,
      artifactStore.resolveAbsolutePath(entry.bestNextArtifact)
    )} [stage_report]`;
  }

  const authorityLabel =
    entry.bestNextClickKind === "authoritative_evidence"
      ? "authoritative_evidence"
      : "supporting_evidence";
  return `${formatReviewerEvidenceLink(entry.bestNextArtifact, artifactStore)} [${authorityLabel}]`;
}

function buildDecisionChecklistEntries(
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore,
  openReviewTasks: ReviewTaskRecord[],
  unresolvedStepReports: ArtifactRecord[]
): DecisionChecklistEntry[] {
  const openStepKeys = uniqueStrings(openReviewTasks.map((task) => task.stepKey)) as Array<
    WorkflowStepRecord["stepKey"]
  >;

  return openStepKeys
    .map((stepKey) => {
      const step = snapshot.steps.find((candidate) => candidate.stepKey === stepKey) ?? null;
      const stepFacts = snapshot.facts.filter((fact) => fact.stepKey === stepKey);
      const supportedFactCount = stepFacts.filter((fact) =>
        hasAccessibleFactSources(fact, snapshot, artifactStore)
      ).length;
      const sourceGapFactCount = stepFacts.length - supportedFactCount;
      const stepIssues = snapshot.issues.filter(
        (issue) => issue.stepKey === stepKey && issue.status === "open"
      );
      const evidenceCount = snapshot.artifacts.filter(
        (artifact) =>
          artifact.stepKey === stepKey && artifact.storageBackend !== "local-report"
      ).length;
      const topEvidence = selectTopEvidenceArtifacts(snapshot, stepKey);
      const authoritativeEvidenceCount = snapshot.artifacts.filter(
        (artifact) =>
          artifact.stepKey === stepKey &&
          artifact.storageBackend !== "local-report" &&
          isAuthoritativeSourceId(artifact.sourceId)
      ).length;
      const stageReport =
        unresolvedStepReports.find((artifact) => artifact.stepKey === stepKey) ?? null;
      const bestNextArtifact =
        stageReport ??
        topEvidence.find((artifact) => isAuthoritativeSourceId(artifact.sourceId)) ??
        topEvidence[0] ??
        null;
      const bestNextClickKind: DecisionChecklistEntry["bestNextClickKind"] =
        stageReport != null
          ? "stage_report"
          : bestNextArtifact == null
            ? "none"
            : isAuthoritativeSourceId(bestNextArtifact.sourceId)
              ? "authoritative_evidence"
              : "supporting_evidence";
      const taskSummaries = openReviewTasks
        .filter((task) => task.stepKey === stepKey)
        .map((task) => task.title);
      const readiness = summarizeDecisionReadiness(
        step,
        evidenceCount,
        stepFacts.length,
        sourceGapFactCount,
        stepIssues.length,
        taskSummaries.length
      );
      const reviewCompleteness = summarizeReviewCompleteness(
        readiness.label,
        authoritativeEvidenceCount,
        evidenceCount,
        sourceGapFactCount,
        stepIssues.length
      );
      const stageFreshness = summarizeStageFreshness(stepFacts);
      const rerunRecommendation = summarizeRerunRecommendation(
        stageFreshness.label,
        step?.hardGate ?? false,
        readiness.label,
        reviewCompleteness.label
      );
      const clearancePath = summarizeClearancePath(
        step?.hardGate ?? false,
        readiness.label,
        reviewCompleteness.label,
        authoritativeEvidenceCount,
        evidenceCount,
        sourceGapFactCount,
        stepIssues.length,
        stageReport != null
      );
      const clearanceCondition = summarizeClearanceCondition(
        clearancePath.label,
        step?.hardGate ?? false,
        readiness.label
      );
      const reviewHandoffNote = summarizeReviewHandoffNote(
        clearancePath.label,
        rerunRecommendation.label,
        bestNextClickKind,
        step?.hardGate ?? false
      );
      const recommendedOutcome = summarizeRecommendedReviewerOutcome(
        readiness.label,
        reviewCompleteness.label
      );
      const reviewSnapshot = summarizeReviewSnapshot(
        step?.hardGate ?? false,
        readiness.label,
        reviewCompleteness.label,
        authoritativeEvidenceCount,
        sourceGapFactCount,
        stepIssues.length
      );
      const reviewBlockers = summarizeReviewBlockers(
        step?.hardGate ?? false,
        readiness.label,
        authoritativeEvidenceCount,
        evidenceCount,
        sourceGapFactCount,
        stepIssues.length
      );
      const reviewPriorityReason = summarizeReviewPriorityReason(
        step?.hardGate ?? false,
        readiness.label,
        sourceGapFactCount,
        stepIssues.length
      );
      return {
        stepKey,
        step,
        taskSummaries,
        readiness,
        reviewSnapshot,
        stageFreshness: stageFreshness.label,
        stageFreshnessNote: stageFreshness.note,
        rerunRecommendation: rerunRecommendation.label,
        rerunRecommendationReason: rerunRecommendation.reason,
        clearancePath: clearancePath.label,
        clearancePathReason: clearancePath.reason,
        clearanceCondition,
        reviewHandoffNote,
        reviewCompleteness: reviewCompleteness.label,
        reviewCompletenessReason: reviewCompleteness.reason,
        recommendedOutcome: recommendedOutcome.label,
        recommendedOutcomeReason: recommendedOutcome.reason,
        reviewPriorityReason,
        reviewBlockers,
        supportedFactCount,
        stepFactCount: stepFacts.length,
        sourceGapFactCount,
        openIssueCount: stepIssues.length,
        evidenceCount,
        authoritativeEvidenceCount,
        stageReport,
        topEvidence,
        bestNextClickKind,
        bestNextArtifact,
      };
    })
    .sort(compareDecisionChecklistEntries);
}

function compareDecisionChecklistEntries(
  left: DecisionChecklistEntry,
  right: DecisionChecklistEntry
): number {
  const leftPriority = decisionChecklistPriority(
    left.readiness.label,
    left.step?.hardGate ?? false
  );
  const rightPriority = decisionChecklistPriority(
    right.readiness.label,
    right.step?.hardGate ?? false
  );
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  if (left.sourceGapFactCount !== right.sourceGapFactCount) {
    return right.sourceGapFactCount - left.sourceGapFactCount;
  }
  if (left.openIssueCount !== right.openIssueCount) {
    return right.openIssueCount - left.openIssueCount;
  }
  return left.stepKey.localeCompare(right.stepKey);
}

function decisionChecklistPriority(readinessLabel: string, hardGate: boolean): number {
  const base =
    readinessLabel === "adverse_evidence_present"
      ? 0
      : readinessLabel === "blocked_missing_official_evidence"
        ? 1
        : readinessLabel === "awaiting_hard_gate_evidence"
          ? 2
          : readinessLabel === "review_with_source_gaps"
            ? 3
            : readinessLabel === "issue_only_review"
              ? 4
              : readinessLabel === "review_ready"
                ? 5
                : readinessLabel === "no_open_review_tasks"
                  ? 6
                  : 7;
  return hardGate ? base : base + 10;
}

function isOfficialEvidenceBlocker(readinessLabel: string): boolean {
  return (
    readinessLabel === "blocked_missing_official_evidence" ||
    readinessLabel === "awaiting_hard_gate_evidence"
  );
}

function summarizeDecisionReadiness(
  step: WorkflowStepRecord | null,
  evidenceCount: number,
  factCount: number,
  sourceGapFactCount: number,
  openIssueCount: number,
  openReviewTaskCount: number
): { label: string; reviewerAction: string } {
  if (!step) {
    return {
      label: "unknown",
      reviewerAction: "Confirm the current stage state before making a decision.",
    };
  }

  if (step.hardGate && step.status === "blocked") {
    return {
      label: "blocked_missing_official_evidence",
      reviewerAction:
        "Do not clear this stage yet. Add or capture the required official evidence, then re-run or resolve the review.",
    };
  }

  if (step.status === "failed") {
    return {
      label: "adverse_evidence_present",
      reviewerAction:
        "Treat this as adverse until the underlying evidence is disproven or superseded.",
    };
  }

  if (openReviewTaskCount === 0) {
    return {
      label: "no_open_review_tasks",
      reviewerAction: "No reviewer action is currently required for this stage.",
    };
  }

  if (evidenceCount === 0 && step.hardGate) {
    return {
      label: "awaiting_hard_gate_evidence",
      reviewerAction:
        "This hard gate should not be cleared without linked official evidence for the stage.",
    };
  }

  if (sourceGapFactCount > 0) {
    return {
      label: "review_with_source_gaps",
      reviewerAction:
        "Review carefully. Some findings in this stage are missing accessible sources and should not be relied on without checking linked evidence.",
    };
  }

  if (factCount === 0 && openIssueCount > 0) {
    return {
      label: "issue_only_review",
      reviewerAction:
        "Base the decision on the issue details and linked evidence for this stage.",
    };
  }

  return {
    label: "review_ready",
    reviewerAction:
      "Use the linked stage report and evidence to resolve the open review tasks for this stage.",
  };
}

function summarizeReviewCompleteness(
  readinessLabel: string,
  authoritativeEvidenceCount: number,
  evidenceCount: number,
  sourceGapFactCount: number,
  openIssueCount: number
): {
  label: DecisionChecklistEntry["reviewCompleteness"];
  reason: string;
} {
  if (
    readinessLabel === "blocked_missing_official_evidence" ||
    readinessLabel === "awaiting_hard_gate_evidence"
  ) {
    return {
      label: "blocked",
      reason:
        evidenceCount > 0
          ? "Supporting evidence exists, but the stage still lacks the authoritative evidence required to clear it."
          : "No authoritative evidence is linked yet for this stage.",
    };
  }

  if (authoritativeEvidenceCount > 0 && sourceGapFactCount === 0 && openIssueCount === 0) {
    return {
      label: "well_supported",
      reason:
        "Authoritative evidence is linked and there are no current source gaps or open issues for this stage.",
    };
  }

  if (authoritativeEvidenceCount > 0) {
    return {
      label: "supported_with_gaps",
      reason:
        sourceGapFactCount > 0 && openIssueCount > 0
          ? "Authoritative evidence exists, but source gaps remain and the stage still has open issues."
          : sourceGapFactCount > 0
            ? "Authoritative evidence exists, but some findings in this stage still have source gaps."
            : "Authoritative evidence exists, but the stage still has open issues to review.",
    };
  }

  if (evidenceCount > 0) {
    return {
      label: "supporting_only",
      reason:
        "Only supporting evidence is linked for this stage; authoritative evidence is still missing.",
    };
  }

  return {
    label: "thin",
    reason:
      "This stage has little or no linked evidence yet, so the reviewer is working from a thin record.",
  };
}

function summarizeRecommendedReviewerOutcome(
  readinessLabel: string,
  reviewCompleteness: DecisionChecklistEntry["reviewCompleteness"]
): {
  label: DecisionChecklistEntry["recommendedOutcome"];
  reason: string;
} {
  if (readinessLabel === "adverse_evidence_present") {
    return {
      label: "treat_as_adverse",
      reason:
        "This stage has failed or shows adverse evidence and should not be cleared without disproving the underlying record.",
    };
  }

  if (
    readinessLabel === "blocked_missing_official_evidence" ||
    readinessLabel === "awaiting_hard_gate_evidence" ||
    reviewCompleteness === "blocked" ||
    reviewCompleteness === "supporting_only" ||
    reviewCompleteness === "thin"
  ) {
    return {
      label: "gather_more_evidence",
      reason:
        "The stage is not yet supported strongly enough to clear; gather the missing authoritative or supporting evidence first.",
    };
  }

  if (reviewCompleteness === "well_supported") {
    return {
      label: "ready_to_clear_if_evidence_checks_out",
      reason:
        "Coverage is strong enough that a reviewer can likely clear this stage after checking the linked evidence.",
    };
  }

  return {
    label: "review_evidence_now",
    reason:
      "The stage has meaningful evidence attached, but the reviewer still needs to inspect it before deciding.",
  };
}

function summarizeReviewBlockers(
  hardGate: boolean,
  readinessLabel: string,
  authoritativeEvidenceCount: number,
  evidenceCount: number,
  sourceGapFactCount: number,
  openIssueCount: number
): string[] {
  const blockers: string[] = [];

  if (readinessLabel === "adverse_evidence_present") {
    blockers.push("adverse evidence present");
  }
  if (hardGate && authoritativeEvidenceCount === 0) {
    blockers.push("missing authoritative evidence");
  }
  if (evidenceCount === 0) {
    blockers.push("no evidence files linked");
  }
  if (sourceGapFactCount > 0) {
    blockers.push("source gaps remain");
  }
  if (openIssueCount > 0) {
    blockers.push("open issues remain");
  }

  return uniqueStrings(blockers);
}

function summarizeReviewPriorityReason(
  hardGate: boolean,
  readinessLabel: string,
  sourceGapFactCount: number,
  openIssueCount: number
): string {
  if (readinessLabel === "adverse_evidence_present") {
    return "Adverse evidence puts this stage at the top of the queue.";
  }
  if (hardGate && readinessLabel === "blocked_missing_official_evidence") {
    return "This hard gate is blocked on authoritative evidence and should be reviewed first.";
  }
  if (hardGate && readinessLabel === "awaiting_hard_gate_evidence") {
    return "This is a hard gate without enough evidence yet, so it stays near the top.";
  }
  if (sourceGapFactCount > 0) {
    return "Source gaps raise the review priority for this stage.";
  }
  if (openIssueCount > 0) {
    return "Open issues keep this stage ahead of routine review items.";
  }
  if (hardGate) {
    return "This is a hard-gate stage, so it is prioritized ahead of softer review steps.";
  }
  return "This is a routine review item after the higher-risk stages.";
}

function summarizeReviewSnapshot(
  hardGate: boolean,
  readinessLabel: string,
  reviewCompleteness: DecisionChecklistEntry["reviewCompleteness"],
  authoritativeEvidenceCount: number,
  sourceGapFactCount: number,
  openIssueCount: number
): string {
  if (readinessLabel === "adverse_evidence_present") {
    return "treat as adverse / evidence attached";
  }
  if (hardGate && authoritativeEvidenceCount === 0) {
    return "blocked / hard gate / no authoritative evidence";
  }
  if (reviewCompleteness === "well_supported") {
    return "ready to clear / authoritative evidence present";
  }
  if (reviewCompleteness === "supported_with_gaps") {
    if (sourceGapFactCount > 0 && openIssueCount > 0) {
      return "review now / authoritative evidence / gaps and issues remain";
    }
    if (sourceGapFactCount > 0) {
      return "review now / authoritative evidence / source gaps remain";
    }
    return "review now / authoritative evidence / open issues remain";
  }
  if (reviewCompleteness === "supporting_only") {
    return "gather evidence / supporting evidence only";
  }
  return "gather evidence / thin record";
}

function summarizeStageFreshness(
  facts: FactRecord[]
): { label: DecisionChecklistEntry["stageFreshness"]; note: string } {
  const freshnessValues = facts
    .map((fact) => fact.freshnessExpiresAt)
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => ({ raw: value, parsed: Date.parse(value) }))
    .filter((value) => Number.isFinite(value.parsed))
    .sort((left, right) => left.parsed - right.parsed);

  if (freshnessValues.length === 0) {
    return {
      label: "unknown",
      note: "No time-bound freshness window is recorded for this stage yet.",
    };
  }

  const earliestExpiry = freshnessValues[0];
  if (earliestExpiry == null) {
    return {
      label: "unknown",
      note: "No time-bound freshness window is recorded for this stage yet.",
    };
  }

  if (earliestExpiry.parsed <= Date.now()) {
    return {
      label: "stale",
      note: `At least one time-bound fact in this stage is stale as of ${earliestExpiry.raw}.`,
    };
  }

  return {
    label: "current",
    note: `The earliest recorded freshness window for this stage remains valid until ${earliestExpiry.raw}.`,
  };
}

function summarizeRerunRecommendation(
  stageFreshness: DecisionChecklistEntry["stageFreshness"],
  hardGate: boolean,
  readinessLabel: string,
  reviewCompleteness: DecisionChecklistEntry["reviewCompleteness"]
): {
  label: DecisionChecklistEntry["rerunRecommendation"];
  reason: string;
} {
  if (stageFreshness === "stale") {
    return {
      label: "refresh_first",
      reason:
        "At least one time-bound fact in this stage is stale, so refresh the evidence before relying on it.",
    };
  }

  if (
    stageFreshness === "unknown" &&
    (hardGate ||
      readinessLabel === "blocked_missing_official_evidence" ||
      readinessLabel === "awaiting_hard_gate_evidence" ||
      reviewCompleteness === "blocked")
  ) {
    return {
      label: "refresh_first",
      reason:
        "This stage has no recorded freshness window and still acts as a hard gate or evidence blocker, so refresh it before clearing.",
    };
  }

  if (stageFreshness === "unknown") {
    return {
      label: "review_current_evidence_then_refresh_if_needed",
      reason:
        "No freshness window is recorded for this stage, so review the linked evidence now and refresh it if the decision depends on recency.",
    };
  }

  return {
    label: "review_current_evidence",
    reason:
      "The linked evidence is still within its recorded freshness window, so the reviewer can work from the current capture set.",
  };
}

function summarizeClearancePath(
  hardGate: boolean,
  readinessLabel: string,
  reviewCompleteness: DecisionChecklistEntry["reviewCompleteness"],
  authoritativeEvidenceCount: number,
  evidenceCount: number,
  sourceGapFactCount: number,
  openIssueCount: number,
  hasStageReport: boolean
): {
  label: DecisionChecklistEntry["clearancePath"];
  reason: string;
} {
  if (
    readinessLabel === "blocked_missing_official_evidence" ||
    readinessLabel === "awaiting_hard_gate_evidence" ||
    reviewCompleteness === "blocked" ||
    reviewCompleteness === "thin" ||
    reviewCompleteness === "supporting_only" ||
    (hardGate && authoritativeEvidenceCount === 0) ||
    evidenceCount === 0
  ) {
    return {
      label: "additional_evidence_required",
      reason:
        "This stage cannot be cleared from the current packet alone; additional or stronger evidence is still required first.",
    };
  }

  if (sourceGapFactCount > 0 || openIssueCount > 0 || readinessLabel === "adverse_evidence_present") {
    return {
      label: "multiple_artifacts_required",
      reason:
        "This stage still has gaps, issues, or adverse signals, so the reviewer should inspect multiple linked artifacts before deciding.",
    };
  }

  if (hasStageReport && authoritativeEvidenceCount > 0) {
    return {
      label: "stage_report_then_authoritative_evidence",
      reason:
        "Start with the stage report for context, then confirm the decision against the linked authoritative evidence.",
    };
  }

  if (authoritativeEvidenceCount > 0) {
    return {
      label: "authoritative_evidence_only",
      reason:
        "This stage can be cleared from the linked authoritative evidence after a direct reviewer check.",
    };
  }

  return {
    label: "additional_evidence_required",
    reason:
      "This stage does not yet have a clear evidence path for clearance and needs more support first.",
  };
}

function summarizeClearanceCondition(
  clearancePath: DecisionChecklistEntry["clearancePath"],
  hardGate: boolean,
  readinessLabel: string
): string {
  if (clearancePath === "additional_evidence_required") {
    return hardGate ||
      readinessLabel === "blocked_missing_official_evidence" ||
      readinessLabel === "awaiting_hard_gate_evidence"
      ? "Clear only after the required authoritative evidence is linked for this stage."
      : "Clear only after stronger linked evidence is added and the current blockers are resolved.";
  }

  if (clearancePath === "multiple_artifacts_required") {
    return readinessLabel === "adverse_evidence_present"
      ? "Clear only if the linked adverse record is disproven or resolved and the remaining blockers are closed."
      : "Clear only after reviewing the linked artifacts together and resolving any remaining gaps or open issues.";
  }

  if (clearancePath === "stage_report_then_authoritative_evidence") {
    return "Clear after the stage report matches the linked authoritative evidence and no review blockers remain.";
  }

  return "Clear after a direct check of the linked authoritative evidence confirms the stage result.";
}

function summarizeReviewHandoffNote(
  clearancePath: DecisionChecklistEntry["clearancePath"],
  rerunRecommendation: DecisionChecklistEntry["rerunRecommendation"],
  bestNextClickKind: DecisionChecklistEntry["bestNextClickKind"],
  hardGate: boolean
): string {
  if (rerunRecommendation === "refresh_first") {
    return hardGate
      ? "Refresh or capture the required official evidence first, then reopen the stage report and reassess."
      : "Refresh the linked evidence first, then review the stage again with the updated capture set.";
  }

  if (clearancePath === "stage_report_then_authoritative_evidence") {
    return "Open the stage report first, then verify the decision against the linked authoritative evidence before clearing.";
  }

  if (clearancePath === "authoritative_evidence_only") {
    return "Open the linked authoritative evidence directly and confirm it matches the recorded stage result.";
  }

  if (clearancePath === "multiple_artifacts_required") {
    return "Use the stage report for context, then review the linked artifacts together and resolve the remaining blockers before deciding.";
  }

  return bestNextClickKind === "none"
    ? "Gather additional evidence before attempting to clear this stage."
    : "Open the linked evidence first, then add the missing support needed to clear this stage.";
}

function renderStepReportMarkdown(
  snapshot: CaseSnapshot,
  step: WorkflowStepRecord,
  stepOrder: number,
  artifactStore: ArtifactStore
): string {
  const stepFacts = snapshot.facts.filter((fact) => fact.stepKey === step.stepKey);
  const supportedFacts = stepFacts.filter((fact) =>
    hasAccessibleFactSources(fact, snapshot, artifactStore)
  );
  const unsupportedFacts = stepFacts.filter(
    (fact) => !hasAccessibleFactSources(fact, snapshot, artifactStore)
  );
  const verifiedFacts = supportedFacts.filter((fact) => fact.verificationStatus === "verified");
  const inferredFacts = supportedFacts.filter((fact) => fact.verificationStatus === "inferred");
  const unverifiedFacts = supportedFacts.filter(
    (fact) => fact.verificationStatus === "unverified"
  );
  const conflictedFacts = supportedFacts.filter(
    (fact) => fact.verificationStatus === "conflicted"
  );
  const openIssues = snapshot.issues.filter(
    (issue) => issue.stepKey === step.stepKey && issue.status === "open"
  );
  const openReviewTasks = snapshot.reviewTasks.filter(
    (task) => task.stepKey === step.stepKey && task.status === "open"
  );
  const resolvedReviewTasks = snapshot.reviewTasks.filter(
    (task) => task.stepKey === step.stepKey && task.status === "resolved"
  );
  const evidenceArtifacts = snapshot.artifacts.filter(
    (artifact) =>
      artifact.stepKey === step.stepKey && artifact.storageBackend !== "local-report"
  );

  return [
    `# ${String(stepOrder).padStart(2, "0")} ${formatStepLabel(step.stepKey)} Report`,
    ``,
    `## Step Metadata`,
    `- Case ID: ${snapshot.caseRecord.id}`,
    `- Counterparty: ${snapshot.caseRecord.displayName}`,
    `- Step Key: ${step.stepKey}`,
    `- Step Status: ${step.status}`,
    `- Hard Gate: ${step.hardGate ? "yes" : "no"}`,
    `- Case Status Snapshot: ${snapshot.caseRecord.caseStatus}`,
    `- Recommendation Snapshot: ${snapshot.caseRecord.recommendation}`,
    `- Stage Note: ${step.note ?? "None"}`,
    `- Started At: ${step.startedAt ?? "None"}`,
    `- Completed At: ${step.completedAt ?? "None"}`,
    `- Updated At: ${step.updatedAt}`,
    ``,
    `## Operator Next Action`,
    renderStepOutcomeGuidance(step, openReviewTasks, openIssues),
    ``,
    `## Traceability Summary`,
    renderTraceabilitySummaryForFactsAndIssues(stepFacts, openIssues, snapshot, artifactStore),
    ``,
    `## Verified Facts`,
    renderFactList(verifiedFacts, snapshot, artifactStore),
    ``,
    `## Inferred Findings`,
    renderFactList(inferredFacts, snapshot, artifactStore),
    ``,
    `## Unverified Items`,
    renderFactList(unverifiedFacts, snapshot, artifactStore),
    ``,
    `## Conflicts`,
    renderFactList(conflictedFacts, snapshot, artifactStore),
    ``,
    `## Unsupported Findings`,
    renderFactList(unsupportedFacts, snapshot, artifactStore),
    ``,
    `## Source Index`,
    renderSourceIndex(snapshot, artifactStore, new Set([step.stepKey])),
    ``,
    `## Open Issues`,
    renderIssueList(openIssues, snapshot, artifactStore),
    ``,
    `## Manual Review Items`,
    renderReviewTaskList(openReviewTasks),
    ``,
    `## Resolved Review Decisions`,
    renderResolvedReviewTaskList(resolvedReviewTasks),
    ``,
    `## Evidence`,
    evidenceArtifacts.length === 0
      ? `- None`
      : evidenceArtifacts
          .map((artifact) => formatArtifactEntry(artifact, artifactStore))
          .join("\n"),
    ``,
    `## Completion Standard`,
    `- This stage is complete only when the evidence is captured and the step is passed or skipped with an explicit policy reason.`,
    `- If the stage is awaiting review, resolve every open review item with notes before final approval.`,
    ``,
    `## Traceability Gaps`,
    renderTraceabilityGapsForFactsAndIssues(stepFacts, openIssues, snapshot, artifactStore),
  ].join("\n");
}

function renderStepOutcomeGuidance(
  step: WorkflowStepRecord,
  openReviewTasks: ReviewTaskRecord[],
  openIssues: IssueRecord[]
): string {
  if (step.status === "manual_review_required") {
    const nextAction =
      openReviewTasks.length === 0
        ? "Manual review is required before the case can proceed."
        : openReviewTasks.map((task) => task.instructions).join(" ");
    return `- Awaiting review. ${nextAction}`;
  }

  if (step.status === "blocked") {
    return `- Blocked. ${step.note ?? "Provide missing official evidence or case data and requeue the workflow."}`;
  }

  if (step.status === "failed") {
    return `- Failed. Treat this as adverse evidence unless the underlying capture is proven incorrect.`;
  }

  if (step.status === "passed") {
    if (openReviewTasks.length > 0) {
      return `- Passed for routing or evidence capture, but reviewer follow-up is still required. ${openReviewTasks
        .map((task) => task.instructions)
        .join(" ")}`;
    }
    return `- Passed. No further action is required for this stage unless later evidence creates a contradiction.`;
  }

  if (step.status === "skipped") {
    return `- Skipped. ${step.note ?? "This stage was intentionally bypassed by policy."}`;
  }

  if (openIssues.length > 0) {
    return `- ${openIssues[0]?.detail ?? "This stage has unresolved issues."}`;
  }

  return `- ${step.note ?? "Stage state recorded."}`;
}

function renderTraceabilitySummary(
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore
): string {
  return renderTraceabilitySummaryForFactsAndIssues(
    snapshot.facts,
    snapshot.issues.filter((issue) => issue.status === "open"),
    snapshot,
    artifactStore
  );
}

function renderTraceabilitySummaryForFactsAndIssues(
  facts: FactRecord[],
  issues: IssueRecord[],
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore
): string {
  const factsWithSourceRefs = facts.filter(
    (fact) => collectFactSourceReferences(fact, snapshot, artifactStore).length > 0
  ).length;
  const issuesWithSourceRefs = issues.filter(
    (issue) => collectIssueSourceReferences(issue, snapshot, artifactStore).length > 0
  ).length;

  return [
    `- Facts total: ${facts.length}`,
    `- Facts with accessible sources: ${factsWithSourceRefs}`,
    `- Facts missing accessible sources: ${facts.length - factsWithSourceRefs}`,
    `- Open issues with accessible sources: ${issuesWithSourceRefs}/${issues.length}`,
  ].join("\n");
}

function renderTraceabilityGaps(
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore
): string {
  return renderTraceabilityGapsForFactsAndIssues(
    snapshot.facts,
    snapshot.issues.filter((issue) => issue.status === "open"),
    snapshot,
    artifactStore
  );
}

function renderTraceabilityGapsForFactsAndIssues(
  facts: FactRecord[],
  issues: IssueRecord[],
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore
): string {
  const missingSourceFacts = facts.filter((fact) => !fact.sourceId);
  const missingAccessibleSourceFacts = facts.filter(
    (fact) => collectFactSourceReferences(fact, snapshot, artifactStore).length === 0
  );
  const missingAccessibleSourceIssues = issues.filter(
    (issue) => collectIssueSourceReferences(issue, snapshot, artifactStore).length === 0
  );

  const lines: string[] = [];
  if (missingSourceFacts.length > 0) {
    lines.push("- Facts missing source IDs:");
    lines.push(
      ...missingSourceFacts.map((fact) => `  - ${formatFactEntry(fact, snapshot, artifactStore)}`)
    );
  }
  if (missingAccessibleSourceFacts.length > 0) {
    lines.push("- Facts missing accessible sources:");
    lines.push(
      ...missingAccessibleSourceFacts.map(
        (fact) => `  - ${formatFactEntry(fact, snapshot, artifactStore)}`
      )
    );
  }
  if (missingAccessibleSourceIssues.length > 0) {
    lines.push("- Open issues missing accessible sources:");
    lines.push(
      ...missingAccessibleSourceIssues.map(
        (issue) => `  - ${formatIssueEntry(issue, snapshot, artifactStore)}`
      )
    );
  }

  return lines.length === 0 ? "- None" : lines.join("\n");
}

function renderSourceIndex(
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore,
  stepKeys?: Set<WorkflowStepRecord["stepKey"]>
): string {
  const entries = buildSourceIndexEntries(snapshot, artifactStore, stepKeys);
  if (entries.length === 0) {
    return "- None";
  }

  return entries
    .map((entry) => {
      const factLabel =
        entry.factSummaries.length === 0
          ? "facts=0"
          : `facts=${entry.factSummaries.length} (${summarizeList(entry.factSummaries)})`;
      const issueLabel =
        entry.issueTitles.length === 0
          ? "issues=0"
          : `issues=${entry.issueTitles.length} (${summarizeList(entry.issueTitles)})`;
      const sourceIdLabel =
        entry.sourceIds.length === 0 ? "source_ids=none" : `source_ids=${entry.sourceIds.join(",")}`;
      const stepLabel =
        entry.stepKeys.length === 0 ? "steps=none" : `steps=${entry.stepKeys.join(",")}`;
      return `- ${entry.descriptor.markdown} | ${sourceIdLabel} | ${stepLabel} | ${factLabel} | ${issueLabel}`;
    })
    .join("\n");
}

function buildSourceIndexEntries(
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore,
  stepKeys?: Set<WorkflowStepRecord["stepKey"]>
): SourceIndexEntry[] {
  const entries = new Map<string, SourceIndexEntry>();
  const includeStep = (stepKey: WorkflowStepRecord["stepKey"]): boolean =>
    !stepKeys || stepKeys.has(stepKey);

  for (const fact of snapshot.facts) {
    if (!includeStep(fact.stepKey)) {
      continue;
    }
    for (const descriptor of collectFactSourceDescriptors(fact, snapshot, artifactStore)) {
      const entry = ensureSourceIndexEntry(entries, descriptor);
      entry.factSummaries.push(fact.summary);
      if (fact.sourceId) {
        entry.sourceIds.push(fact.sourceId);
      }
      entry.stepKeys.push(fact.stepKey);
    }
  }

  for (const issue of snapshot.issues.filter((candidate) => candidate.status === "open")) {
    if (!includeStep(issue.stepKey)) {
      continue;
    }
    for (const descriptor of collectIssueSourceDescriptors(issue, snapshot, artifactStore)) {
      const entry = ensureSourceIndexEntry(entries, descriptor);
      entry.issueTitles.push(issue.title);
      entry.stepKeys.push(issue.stepKey);
    }
  }

  return Array.from(entries.values())
    .map((entry) => ({
      ...entry,
      factSummaries: uniqueStrings(entry.factSummaries),
      issueTitles: uniqueStrings(entry.issueTitles),
      sourceIds: uniqueStrings(entry.sourceIds),
      stepKeys: uniqueStrings(entry.stepKeys),
    }))
    .sort((left, right) => {
      const rightWeight = right.factSummaries.length + right.issueTitles.length;
      const leftWeight = left.factSummaries.length + left.issueTitles.length;
      return rightWeight - leftWeight || left.descriptor.label.localeCompare(right.descriptor.label);
    });
}

function ensureSourceIndexEntry(
  entries: Map<string, SourceIndexEntry>,
  descriptor: SourceDescriptor
): SourceIndexEntry {
  const existing = entries.get(descriptor.key);
  if (existing) {
    return existing;
  }

  const created: SourceIndexEntry = {
    descriptor,
    factSummaries: [],
    issueTitles: [],
    sourceIds: descriptor.sourceId ? [descriptor.sourceId] : [],
    stepKeys: [],
  };
  entries.set(descriptor.key, created);
  return created;
}

function buildTraceabilityManifest(
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore,
  publishedArtifacts: {
    working: ArtifactRecord;
    final: ArtifactRecord;
    stepReports: ArtifactRecord[];
  }
): Record<string, unknown> {
  const openIssues = snapshot.issues.filter((issue) => issue.status === "open");
  const sourceIndex = buildSourceIndexEntries(snapshot, artifactStore).map((entry) => ({
    type: entry.descriptor.type,
    label: entry.descriptor.label,
    absolutePath: entry.descriptor.absolutePath,
    url: entry.descriptor.url,
    sourceId: entry.descriptor.sourceId,
    artifactId: entry.descriptor.artifactId,
    stepKeys: entry.stepKeys,
    factSummaries: entry.factSummaries,
    issueTitles: entry.issueTitles,
  }));

  return {
    generatedAt: new Date().toISOString(),
    case: {
      id: snapshot.caseRecord.id,
      displayName: snapshot.caseRecord.displayName,
      legalName: snapshot.caseRecord.legalName,
      caseStatus: snapshot.caseRecord.caseStatus,
      recommendation: snapshot.caseRecord.recommendation,
      decisionSummary: snapshot.caseRecord.decisionSummary,
      policyVersion: snapshot.caseRecord.policyVersion,
      decisionMatrixVersion: snapshot.caseRecord.decisionMatrixVersion,
    },
    reports: {
      working: artifactStore.resolveAbsolutePath(publishedArtifacts.working),
      final: artifactStore.resolveAbsolutePath(publishedArtifacts.final),
      stepReports: publishedArtifacts.stepReports.map((artifact) => ({
        stepKey: artifact.stepKey,
        path: artifactStore.resolveAbsolutePath(artifact),
      })),
    },
    traceabilitySummary: {
      factCount: snapshot.facts.length,
      supportedFactCount: snapshot.facts.filter((fact) =>
        hasAccessibleFactSources(fact, snapshot, artifactStore)
      ).length,
      unsupportedFactCount: snapshot.facts.filter(
        (fact) => !hasAccessibleFactSources(fact, snapshot, artifactStore)
      ).length,
      openIssueCount: openIssues.length,
      openIssueWithSourcesCount: openIssues.filter(
        (issue) => collectIssueSourceDescriptors(issue, snapshot, artifactStore).length > 0
      ).length,
      sourceIndexCount: sourceIndex.length,
    },
    facts: snapshot.facts.map((fact) => ({
      id: fact.id,
      stepKey: fact.stepKey,
      factKey: fact.factKey,
      summary: fact.summary,
      verificationStatus: fact.verificationStatus,
      sourceId: fact.sourceId,
      freshnessExpiresAt: fact.freshnessExpiresAt,
      evidenceIds: fact.evidenceIds,
      sourceDescriptors: collectFactSourceDescriptors(fact, snapshot, artifactStore).map(
        serializeSourceDescriptor
      ),
    })),
    openIssues: openIssues.map((issue) => ({
      id: issue.id,
      stepKey: issue.stepKey,
      severity: issue.severity,
      title: issue.title,
      detail: issue.detail,
      evidenceIds: issue.evidenceIds,
      sourceDescriptors: collectIssueSourceDescriptors(issue, snapshot, artifactStore).map(
        serializeSourceDescriptor
      ),
    })),
    sourceIndex,
  };
}

function serializeSourceDescriptor(descriptor: SourceDescriptor): Record<string, unknown> {
  return {
    type: descriptor.type,
    label: descriptor.label,
    absolutePath: descriptor.absolutePath,
    url: descriptor.url,
    sourceId: descriptor.sourceId,
    artifactId: descriptor.artifactId,
  };
}

function summarizeList(values: string[], maxItems = 3): string {
  const visible = values.slice(0, maxItems);
  const remaining = values.length - visible.length;
  return remaining > 0 ? `${visible.join("; ")}; +${remaining} more` : visible.join("; ");
}

function hasAccessibleFactSources(
  fact: FactRecord,
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore
): boolean {
  return collectFactSourceDescriptors(fact, snapshot, artifactStore).length > 0;
}

function renderFactList(
  facts: FactRecord[],
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore
): string {
  return facts.length === 0
    ? `- None`
    : facts.map((fact) => formatFactEntry(fact, snapshot, artifactStore)).join("\n");
}

function renderReviewerHighlights(
  snapshot: CaseSnapshot,
  orderedStepKeys: Array<WorkflowStepRecord["stepKey"]>,
  artifactStore: ArtifactStore
): string {
  const lines = orderedStepKeys.flatMap((stepKey) =>
    snapshot.facts
      .filter(
        (fact) =>
          fact.stepKey === stepKey &&
          (fact.verificationStatus === "inferred" ||
            fact.verificationStatus === "unverified" ||
            fact.verificationStatus === "conflicted")
      )
      .map(
        (fact) =>
          `- ${formatStepLabel(fact.stepKey)}: ${formatFactEntry(
            fact,
            snapshot,
            artifactStore
          ).replace(/^- /, "")}`
      )
  );

  return lines.length === 0 ? `- None` : lines.join("\n");
}

function renderDecisionTaskList(
  entries: DecisionChecklistEntry[],
  openReviewTasks: ReviewTaskRecord[]
): string {
  const lines = entries.flatMap((entry) =>
    openReviewTasks
      .filter((task) => task.stepKey === entry.stepKey)
      .map((task) => `- ${task.title} [${task.stepKey}]: ${task.instructions}`)
  );
  return lines.length === 0 ? `- No open review tasks.` : lines.join("\n");
}

function renderIssueList(
  issues: IssueRecord[],
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore
): string {
  return issues.length === 0
    ? `- None`
    : issues.map((issue) => formatIssueEntry(issue, snapshot, artifactStore)).join("\n");
}

function formatFactEntry(
  fact: FactRecord,
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore
): string {
  const sourceReferences = collectFactSourceReferences(fact, snapshot, artifactStore);
  const extras = [
    `verification=${fact.verificationStatus}`,
    `source=${fact.sourceId ?? "missing"}`,
    fact.freshnessExpiresAt ? `fresh_until=${fact.freshnessExpiresAt}` : null,
    sourceReferences.length === 0 ? "sources=missing" : `sources=${sourceReferences.join(", ")}`,
  ].filter((value): value is string => Boolean(value));

  const prefix = sourceReferences.length === 0 ? "[SOURCE GAP] " : "";
  return `- ${prefix}${fact.summary} | ${extras.join(" | ")}`;
}

function formatIssueEntry(
  issue: IssueRecord,
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore
): string {
  const sourceReferences = collectIssueSourceReferences(issue, snapshot, artifactStore);
  const sourcePart =
    sourceReferences.length === 0 ? "sources=missing" : `sources=${sourceReferences.join(", ")}`;

  return `- [${issue.severity}] ${issue.title}: ${issue.detail} | ${sourcePart}`;
}

function resolveEvidenceArtifacts(
  snapshot: CaseSnapshot,
  evidenceIds: string[]
): ArtifactRecord[] {
  return evidenceIds
    .map((evidenceId) => snapshot.artifacts.find((artifact) => artifact.id === evidenceId) ?? null)
    .filter((artifact): artifact is ArtifactRecord => artifact != null);
}

function formatArtifactLinks(
  artifacts: ArtifactRecord[],
  artifactStore: ArtifactStore,
  maxLinks = 2
): string {
  const visible = artifacts.slice(0, maxLinks).map((artifact) =>
    buildArtifactSourceDescriptor(artifact, artifactStore, artifact.sourceId).markdown
  );
  const remaining = artifacts.length - visible.length;
  return remaining > 0 ? `${visible.join(", ")} (+${remaining} more)` : visible.join(", ");
}

function collectFactSourceReferences(
  fact: FactRecord,
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore
): string[] {
  return collectFactSourceDescriptors(fact, snapshot, artifactStore).map(
    (descriptor) => descriptor.markdown
  );
}

function collectIssueSourceReferences(
  issue: IssueRecord,
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore
): string[] {
  return collectIssueSourceDescriptors(issue, snapshot, artifactStore).map(
    (descriptor) => descriptor.markdown
  );
}

function collectFactSourceDescriptors(
  fact: FactRecord,
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore
): SourceDescriptor[] {
  return uniqueSourceDescriptors([
    ...resolveEvidenceArtifacts(snapshot, fact.evidenceIds).map((artifact) =>
      buildArtifactSourceDescriptor(artifact, artifactStore, fact.sourceId)
    ),
    ...extractUrlSourceDescriptors(fact.valueJson, fact.sourceId),
  ]);
}

function collectIssueSourceDescriptors(
  issue: IssueRecord,
  snapshot: CaseSnapshot,
  artifactStore: ArtifactStore
): SourceDescriptor[] {
  return uniqueSourceDescriptors(
    resolveEvidenceArtifacts(snapshot, issue.evidenceIds).map((artifact) =>
      buildArtifactSourceDescriptor(artifact, artifactStore, artifact.sourceId)
    )
  );
}

function buildArtifactSourceDescriptor(
  artifact: ArtifactRecord,
  artifactStore: ArtifactStore,
  sourceId: string | null
): SourceDescriptor {
  const absolutePath = artifactStore.resolveAbsolutePath(artifact);
  const fileLink = buildMarkdownFileLink(artifact.title, absolutePath);
  return {
    key: `artifact:${artifact.id}`,
    type: "artifact",
    label: artifact.title,
    markdown: artifact.sourceUrl
      ? `${fileLink} (${buildMarkdownUrlLink("origin", artifact.sourceUrl)})`
      : fileLink,
    absolutePath,
    url: artifact.sourceUrl ?? null,
    sourceId: sourceId ?? artifact.sourceId,
    artifactId: artifact.id,
  };
}

function extractUrlSourceDescriptors(
  valueJson: string,
  sourceId: string | null
): SourceDescriptor[] {
  const parsed = parseJson<unknown>(valueJson, null);
  return uniqueStrings(collectUrlsFromUnknown(parsed)).map((url, index) => ({
    key: `url:${url}`,
    type: "url",
    label: `source-${index + 1}`,
    markdown: buildMarkdownUrlLink(`source-${index + 1}`, url),
    absolutePath: null,
    url,
    sourceId,
    artifactId: null,
  }));
}

function uniqueSourceDescriptors(descriptors: SourceDescriptor[]): SourceDescriptor[] {
  const seen = new Set<string>();
  const result: SourceDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.key)) {
      continue;
    }
    seen.add(descriptor.key);
    result.push(descriptor);
  }
  return result;
}

function collectUrlsFromUnknown(value: unknown): string[] {
  if (typeof value === "string") {
    return /^https?:\/\//i.test(value.trim()) ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return uniqueStrings(value.flatMap((item) => collectUrlsFromUnknown(item)));
  }
  if (value && typeof value === "object") {
    return uniqueStrings(
      Object.values(value as Record<string, unknown>).flatMap((item) =>
        collectUrlsFromUnknown(item)
      )
    );
  }

  return [];
}

function renderReviewTaskList(tasks: ReviewTaskRecord[]): string {
  return tasks.length === 0
    ? `- None`
    : tasks
        .map((task) => `- ${task.title}: ${task.instructions}`)
        .join("\n");
}

function renderResolvedReviewTaskList(tasks: ReviewTaskRecord[]): string {
  return tasks.length === 0
    ? `- None`
    : tasks
        .map(
          (task) =>
            `- ${task.title}: outcome=${task.outcome ?? "unknown"}${task.resolutionNotes ? ` notes=${task.resolutionNotes}` : ""}`
        )
        .join("\n");
}

function formatStepReportEntry(
  artifact: ArtifactRecord,
  artifactStore?: ArtifactStore
): string {
  const metadata = parseJson<Record<string, unknown>>(artifact.metadataJson, {});
  const stepStatus = readStringMetadata(metadata, "stepStatus") ?? "unknown";
  const pathPart = artifactStore
    ? `file=${buildMarkdownFileLink("open", artifactStore.resolveAbsolutePath(artifact))}`
    : `path=${artifact.relativePath}`;
  return `- ${artifact.title}: ${stepStatus} | ${pathPart}`;
}

function formatStepLabel(stepKey: string): string {
  return stepKey
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildMarkdownFileLink(label: string, absolutePath: string): string {
  return `[${label}](${toMarkdownFilePath(absolutePath)})`;
}

function buildMarkdownUrlLink(label: string, url: string): string {
  return `[${label}](${url})`;
}

function toMarkdownFilePath(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, "/");
  const withLeadingSlash = normalized.startsWith("/")
    ? normalized
    : `/${normalized}`;
  return encodeURI(withLeadingSlash);
}

function readStringMetadata(
  metadata: Record<string, unknown>,
  key: string
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

const PDF_COLORS = {
  primary: "#1a1a2e" as const,
  accent: "#3B82F6" as const,
  success: "#22c55e" as const,
  danger: "#ef4444" as const,
  warning: "#f59e0b" as const,
  muted: "#6b7280" as const,
  border: "#e5e7eb" as const,
  surface: "#f9fafb" as const,
  white: "#ffffff" as const,
};

async function renderPdf(markdown: string): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 60, bottom: 60, left: 50, right: 50 },
    bufferPages: true,
  });
  const stream = new PassThrough();
  const chunks: Buffer[] = [];

  stream.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  const completion = new Promise<Buffer>((resolve, reject) => {
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

  doc.pipe(stream);

  const pageWidth = doc.page.width - 100;
  let isFirstH1 = true;

  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();

    // Title (H1)
    if (trimmed.startsWith("# ")) {
      const title = trimmed.slice(2).trim();
      if (isFirstH1) {
        doc.moveDown(1);
        doc.fillColor(PDF_COLORS.primary).fontSize(22).font("Helvetica-Bold").text(title, { align: "left" });
        doc.moveDown(0.3);
        doc.moveTo(50, doc.y).lineTo(50 + pageWidth, doc.y).lineWidth(2).strokeColor(PDF_COLORS.accent).stroke();
        doc.moveDown(0.8);
        isFirstH1 = false;
      } else {
        doc.addPage();
        doc.fillColor(PDF_COLORS.primary).fontSize(22).font("Helvetica-Bold").text(title, { align: "left" });
        doc.moveDown(0.3);
        doc.moveTo(50, doc.y).lineTo(50 + pageWidth, doc.y).lineWidth(2).strokeColor(PDF_COLORS.accent).stroke();
        doc.moveDown(0.8);
      }
      continue;
    }

    // Section header (H2)
    if (trimmed.startsWith("## ")) {
      const sectionTitle = trimmed.slice(3).trim();
      if (doc.y > doc.page.height - 120) {
        doc.addPage();
      }
      doc.moveDown(0.6);
      const sectionY = doc.y;
      doc.rect(50, sectionY, 3, 16).fill(PDF_COLORS.accent);
      doc.fillColor(PDF_COLORS.primary).fontSize(13).font("Helvetica-Bold").text(sectionTitle, 58, sectionY + 1);
      doc.moveDown(0.4);
      doc.moveTo(50, doc.y).lineTo(50 + pageWidth, doc.y).lineWidth(0.5).strokeColor(PDF_COLORS.border).stroke();
      doc.moveDown(0.4);
      continue;
    }

    // Subsection header (H3)
    if (trimmed.startsWith("### ")) {
      doc.moveDown(0.3);
      doc.fillColor(PDF_COLORS.accent).fontSize(11).font("Helvetica-Bold").text(trimmed.slice(4).trim());
      doc.moveDown(0.2);
      continue;
    }

    // Empty line
    if (trimmed === "") {
      doc.moveDown(0.2);
      continue;
    }

    // Status-colored bullet points (with markdown link support)
    if (trimmed.startsWith("- ")) {
      const content = trimmed.slice(2).trim();
      const color = getLineStatusColor(content);

      if (doc.y > doc.page.height - 80) {
        doc.addPage();
      }

      const bulletLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
      if (bulletLinkPattern.test(content)) {
        bulletLinkPattern.lastIndex = 0;
        let bulletLastIndex = 0;
        let bulletMatch: RegExpExecArray | null;
        while ((bulletMatch = bulletLinkPattern.exec(content)) !== null) {
          const before = content.slice(bulletLastIndex, bulletMatch.index);
          if (before) {
            doc.fillColor(color).fontSize(9).font("Helvetica").text(before, bulletLastIndex === 0 ? 58 : undefined, bulletLastIndex === 0 ? doc.y : undefined, { continued: true, width: pageWidth - 8 });
          }
          doc.fillColor(PDF_COLORS.accent).fontSize(9).font("Helvetica").text(bulletMatch[1] ?? "", {
            link: bulletMatch[2],
            underline: true,
            continued: true,
          });
          bulletLastIndex = bulletMatch.index + bulletMatch[0].length;
        }
        const bulletRemaining = content.slice(bulletLastIndex);
        doc.fillColor(color).fontSize(9).font("Helvetica").text(bulletRemaining, { lineGap: 2 });
      } else {
        doc.fillColor(color).fontSize(9).font("Helvetica").text(content, 58, doc.y, {
          width: pageWidth - 8,
          lineGap: 2,
        });
      }
      doc.moveDown(0.1);
      continue;
    }

    // Numbered items
    if (/^\d+\.\s/.test(trimmed)) {
      if (doc.y > doc.page.height - 80) {
        doc.addPage();
      }
      doc.fillColor(PDF_COLORS.primary).fontSize(9).font("Helvetica").text(trimmed, 55, doc.y, {
        width: pageWidth - 5,
        lineGap: 2,
      });
      doc.moveDown(0.1);
      continue;
    }

    // Regular text (with markdown link support)
    if (doc.y > doc.page.height - 80) {
      doc.addPage();
    }
    const mdLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
    if (mdLinkPattern.test(trimmed)) {
      mdLinkPattern.lastIndex = 0;
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = mdLinkPattern.exec(trimmed)) !== null) {
        const before = trimmed.slice(lastIndex, match.index);
        if (before) {
          doc.fillColor(PDF_COLORS.primary).fontSize(9).font("Helvetica").text(before, { continued: true });
        }
        doc.fillColor(PDF_COLORS.accent).fontSize(9).font("Helvetica").text(match[1] ?? "", {
          link: match[2],
          underline: true,
          continued: true,
        });
        lastIndex = match.index + match[0].length;
      }
      const remaining = trimmed.slice(lastIndex);
      doc.fillColor(PDF_COLORS.primary).fontSize(9).font("Helvetica").text(remaining, { lineGap: 2 });
    } else {
      doc.fillColor(PDF_COLORS.primary).fontSize(9).font("Helvetica").text(trimmed, {
        width: pageWidth,
        lineGap: 2,
      });
    }
  }

  // Add page numbers and footer
  const pages = doc.bufferedPageRange();
  const generatedAt = new Date().toISOString().split("T")[0] ?? "";
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    // Header line
    doc.save();
    doc.moveTo(50, 45).lineTo(50 + pageWidth, 45).lineWidth(0.5).strokeColor(PDF_COLORS.border).stroke();
    doc.fillColor(PDF_COLORS.muted).fontSize(7).font("Helvetica")
      .text("COUNTERPARTY VETTING REPORT", 50, 35, { align: "left" })
      .text(`CONFIDENTIAL`, 50, 35, { align: "right", width: pageWidth });
    // Footer
    doc.moveTo(50, doc.page.height - 50).lineTo(50 + pageWidth, doc.page.height - 50).lineWidth(0.5).strokeColor(PDF_COLORS.border).stroke();
    doc.fillColor(PDF_COLORS.muted).fontSize(7).font("Helvetica")
      .text(`Generated ${generatedAt}`, 50, doc.page.height - 45, { align: "left" })
      .text(`Page ${i + 1} of ${pages.count}`, 50, doc.page.height - 45, { align: "right", width: pageWidth });
    doc.restore();
  }

  doc.end();
  return completion;
}

function getLineStatusColor(content: string): string {
  const lower = content.toLowerCase();
  if (lower.includes("passed") || lower.includes("active") || lower.includes("good standing") || lower.includes("clear")) {
    return PDF_COLORS.success;
  }
  if (lower.includes("failed") || lower.includes("terminated") || lower.includes("rejected") || lower.includes("inactive")) {
    return PDF_COLORS.danger;
  }
  if (lower.includes("manual") || lower.includes("review") || lower.includes("pending") || lower.includes("blocked") || lower.includes("warning")) {
    return PDF_COLORS.warning;
  }
  if (lower.startsWith("none")) {
    return PDF_COLORS.muted;
  }
  return PDF_COLORS.primary;
}

function defaultUserAgent(): string {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
}

function isChallengePage(title: string | null, html: string): boolean {
  const haystack = `${title ?? ""}\n${html}`.toLowerCase();
  return (
    haystack.includes("detected unusual traffic") ||
    haystack.includes("our systems have detected unusual traffic") ||
    haystack.includes("automated queries") ||
    haystack.includes("verify you are human") ||
    haystack.includes("access denied") ||
    haystack.includes("attention required") ||
    haystack.includes("complete the captcha") ||
    haystack.includes("please verify you are a human") ||
    (title?.startsWith("https://www.google.com/search?") ?? false)
  );
}

function isFileMissingError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function extractHtmlTitle(html: string): string | null {
  const match = /<title>(.*?)<\/title>/i.exec(html);
  return match?.[1]?.trim() ?? null;
}

function injectBaseUrl(html: string, baseUrl: string): string {
  if (/<base\s/i.test(html)) {
    return html;
  }

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseUrl}">`);
  }

  return `<base href="${baseUrl}">${html}`;
}

function sanitizeHtmlForOfflineRender(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
}

async function safePageTitle(page: { title: () => Promise<string> }): Promise<string | null> {
  try {
    const title = await page.title();
    return title.trim() === "" ? null : title.trim();
  } catch {
    return null;
  }
}
