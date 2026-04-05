export const WORKFLOW_STEP_KEYS = [
  "public_market_shortcut",
  "entity_resolution",
  "good_standing",
  "reputation_search",
  "bbb_review",
  "ofac_precheck",
  "ofac_search",
] as const;

export type WorkflowStepKey = (typeof WORKFLOW_STEP_KEYS)[number];
export type CounterpartyKind = "entity" | "individual";
export type VerificationStatus =
  | "verified"
  | "inferred"
  | "unverified"
  | "conflicted";
export type IssueSeverity = "low" | "medium" | "high" | "critical";
export type IssueStatus = "open" | "resolved";
export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "manual_review_required"
  | "skipped";
export type CaseStatus =
  | "draft"
  | "in_progress"
  | "blocked"
  | "awaiting_review"
  | "completed"
  | "terminated";
export type Recommendation =
  | "pending"
  | "blocked"
  | "approved"
  | "manual_review"
  | "terminate";
export type MessageDirection = "inbound" | "outbound" | "system";
export type ReviewTaskStatus = "open" | "resolved" | "cancelled";
export type ReviewOutcome = "clear" | "concern" | "reject";
export type JobStatus = "pending" | "running" | "completed" | "failed";
export type JobKind = "run_step" | "refresh_report";
export type ReportKind = "working" | "final" | "review_packet" | "traceability";
export type ReportStatus = "draft" | "published";

export interface HealthSnapshot {
  generatedAt: string;
  caseCounts: Record<CaseStatus, number>;
  openIssueCounts: Record<IssueSeverity, number>;
  openReviewTaskCount: number;
  jobCounts: Record<JobStatus, number>;
  latestCaseUpdateAt: string | null;
}

export interface CaseExportResult {
  caseId: string;
  bundleDirectory: string;
  manifestPath: string;
}

export interface RetentionPruneResult {
  retentionDays: number;
  cutoff: string;
  deletedMessages: number;
  deletedAuditEvents: number;
  deletedArtifacts: number;
  deletedReports: number;
  deletedExports: number;
  generatedAt: string;
}

export interface CreateCaseInput {
  displayName: string;
  counterpartyKind: CounterpartyKind;
  legalName: string | null;
  incorporationCountry: string | null;
  incorporationState: string | null;
  website: string | null;
  registrySearchUrl: string | null;
  publicListingUrl: string | null;
  exchangeName: string | null;
  stockSymbol: string | null;
  requestedBy: string | null;
  notes: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
}

export interface UpdateCaseScreeningInput {
  legalName?: string | null;
  incorporationCountry?: string | null;
  incorporationState?: string | null;
  website?: string | null;
  registrySearchUrl?: string | null;
  publicListingUrl?: string | null;
  exchangeName?: string | null;
  stockSymbol?: string | null;
  notes?: string | null;
}

export interface CaseRecord extends CreateCaseInput {
  id: string;
  normalizedName: string;
  profileId: string;
  caseStatus: CaseStatus;
  recommendation: Recommendation;
  decisionSummary: string | null;
  policyVersion: string;
  decisionMatrixVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileRecord {
  id: string;
  counterpartyKind: CounterpartyKind;
  displayName: string;
  normalizedName: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface CaseMessageRecord {
  id: string;
  caseId: string | null;
  direction: MessageDirection;
  transport: string;
  channelId: string | null;
  threadTs: string | null;
  externalMessageId: string | null;
  actorId: string | null;
  actorLabel: string | null;
  body: string;
  createdAt: string;
}

export interface FactRecord {
  id: string;
  caseId: string;
  stepKey: WorkflowStepKey;
  factKey: string;
  summary: string;
  valueJson: string;
  verificationStatus: VerificationStatus;
  sourceId: string | null;
  evidenceIds: string[];
  freshnessExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRecord {
  id: string;
  caseId: string;
  stepKey: WorkflowStepKey;
  severity: IssueSeverity;
  status: IssueStatus;
  title: string;
  detail: string;
  evidenceIds: string[];
  createdAt: string;
  resolvedAt: string | null;
}

export interface WorkflowStepRecord {
  id: string;
  caseId: string;
  stepKey: WorkflowStepKey;
  hardGate: boolean;
  status: WorkflowStepStatus;
  note: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  caseId: string;
  stepKey: WorkflowStepKey | "report";
  title: string;
  sourceId: string | null;
  storageBackend: string;
  relativePath: string;
  contentType: string;
  sourceUrl: string | null;
  metadataJson: string;
  createdAt: string;
}

export interface ReviewTaskRecord {
  id: string;
  caseId: string;
  stepKey: WorkflowStepKey;
  status: ReviewTaskStatus;
  title: string;
  instructions: string;
  resolutionNotes: string | null;
  outcome: ReviewOutcome | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface JobRecord {
  id: string;
  caseId: string | null;
  kind: JobKind;
  status: JobStatus;
  payloadJson: string;
  attempts: number;
  lastError: string | null;
  runAfter: string;
  lockedAt: string | null;
  lockedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportRecord {
  id: string;
  caseId: string;
  kind: ReportKind;
  status: ReportStatus;
  artifactId: string | null;
  summary: string | null;
  versionNumber: number;
  isCurrent: boolean;
  supersededByReportId: string | null;
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEventRecord {
  id: string;
  caseId: string | null;
  eventType: string;
  actorType: string;
  actorId: string | null;
  payloadJson: string;
  createdAt: string;
}

export interface CaseSummary {
  id: string;
  displayName: string;
  counterpartyKind: CounterpartyKind;
  caseStatus: CaseStatus;
  recommendation: Recommendation;
  createdAt: string;
  updatedAt: string;
}

export interface CaseSnapshot {
  caseRecord: CaseRecord;
  profile: ProfileRecord;
  priorCases: CaseSummary[];
  messages: CaseMessageRecord[];
  facts: FactRecord[];
  issues: IssueRecord[];
  steps: WorkflowStepRecord[];
  artifacts: ArtifactRecord[];
  reports: ReportRecord[];
  reviewTasks: ReviewTaskRecord[];
}

export interface PolicyStepConfig {
  key: WorkflowStepKey;
  order: number;
  hardGate: boolean;
  appliesTo: CounterpartyKind[];
  description: string;
  evidenceRequirements: string[];
  manualReviewAllowed: boolean;
}

export interface PolicySourceConfig {
  id: string;
  label: string;
  sourceType: string;
  trustTier: "A" | "B" | "C";
  connector: string;
  urlTemplate: string;
  notes: string;
}

export interface PolicyBundle {
  version: string;
  decisionMatrixVersion: string;
  topExchanges: string[];
  steps: PolicyStepConfig[];
  sources: PolicySourceConfig[];
}

export interface NewFactInput {
  stepKey: WorkflowStepKey;
  factKey: string;
  summary: string;
  value: unknown;
  verificationStatus: VerificationStatus;
  sourceId: string | null;
  evidenceIds: string[];
  freshnessExpiresAt: string | null;
}

export interface NewIssueInput {
  stepKey: WorkflowStepKey;
  severity: IssueSeverity;
  title: string;
  detail: string;
  evidenceIds: string[];
}

export interface NewReviewTaskInput {
  stepKey: WorkflowStepKey;
  title: string;
  instructions: string;
}

export interface StepExecutionResult {
  status: WorkflowStepStatus;
  note: string | null;
  facts: NewFactInput[];
  issues: NewIssueInput[];
  reviewTasks: NewReviewTaskInput[];
}

export interface SaveArtifactInput {
  caseId: string;
  stepKey: WorkflowStepKey | "report";
  title: string;
  sourceId: string | null;
  sourceUrl: string | null;
  fileName: string;
  contentType: string;
  body: Buffer | string;
  category: "evidence" | "report";
  metadata: Record<string, unknown>;
}

export interface CaptureRequest {
  caseId: string;
  stepKey: WorkflowStepKey;
  url: string;
  title: string;
  sourceId: string | null;
}

export interface ReviewResolutionInput {
  taskId: string;
  outcome: ReviewOutcome;
  notes: string;
}
