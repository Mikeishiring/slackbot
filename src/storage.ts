import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import type {
  ArtifactRecord,
  AuditEventRecord,
  CaseMessageRecord,
  CaseRecord,
  CaseSnapshot,
  CaseStatus,
  CaseSummary,
  CreateCaseInput,
  FactRecord,
  HealthSnapshot,
  IssueRecord,
  JobKind,
  JobRecord,
  JobStatus,
  NewFactInput,
  NewIssueInput,
  NewReviewTaskInput,
  ProfileRecord,
  Recommendation,
  ReportKind,
  ReportRecord,
  ReportStatus,
  ReviewOutcome,
  ReviewTaskRecord,
  RetentionPruneResult,
  SaveArtifactInput,
  WorkflowStepKey,
  WorkflowStepRecord,
  WorkflowStepStatus,
  UpdateCaseScreeningInput,
} from "./types.js";
import { generateId, normalizeName, nowIso, parseJson } from "./utils.js";

type SqlRow = Record<string, unknown>;

export class PolicyBotStorage {
  private readonly db: Database.Database;

  public constructor(databasePath: string) {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  public close(): void {
    this.db.close();
  }

  public createCase(
    input: CreateCaseInput,
    policyVersion: string,
    decisionMatrixVersion: string
  ): CaseRecord {
    const normalizedName = normalizeName(input.displayName);
    const now = nowIso();

    const execute = this.db.transaction(() => {
      const profileRow =
        (this.db
          .prepare(
            `
              SELECT *
              FROM profiles
              WHERE normalized_name = ? AND counterparty_kind = ?
            `
          )
          .get(normalizedName, input.counterpartyKind) as SqlRow | undefined) ??
        null;

      let profileId: string;
      if (profileRow) {
        profileId = String(profileRow.id);
        this.db
          .prepare(
            `
              UPDATE profiles
              SET display_name = ?, last_seen_at = ?
              WHERE id = ?
            `
          )
          .run(input.displayName, now, profileId);
      } else {
        profileId = generateId("profile");
        this.db
          .prepare(
            `
              INSERT INTO profiles (
                id,
                counterparty_kind,
                display_name,
                normalized_name,
                first_seen_at,
                last_seen_at
              )
              VALUES (?, ?, ?, ?, ?, ?)
            `
          )
          .run(
            profileId,
            input.counterpartyKind,
            input.displayName,
            normalizedName,
            now,
            now
          );
      }

      const caseId = generateId("case");
      this.db
        .prepare(
          `
            INSERT INTO cases (
              id,
              profile_id,
              display_name,
              normalized_name,
              counterparty_kind,
              legal_name,
              incorporation_country,
              incorporation_state,
              website,
              registry_search_url,
              public_listing_url,
              exchange_name,
              stock_symbol,
              requested_by,
              notes,
              slack_channel_id,
              slack_thread_ts,
              case_status,
              recommendation,
              decision_summary,
              policy_version,
              decision_matrix_version,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          caseId,
          profileId,
          input.displayName,
          normalizedName,
          input.counterpartyKind,
          input.legalName,
          input.incorporationCountry,
          input.incorporationState,
          input.website,
          input.registrySearchUrl,
          input.publicListingUrl,
          input.exchangeName,
          input.stockSymbol,
          input.requestedBy,
          input.notes,
          input.slackChannelId,
          input.slackThreadTs,
          "draft",
          "pending",
          null,
          policyVersion,
          decisionMatrixVersion,
          now,
          now
        );

      this.recordAuditEvent({
        caseId,
        eventType: "case.created",
        actorType: "system",
        actorId: input.requestedBy,
        payload: {
          displayName: input.displayName,
          counterpartyKind: input.counterpartyKind,
        },
      });

      return caseId;
    });

    const caseId = execute();
    return this.getCase(caseId);
  }

  public getCase(caseId: string): CaseRecord {
    const row = this.db
      .prepare(
        `
          SELECT *
          FROM cases
          WHERE id = ?
        `
      )
      .get(caseId) as SqlRow | undefined;

    if (!row) {
      throw new Error(`Case not found: ${caseId}`);
    }

    return mapCase(row);
  }

  public getProfile(profileId: string): ProfileRecord {
    const row = this.db
      .prepare(
        `
          SELECT *
          FROM profiles
          WHERE id = ?
        `
      )
      .get(profileId) as SqlRow | undefined;

    if (!row) {
      throw new Error(`Profile not found: ${profileId}`);
    }

    return mapProfile(row);
  }

  public listCases(limit = 20): CaseSummary[] {
    const rows = this.db
      .prepare(
        `
          SELECT id, display_name, counterparty_kind, case_status, recommendation, created_at, updated_at
          FROM cases
          ORDER BY updated_at DESC
          LIMIT ?
        `
      )
      .all(limit) as SqlRow[];

    return rows.map(mapCaseSummary);
  }

  public searchCasesByName(query: string, limit = 20): CaseSummary[] {
    const normalizedQuery = normalizeName(query);
    if (!normalizedQuery) {
      return [];
    }

    const normalized = `%${normalizedQuery}%`;
    const rows = this.db
      .prepare(
        `
          SELECT id, display_name, counterparty_kind, case_status, recommendation, created_at, updated_at
          FROM cases
          WHERE normalized_name LIKE ?
          ORDER BY updated_at DESC
          LIMIT ?
        `
      )
      .all(normalized, limit) as SqlRow[];

    return rows.map(mapCaseSummary);
  }

  public listPriorCases(profileId: string, excludeCaseId: string): CaseSummary[] {
    const rows = this.db
      .prepare(
        `
          SELECT id, display_name, counterparty_kind, case_status, recommendation, created_at, updated_at
          FROM cases
          WHERE profile_id = ? AND id <> ?
          ORDER BY updated_at DESC
        `
      )
      .all(profileId, excludeCaseId) as SqlRow[];

    return rows.map(mapCaseSummary);
  }

  public findLatestProfileCaseWithRegistryUrl(
    profileId: string,
    excludeCaseId: string
  ): CaseRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT *
          FROM cases
          WHERE profile_id = ? AND id <> ? AND registry_search_url IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 1
        `
      )
      .get(profileId, excludeCaseId) as SqlRow | undefined;

    return row ? mapCase(row) : null;
  }

  public findLatestProfileCaseWithResolvedEntity(
    profileId: string,
    excludeCaseId: string
  ): CaseRecord | null {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM cases
          WHERE profile_id = ?
            AND id <> ?
            AND legal_name IS NOT NULL
            AND incorporation_country IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 10
        `
      )
      .all(profileId, excludeCaseId) as SqlRow[];

    for (const row of rows) {
      const caseRecord = mapCase(row);
      if (
        normalizeName(caseRecord.incorporationCountry ?? "") === "us" &&
        !caseRecord.incorporationState
      ) {
        continue;
      }

      return caseRecord;
    }

    return null;
  }

  public findCaseByThread(
    channelId: string,
    threadTs: string
  ): CaseRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT *
          FROM cases
          WHERE slack_channel_id = ? AND slack_thread_ts = ?
          ORDER BY created_at DESC
          LIMIT 1
        `
      )
      .get(channelId, threadTs) as SqlRow | undefined;

    return row ? mapCase(row) : null;
  }

  public bindCaseToThread(
    caseId: string,
    channelId: string,
    threadTs: string
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `
          UPDATE cases
          SET slack_channel_id = ?, slack_thread_ts = ?, updated_at = ?
          WHERE id = ?
        `
      )
      .run(channelId, threadTs, now, caseId);
  }

  public appendMessage(input: {
    caseId: string | null;
    direction: CaseMessageRecord["direction"];
    transport: string;
    channelId: string | null;
    threadTs: string | null;
    externalMessageId: string | null;
    actorId: string | null;
    actorLabel: string | null;
    body: string;
  }): CaseMessageRecord {
    const messageId = generateId("msg");
    const now = nowIso();

    this.db
      .prepare(
        `
          INSERT INTO case_messages (
            id,
            case_id,
            direction,
            transport,
            channel_id,
            thread_ts,
            external_message_id,
            actor_id,
            actor_label,
            body,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        messageId,
        input.caseId,
        input.direction,
        input.transport,
        input.channelId,
        input.threadTs,
        input.externalMessageId,
        input.actorId,
        input.actorLabel,
        input.body,
        now
      );

    const row = this.db
      .prepare(
        `
          SELECT *
          FROM case_messages
          WHERE id = ?
        `
      )
      .get(messageId) as SqlRow | undefined;

    if (!row) {
      throw new Error(`Message write failed: ${messageId}`);
    }

    return mapMessage(row);
  }

  public listMessages(caseId: string): CaseMessageRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM case_messages
          WHERE case_id = ?
          ORDER BY created_at ASC
        `
      )
      .all(caseId) as SqlRow[];

    return rows.map(mapMessage);
  }

  public ensureWorkflowStep(
    caseId: string,
    stepKey: WorkflowStepKey,
    hardGate: boolean
  ): WorkflowStepRecord {
    const now = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO workflow_steps (
            id,
            case_id,
            step_key,
            hard_gate,
            status,
            note,
            started_at,
            completed_at,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(case_id, step_key) DO NOTHING
        `
      )
      .run(
        generateId("step"),
        caseId,
        stepKey,
        hardGate ? 1 : 0,
        "pending",
        null,
        null,
        null,
        now,
        now
      );

    return this.getStep(caseId, stepKey);
  }

  public getStep(caseId: string, stepKey: WorkflowStepKey): WorkflowStepRecord {
    const row = this.db
      .prepare(
        `
          SELECT *
          FROM workflow_steps
          WHERE case_id = ? AND step_key = ?
        `
      )
      .get(caseId, stepKey) as SqlRow | undefined;

    if (!row) {
      throw new Error(`Workflow step not found: ${caseId}/${stepKey}`);
    }

    return mapStep(row);
  }

  public listSteps(caseId: string): WorkflowStepRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM workflow_steps
          WHERE case_id = ?
          ORDER BY created_at ASC
        `
      )
      .all(caseId) as SqlRow[];

    return rows.map(mapStep);
  }

  public updateStepStatus(input: {
    caseId: string;
    stepKey: WorkflowStepKey;
    status: WorkflowStepStatus;
    note: string | null;
  }): WorkflowStepRecord {
    const current = this.getStep(input.caseId, input.stepKey);
    const now = nowIso();
    const startedAt =
      current.startedAt ?? (input.status === "running" ? now : null);
    const completedAt =
      input.status === "passed" ||
      input.status === "failed" ||
      input.status === "blocked" ||
      input.status === "manual_review_required" ||
      input.status === "skipped"
        ? now
        : null;

    this.db
      .prepare(
        `
          UPDATE workflow_steps
          SET status = ?, note = ?, started_at = ?, completed_at = ?, updated_at = ?
          WHERE case_id = ? AND step_key = ?
        `
      )
      .run(
        input.status,
        input.note,
        startedAt,
        completedAt,
        now,
        input.caseId,
        input.stepKey
      );

    return this.getStep(input.caseId, input.stepKey);
  }

  public resetStepOutputs(caseId: string, stepKey: WorkflowStepKey): void {
    const now = nowIso();
    this.db
      .prepare(
        `
          DELETE FROM facts
          WHERE case_id = ? AND step_key = ?
        `
      )
      .run(caseId, stepKey);

    this.db
      .prepare(
        `
          UPDATE issues
          SET status = 'resolved', resolved_at = ?
          WHERE case_id = ? AND step_key = ? AND status = 'open'
        `
      )
      .run(now, caseId, stepKey);

    this.db
      .prepare(
        `
          UPDATE review_tasks
          SET status = 'cancelled', resolved_at = ?, resolution_notes = COALESCE(resolution_notes, 'Superseded by rerun')
          WHERE case_id = ? AND step_key = ? AND status = 'open'
        `
      )
      .run(now, caseId, stepKey);
  }

  public upsertFact(caseId: string, input: NewFactInput): FactRecord {
    const factId = generateId("fact");
    const now = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO facts (
            id,
            case_id,
            step_key,
            fact_key,
            summary,
            value_json,
            verification_status,
            source_id,
            evidence_ids_json,
            freshness_expires_at,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(case_id, step_key, fact_key) DO UPDATE SET
            summary = excluded.summary,
            value_json = excluded.value_json,
            verification_status = excluded.verification_status,
            source_id = excluded.source_id,
            evidence_ids_json = excluded.evidence_ids_json,
            freshness_expires_at = excluded.freshness_expires_at,
            updated_at = excluded.updated_at
        `
      )
      .run(
        factId,
        caseId,
        input.stepKey,
        input.factKey,
        input.summary,
        JSON.stringify(input.value),
        input.verificationStatus,
        input.sourceId,
        JSON.stringify(input.evidenceIds),
        input.freshnessExpiresAt,
        now,
        now
      );

    const row = this.db
      .prepare(
        `
          SELECT *
          FROM facts
          WHERE case_id = ? AND step_key = ? AND fact_key = ?
        `
      )
      .get(caseId, input.stepKey, input.factKey) as SqlRow | undefined;

    if (!row) {
      throw new Error(`Fact write failed for ${caseId}/${input.factKey}`);
    }

    return mapFact(row);
  }

  public listFacts(caseId: string): FactRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM facts
          WHERE case_id = ?
          ORDER BY created_at ASC
        `
      )
      .all(caseId) as SqlRow[];

    return rows.map(mapFact);
  }

  public createIssue(caseId: string, input: NewIssueInput): IssueRecord {
    const issueId = generateId("issue");
    const now = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO issues (
            id,
            case_id,
            step_key,
            severity,
            status,
            title,
            detail,
            evidence_ids_json,
            created_at,
            resolved_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        issueId,
        caseId,
        input.stepKey,
        input.severity,
        "open",
        input.title,
        input.detail,
        JSON.stringify(input.evidenceIds),
        now,
        null
      );

    const row = this.db
      .prepare(
        `
          SELECT *
          FROM issues
          WHERE id = ?
        `
      )
      .get(issueId) as SqlRow | undefined;

    if (!row) {
      throw new Error(`Issue write failed: ${issueId}`);
    }

    return mapIssue(row);
  }

  public listIssues(caseId: string): IssueRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM issues
          WHERE case_id = ?
          ORDER BY created_at ASC
        `
      )
      .all(caseId) as SqlRow[];

    return rows.map(mapIssue);
  }

  public resolveIssuesForStep(caseId: string, stepKey: WorkflowStepKey): void {
    const now = nowIso();
    this.db
      .prepare(
        `
          UPDATE issues
          SET status = 'resolved', resolved_at = ?
          WHERE case_id = ? AND step_key = ? AND status = 'open'
        `
      )
      .run(now, caseId, stepKey);
  }

  public resolveAllOpenIssues(caseId: string): void {
    const now = nowIso();
    this.db
      .prepare(
        `
          UPDATE issues
          SET status = 'resolved', resolved_at = ?
          WHERE case_id = ? AND status = 'open'
        `
      )
      .run(now, caseId);
  }

  public cancelOpenReviewTasks(caseId: string, notes: string): void {
    const now = nowIso();
    this.db
      .prepare(
        `
          UPDATE review_tasks
          SET status = 'cancelled',
              resolved_at = ?,
              resolution_notes = COALESCE(resolution_notes, ?)
          WHERE case_id = ? AND status = 'open'
        `
      )
      .run(now, notes, caseId);
  }

  public createArtifact(input: {
    caseId: string;
    stepKey: SaveArtifactInput["stepKey"];
    title: string;
    sourceId: string | null;
    storageBackend: string;
    relativePath: string;
    contentType: string;
    sourceUrl: string | null;
    metadata: Record<string, unknown>;
  }): ArtifactRecord {
    const artifactId = generateId("artifact");
    const now = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO artifacts (
            id,
            case_id,
            step_key,
            title,
            source_id,
            storage_backend,
            relative_path,
            content_type,
            source_url,
            metadata_json,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        artifactId,
        input.caseId,
        input.stepKey,
        input.title,
        input.sourceId,
        input.storageBackend,
        input.relativePath,
        input.contentType,
        input.sourceUrl,
        JSON.stringify(input.metadata),
        now
      );

    const row = this.db
      .prepare(
        `
          SELECT *
          FROM artifacts
          WHERE id = ?
        `
      )
      .get(artifactId) as SqlRow | undefined;

    if (!row) {
      throw new Error(`Artifact write failed: ${artifactId}`);
    }

    return mapArtifact(row);
  }

  public listArtifacts(caseId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM artifacts
          WHERE case_id = ?
          ORDER BY created_at ASC
        `
      )
      .all(caseId) as SqlRow[];

    return rows.map(mapArtifact);
  }

  public listArtifactsForStep(
    caseId: string,
    stepKey: ArtifactRecord["stepKey"]
  ): ArtifactRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM artifacts
          WHERE case_id = ? AND step_key = ?
          ORDER BY created_at ASC
        `
      )
      .all(caseId, stepKey) as SqlRow[];

    return rows.map(mapArtifact);
  }

  public listArtifactsBefore(cutoff: string): ArtifactRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM artifacts
          WHERE created_at < ?
          ORDER BY created_at ASC
        `
      )
      .all(cutoff) as SqlRow[];

    return rows.map(mapArtifact);
  }

  public deleteArtifacts(artifactIds: string[]): void {
    if (artifactIds.length === 0) {
      return;
    }

    const statement = this.db.prepare(
      `
        DELETE FROM artifacts
        WHERE id = ?
      `
    );
    const clearReports = this.db.prepare(
      `
        UPDATE reports
        SET artifact_id = NULL, updated_at = ?
        WHERE artifact_id = ?
      `
    );
    const execute = this.db.transaction((ids: string[]) => {
      const now = nowIso();
      for (const artifactId of ids) {
        clearReports.run(now, artifactId);
        statement.run(artifactId);
      }
    });

    execute(artifactIds);
  }

  public upsertReport(input: {
    caseId: string;
    kind: ReportKind;
    status: ReportStatus;
    artifactId: string | null;
    summary: string | null;
  }): ReportRecord {
    const now = nowIso();
    const writeReport = this.db.transaction(() => {
      const currentRow = this.db
        .prepare(
          `
            SELECT *
            FROM reports
            WHERE case_id = ? AND kind = ? AND is_current = 1
          `
        )
        .get(input.caseId, input.kind) as SqlRow | undefined;
      const maxVersionRow = this.db
        .prepare(
          `
            SELECT COALESCE(MAX(version_number), 0) AS max_version
            FROM reports
            WHERE case_id = ? AND kind = ?
          `
        )
        .get(input.caseId, input.kind) as SqlRow | undefined;
      const reportId = generateId("report");
      const versionNumber =
        Number(maxVersionRow?.max_version ?? 0) + 1;

      if (currentRow) {
        this.db
          .prepare(
            `
              UPDATE reports
              SET is_current = 0,
                  updated_at = ?
              WHERE id = ?
            `
          )
          .run(now, String(currentRow.id));
      }

      this.db
        .prepare(
          `
            INSERT INTO reports (
              id,
              case_id,
              kind,
              status,
              artifact_id,
              summary,
              version_number,
              is_current,
              superseded_by_report_id,
              published_at,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)
          `
        )
        .run(
          reportId,
          input.caseId,
          input.kind,
          input.status,
          input.artifactId,
          input.summary,
          versionNumber,
          now,
          now,
          now
        );

      if (currentRow) {
        this.db
          .prepare(
            `
              UPDATE reports
              SET superseded_by_report_id = ?,
                  updated_at = ?
              WHERE id = ?
            `
          )
          .run(reportId, now, String(currentRow.id));
      }

      const row = this.db
        .prepare(
          `
            SELECT *
            FROM reports
            WHERE id = ?
          `
        )
        .get(reportId) as SqlRow | undefined;

      if (!row) {
        throw new Error(`Report write failed: ${input.caseId}/${input.kind}`);
      }

      return mapReport(row);
    });

    return writeReport();
  }

  public listReports(caseId: string): ReportRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM reports
          WHERE case_id = ? AND is_current = 1
          ORDER BY kind ASC, published_at DESC, created_at DESC
        `
      )
      .all(caseId) as SqlRow[];

    return rows.map(mapReport);
  }

  public listReportHistory(caseId: string): ReportRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM reports
          WHERE case_id = ?
          ORDER BY kind ASC, version_number DESC, published_at DESC, created_at DESC
        `
      )
      .all(caseId) as SqlRow[];

    return rows.map(mapReport);
  }

  public deleteReportsBefore(cutoff: string): number {
    return Number(
      this.db
        .prepare(
          `
            DELETE FROM reports
            WHERE created_at < ?
          `
        )
        .run(cutoff).changes
    );
  }

  public createReviewTask(
    caseId: string,
    input: NewReviewTaskInput
  ): ReviewTaskRecord {
    const taskId = generateId("review");
    const now = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO review_tasks (
            id,
            case_id,
            step_key,
            status,
            title,
            instructions,
            resolution_notes,
            outcome,
            created_at,
            resolved_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        taskId,
        caseId,
        input.stepKey,
        "open",
        input.title,
        input.instructions,
        null,
        null,
        now,
        null
      );

    const row = this.db
      .prepare(
        `
          SELECT *
          FROM review_tasks
          WHERE id = ?
        `
      )
      .get(taskId) as SqlRow | undefined;

    if (!row) {
      throw new Error(`Review task write failed: ${taskId}`);
    }

    return mapReviewTask(row);
  }

  public getReviewTask(taskId: string): ReviewTaskRecord {
    const row = this.db
      .prepare(
        `
          SELECT *
          FROM review_tasks
          WHERE id = ?
        `
      )
      .get(taskId) as SqlRow | undefined;

    if (!row) {
      throw new Error(`Review task not found: ${taskId}`);
    }

    return mapReviewTask(row);
  }

  public resolveReviewTask(
    taskId: string,
    outcome: ReviewOutcome,
    notes: string
  ): ReviewTaskRecord {
    const now = nowIso();
    this.db
      .prepare(
        `
          UPDATE review_tasks
          SET status = 'resolved', outcome = ?, resolution_notes = ?, resolved_at = ?
          WHERE id = ?
        `
      )
      .run(outcome, notes, now, taskId);

    return this.getReviewTask(taskId);
  }

  public listReviewTasks(caseId?: string): ReviewTaskRecord[] {
    const rows = caseId
      ? (this.db
          .prepare(
            `
              SELECT *
              FROM review_tasks
              WHERE case_id = ?
              ORDER BY created_at ASC
            `
          )
          .all(caseId) as SqlRow[])
      : (this.db
          .prepare(
            `
              SELECT *
              FROM review_tasks
              ORDER BY created_at ASC
            `
          )
          .all() as SqlRow[]);

    return rows.map(mapReviewTask);
  }

  public enqueueJob(input: {
    caseId: string | null;
    kind: JobKind;
    payload: Record<string, unknown>;
    runAfter?: string;
  }): JobRecord {
    const now = nowIso();
    const payloadJson = JSON.stringify(input.payload);
    const existingRow = input.caseId
      ? ((this.db
          .prepare(
            `
              SELECT *
              FROM jobs
              WHERE case_id = ?
                AND kind = ?
                AND payload_json = ?
                AND status IN ('pending', 'running')
              ORDER BY created_at ASC
              LIMIT 1
            `
          )
          .get(input.caseId, input.kind, payloadJson) as SqlRow | undefined) ??
        null)
      : ((this.db
          .prepare(
            `
              SELECT *
              FROM jobs
              WHERE case_id IS NULL
                AND kind = ?
                AND payload_json = ?
                AND status IN ('pending', 'running')
              ORDER BY created_at ASC
              LIMIT 1
            `
          )
          .get(input.kind, payloadJson) as SqlRow | undefined) ?? null);
    if (existingRow) {
      return mapJob(existingRow);
    }

    const jobId = generateId("job");
    this.db
      .prepare(
        `
          INSERT INTO jobs (
            id,
            case_id,
            kind,
            status,
            payload_json,
            attempts,
            last_error,
            run_after,
            locked_at,
            locked_by,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        jobId,
        input.caseId,
        input.kind,
        "pending",
        payloadJson,
        0,
        null,
        input.runAfter ?? now,
        null,
        null,
        now,
        now
      );

    return this.getJob(jobId);
  }

  public recoverStaleRunningJobs(cutoffIso: string): number {
    const now = nowIso();
    return Number(
      this.db
        .prepare(
          `
            UPDATE jobs
            SET status = 'pending',
                last_error = COALESCE(last_error, 'Job lock expired and was requeued.'),
                locked_at = NULL,
                locked_by = NULL,
                run_after = ?,
                updated_at = ?
            WHERE status = 'running'
              AND locked_at IS NOT NULL
              AND locked_at <= ?
          `
        )
        .run(now, now, cutoffIso).changes
    );
  }

  public getJob(jobId: string): JobRecord {
    const row = this.db
      .prepare(
        `
          SELECT *
          FROM jobs
          WHERE id = ?
        `
      )
      .get(jobId) as SqlRow | undefined;

    if (!row) {
      throw new Error(`Job not found: ${jobId}`);
    }

    return mapJob(row);
  }

  public claimNextJob(workerId: string): JobRecord | null {
    const transaction = this.db.transaction(() => {
      const now = nowIso();
      const candidate = this.db
        .prepare(
          `
            SELECT id
            FROM jobs
            WHERE status = 'pending' AND run_after <= ?
            ORDER BY run_after ASC, created_at ASC
            LIMIT 1
          `
        )
        .get(now) as SqlRow | undefined;

      if (!candidate) {
        return null;
      }

      this.db
        .prepare(
          `
            UPDATE jobs
            SET status = 'running',
                attempts = attempts + 1,
                locked_at = ?,
                locked_by = ?,
                updated_at = ?
            WHERE id = ?
          `
        )
        .run(now, workerId, now, String(candidate.id));

      return this.getJob(String(candidate.id));
    });

    return transaction();
  }

  /** Recover stale jobs and claim the next pending job in a single transaction. */
  public recoverAndClaimNextJob(workerId: string, staleCutoffIso: string): JobRecord | null {
    const transaction = this.db.transaction(() => {
      const now = nowIso();
      this.db
        .prepare(
          `
            UPDATE jobs
            SET status = 'pending',
                last_error = COALESCE(last_error, 'Job lock expired and was requeued.'),
                locked_at = NULL,
                locked_by = NULL,
                run_after = ?,
                updated_at = ?
            WHERE status = 'running'
              AND locked_at IS NOT NULL
              AND locked_at <= ?
          `
        )
        .run(now, now, staleCutoffIso);

      const candidate = this.db
        .prepare(
          `
            SELECT id
            FROM jobs
            WHERE status = 'pending' AND run_after <= ?
            ORDER BY run_after ASC, created_at ASC
            LIMIT 1
          `
        )
        .get(now) as SqlRow | undefined;

      if (!candidate) {
        return null;
      }

      this.db
        .prepare(
          `
            UPDATE jobs
            SET status = 'running',
                attempts = attempts + 1,
                locked_at = ?,
                locked_by = ?,
                updated_at = ?
            WHERE id = ?
          `
        )
        .run(now, workerId, now, String(candidate.id));

      return this.getJob(String(candidate.id));
    });

    return transaction();
  }

  public completeJob(jobId: string): JobRecord {
    const now = nowIso();
    this.db
      .prepare(
        `
          UPDATE jobs
          SET status = 'completed',
              locked_at = NULL,
              locked_by = NULL,
              updated_at = ?
          WHERE id = ?
        `
      )
      .run(now, jobId);

    return this.getJob(jobId);
  }

  public failJob(jobId: string, error: string): JobRecord {
    const now = nowIso();
    this.db
      .prepare(
        `
          UPDATE jobs
          SET status = 'failed',
              last_error = ?,
              locked_at = NULL,
              locked_by = NULL,
              updated_at = ?
          WHERE id = ?
        `
      )
      .run(error, now, jobId);

    return this.getJob(jobId);
  }

  public requeueJob(jobId: string, error: string, runAfter: string): JobRecord {
    const now = nowIso();
    this.db
      .prepare(
        `
          UPDATE jobs
          SET status = 'pending',
              last_error = ?,
              run_after = ?,
              locked_at = NULL,
              locked_by = NULL,
              updated_at = ?
          WHERE id = ?
        `
      )
      .run(error, runAfter, now, jobId);

    return this.getJob(jobId);
  }

  public listJobs(caseId?: string): JobRecord[] {
    const rows = caseId
      ? (this.db
          .prepare(
            `
              SELECT *
              FROM jobs
              WHERE case_id = ?
              ORDER BY created_at ASC
            `
          )
          .all(caseId) as SqlRow[])
      : (this.db
          .prepare(
            `
              SELECT *
              FROM jobs
              ORDER BY created_at ASC
            `
          )
          .all() as SqlRow[]);

    return rows.map(mapJob);
  }

  public cancelPendingJobsForCase(caseId: string): number {
    return Number(
      this.db
        .prepare(
          `
            DELETE FROM jobs
            WHERE case_id = ? AND status = 'pending'
          `
        )
        .run(caseId).changes
    );
  }

  public cancelPendingJobsForStep(caseId: string, stepKey: WorkflowStepKey): number {
    return Number(
      this.db
        .prepare(
          `
            DELETE FROM jobs
            WHERE case_id = ? AND status = 'pending' AND kind = 'run_step' AND payload_json = ?
          `
        )
        .run(caseId, JSON.stringify({ stepKey })).changes
    );
  }

  public updateCaseDecision(input: {
    caseId: string;
    caseStatus: CaseStatus;
    recommendation: Recommendation;
    decisionSummary: string | null;
  }): CaseRecord {
    const now = nowIso();
    this.db
      .prepare(
        `
          UPDATE cases
          SET case_status = ?, recommendation = ?, decision_summary = ?, updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        input.caseStatus,
        input.recommendation,
        input.decisionSummary,
        now,
        input.caseId
      );

    return this.getCase(input.caseId);
  }

  public updateCaseScreeningFields(
    caseId: string,
    input: UpdateCaseScreeningInput
  ): CaseRecord {
    const assignments: string[] = [];
    const values: Array<string | null> = [];

    const pushAssignment = (column: string, value: string | null | undefined) => {
      if (value === undefined) {
        return;
      }

      assignments.push(`${column} = ?`);
      values.push(value);
    };

    pushAssignment("legal_name", input.legalName);
    pushAssignment("incorporation_country", input.incorporationCountry);
    pushAssignment("incorporation_state", input.incorporationState);
    pushAssignment("website", input.website);
    pushAssignment("registry_search_url", input.registrySearchUrl);
    pushAssignment("public_listing_url", input.publicListingUrl);
    pushAssignment("exchange_name", input.exchangeName);
    pushAssignment("stock_symbol", input.stockSymbol);
    pushAssignment("notes", input.notes);

    if (assignments.length === 0) {
      return this.getCase(caseId);
    }

    assignments.push("updated_at = ?");
    values.push(nowIso());
    values.push(caseId);

    this.db
      .prepare(
        `
          UPDATE cases
          SET ${assignments.join(", ")}
          WHERE id = ?
        `
      )
      .run(...values);

    return this.getCase(caseId);
  }

  public recordAuditEvent(input: {
    caseId: string | null;
    eventType: string;
    actorType: string;
    actorId: string | null;
    payload: Record<string, unknown>;
  }): AuditEventRecord {
    const eventId = generateId("audit");
    const now = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO audit_events (
            id,
            case_id,
            event_type,
            actor_type,
            actor_id,
            payload_json,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        eventId,
        input.caseId,
        input.eventType,
        input.actorType,
        input.actorId,
        JSON.stringify(input.payload),
        now
      );

    const row = this.db
      .prepare(
        `
          SELECT *
          FROM audit_events
          WHERE id = ?
        `
      )
      .get(eventId) as SqlRow | undefined;

    if (!row) {
      throw new Error(`Audit event write failed: ${eventId}`);
    }

    return mapAuditEvent(row);
  }

  public listAuditEvents(caseId?: string): AuditEventRecord[] {
    const rows = caseId
      ? (this.db
          .prepare(
            `
              SELECT *
              FROM audit_events
              WHERE case_id = ?
              ORDER BY created_at ASC
            `
          )
          .all(caseId) as SqlRow[])
      : (this.db
          .prepare(
            `
              SELECT *
              FROM audit_events
              ORDER BY created_at ASC
            `
          )
          .all() as SqlRow[]);

    return rows.map(mapAuditEvent);
  }

  public buildHealthSnapshot(): HealthSnapshot {
    const caseCounts = createStatusCountMap<CaseStatus>([
      "draft",
      "in_progress",
      "blocked",
      "awaiting_review",
      "completed",
      "terminated",
    ]);
    const openIssueCounts = createStatusCountMap<IssueRecord["severity"]>([
      "low",
      "medium",
      "high",
      "critical",
    ]);
    const jobCounts = createStatusCountMap<JobStatus>([
      "pending",
      "running",
      "completed",
      "failed",
    ]);

    const caseRows = this.db
      .prepare(
        `
          SELECT case_status, COUNT(*) AS count
          FROM cases
          GROUP BY case_status
        `
      )
      .all() as SqlRow[];
    for (const row of caseRows) {
      caseCounts[row.case_status as CaseStatus] = Number(row.count);
    }

    const issueRows = this.db
      .prepare(
        `
          SELECT severity, COUNT(*) AS count
          FROM issues
          WHERE status = 'open'
          GROUP BY severity
        `
      )
      .all() as SqlRow[];
    for (const row of issueRows) {
      openIssueCounts[row.severity as IssueRecord["severity"]] = Number(row.count);
    }

    const jobRows = this.db
      .prepare(
        `
          SELECT status, COUNT(*) AS count
          FROM jobs
          GROUP BY status
        `
      )
      .all() as SqlRow[];
    for (const row of jobRows) {
      jobCounts[row.status as JobStatus] = Number(row.count);
    }

    const reviewRow = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM review_tasks
          WHERE status = 'open'
        `
      )
      .get() as SqlRow | undefined;
    const latestCaseRow = this.db
      .prepare(
        `
          SELECT MAX(updated_at) AS updated_at
          FROM cases
        `
      )
      .get() as SqlRow | undefined;

    return {
      generatedAt: nowIso(),
      caseCounts,
      openIssueCounts,
      openReviewTaskCount: Number(reviewRow?.count ?? 0),
      jobCounts,
      latestCaseUpdateAt: nullableString(latestCaseRow?.updated_at),
    };
  }

  public pruneRetention(retentionDays: number): RetentionPruneResult {
    const generatedAt = nowIso();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const deletedMessages = Number(
      this.db
        .prepare(
          `
            DELETE FROM case_messages
            WHERE created_at < ?
          `
        )
        .run(cutoff).changes
    );
    const deletedAuditEvents = Number(
      this.db
        .prepare(
          `
            DELETE FROM audit_events
            WHERE created_at < ?
          `
        )
        .run(cutoff).changes
    );

    this.recordAuditEvent({
      caseId: null,
      eventType: "retention.pruned",
      actorType: "system",
      actorId: null,
      payload: {
        retentionDays,
        cutoff,
        deletedMessages,
        deletedAuditEvents,
      },
    });

    return {
      retentionDays,
      cutoff,
      deletedMessages,
      deletedAuditEvents,
      deletedArtifacts: 0,
      deletedReports: 0,
      deletedExports: 0,
      generatedAt,
    };
  }

  public buildCaseSnapshot(caseId: string): CaseSnapshot {
    const caseRecord = this.getCase(caseId);
    return {
      caseRecord,
      profile: this.getProfile(caseRecord.profileId),
      priorCases: this.listPriorCases(caseRecord.profileId, caseId),
      messages: this.listMessages(caseId),
      facts: this.listFacts(caseId),
      issues: this.listIssues(caseId),
      steps: this.listSteps(caseId),
      artifacts: this.listArtifacts(caseId),
      reports: this.listReports(caseId),
      reviewTasks: this.listReviewTasks(caseId),
    };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        counterparty_kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(normalized_name, counterparty_kind)
      );

      CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id),
        display_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        counterparty_kind TEXT NOT NULL,
        legal_name TEXT,
        incorporation_country TEXT,
        incorporation_state TEXT,
        website TEXT,
        registry_search_url TEXT,
        public_listing_url TEXT,
        exchange_name TEXT,
        stock_symbol TEXT,
        requested_by TEXT,
        notes TEXT,
        slack_channel_id TEXT,
        slack_thread_ts TEXT,
        case_status TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        decision_summary TEXT,
        policy_version TEXT NOT NULL,
        decision_matrix_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS case_messages (
        id TEXT PRIMARY KEY,
        case_id TEXT REFERENCES cases(id),
        direction TEXT NOT NULL,
        transport TEXT NOT NULL,
        channel_id TEXT,
        thread_ts TEXT,
        external_message_id TEXT,
        actor_id TEXT,
        actor_label TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_steps (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(id),
        step_key TEXT NOT NULL,
        hard_gate INTEGER NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(case_id, step_key)
      );

      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(id),
        step_key TEXT NOT NULL,
        fact_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        value_json TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        source_id TEXT,
        evidence_ids_json TEXT NOT NULL,
        freshness_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(case_id, step_key, fact_key)
      );

      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(id),
        step_key TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(id),
        step_key TEXT NOT NULL,
        title TEXT NOT NULL,
        source_id TEXT,
        storage_backend TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_type TEXT NOT NULL,
        source_url TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        artifact_id TEXT REFERENCES artifacts(id),
        summary TEXT,
        version_number INTEGER NOT NULL DEFAULT 1,
        is_current INTEGER NOT NULL DEFAULT 1,
        superseded_by_report_id TEXT REFERENCES reports(id),
        published_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS review_tasks (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(id),
        step_key TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        resolution_notes TEXT,
        outcome TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        case_id TEXT REFERENCES cases(id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        last_error TEXT,
        run_after TEXT NOT NULL,
        locked_at TEXT,
        locked_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        case_id TEXT REFERENCES cases(id),
        event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cases_profile_id ON cases(profile_id);
      CREATE INDEX IF NOT EXISTS idx_cases_thread ON cases(slack_channel_id, slack_thread_ts);
      CREATE INDEX IF NOT EXISTS idx_messages_case_id ON case_messages(case_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_steps_case_id ON workflow_steps(case_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_status_run_after ON jobs(status, run_after, created_at);
      CREATE INDEX IF NOT EXISTS idx_review_tasks_case_id ON review_tasks(case_id, status, created_at);
    `);
    this.ensureReportSchema();
  }

  private ensureReportSchema(): void {
    const columnRows = this.db
      .prepare(`PRAGMA table_info(reports)`)
      .all() as SqlRow[];
    if (columnRows.length === 0) {
      this.createReportIndexes();
      return;
    }

    const columns = new Set(columnRows.map((row) => String(row.name)));
    const requiredColumns = [
      "version_number",
      "is_current",
      "superseded_by_report_id",
      "published_at",
    ];

    if (requiredColumns.every((column) => columns.has(column))) {
      this.createReportIndexes();
      return;
    }

    const legacyRows = this.db
      .prepare(
        `
          SELECT *
          FROM reports
          ORDER BY case_id ASC, kind ASC, created_at ASC, updated_at ASC, id ASC
        `
      )
      .all() as SqlRow[];

    this.db.exec(`
      DROP INDEX IF EXISTS idx_reports_case_kind_current;
      DROP INDEX IF EXISTS idx_reports_case_kind_version;
      ALTER TABLE reports RENAME TO reports_legacy;
    `);
    this.createReportsTable();

    const insertReport = this.db.prepare(
      `
        INSERT INTO reports (
          id,
          case_id,
          kind,
          status,
          artifact_id,
          summary,
          version_number,
          is_current,
          superseded_by_report_id,
          published_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );
    const updateSuperseded = this.db.prepare(
      `
        UPDATE reports
        SET superseded_by_report_id = ?
        WHERE id = ?
      `
    );
    const migrateLegacyReports = this.db.transaction(() => {
      const previousByStream = new Map<string, string>();
      const versionByStream = new Map<string, number>();

      for (const row of legacyRows) {
        const caseId = String(row.case_id);
        const kind = String(row.kind);
        const streamKey = `${caseId}:${kind}`;
        const versionNumber = (versionByStream.get(streamKey) ?? 0) + 1;
        versionByStream.set(streamKey, versionNumber);

        const reportId = String(row.id);
        insertReport.run(
          reportId,
          caseId,
          kind,
          String(row.status),
          nullableString(row.artifact_id),
          nullableString(row.summary),
          versionNumber,
          1,
          null,
          nullableString(row.published_at) ?? String(row.created_at),
          String(row.created_at),
          String(row.updated_at)
        );

        const previousId = previousByStream.get(streamKey);
        if (previousId) {
          this.db
            .prepare(
              `
                UPDATE reports
                SET is_current = 0
                WHERE id = ?
              `
            )
            .run(previousId);
          updateSuperseded.run(reportId, previousId);
        }

        previousByStream.set(streamKey, reportId);
      }
    });

    migrateLegacyReports();
    this.db.exec(`DROP TABLE reports_legacy;`);
    this.createReportIndexes();
  }

  private createReportsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        artifact_id TEXT REFERENCES artifacts(id),
        summary TEXT,
        version_number INTEGER NOT NULL,
        is_current INTEGER NOT NULL DEFAULT 1,
        superseded_by_report_id TEXT REFERENCES reports(id),
        published_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private createReportIndexes(): void {
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_case_kind_current
      ON reports(case_id, kind)
      WHERE is_current = 1;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_case_kind_version
      ON reports(case_id, kind, version_number);
    `);
  }
}

function mapCase(row: SqlRow): CaseRecord {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    displayName: String(row.display_name),
    normalizedName: String(row.normalized_name),
    counterpartyKind: row.counterparty_kind as CaseRecord["counterpartyKind"],
    legalName: nullableString(row.legal_name),
    incorporationCountry: nullableString(row.incorporation_country),
    incorporationState: nullableString(row.incorporation_state),
    website: nullableString(row.website),
    registrySearchUrl: nullableString(row.registry_search_url),
    publicListingUrl: nullableString(row.public_listing_url),
    exchangeName: nullableString(row.exchange_name),
    stockSymbol: nullableString(row.stock_symbol),
    requestedBy: nullableString(row.requested_by),
    notes: nullableString(row.notes),
    slackChannelId: nullableString(row.slack_channel_id),
    slackThreadTs: nullableString(row.slack_thread_ts),
    caseStatus: row.case_status as CaseStatus,
    recommendation: row.recommendation as Recommendation,
    decisionSummary: nullableString(row.decision_summary),
    policyVersion: String(row.policy_version),
    decisionMatrixVersion: String(row.decision_matrix_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapProfile(row: SqlRow): ProfileRecord {
  return {
    id: String(row.id),
    counterpartyKind: row.counterparty_kind as ProfileRecord["counterpartyKind"],
    displayName: String(row.display_name),
    normalizedName: String(row.normalized_name),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

function mapCaseSummary(row: SqlRow): CaseSummary {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    counterpartyKind: row.counterparty_kind as CaseSummary["counterpartyKind"],
    caseStatus: row.case_status as CaseStatus,
    recommendation: row.recommendation as Recommendation,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMessage(row: SqlRow): CaseMessageRecord {
  return {
    id: String(row.id),
    caseId: nullableString(row.case_id),
    direction: row.direction as CaseMessageRecord["direction"],
    transport: String(row.transport),
    channelId: nullableString(row.channel_id),
    threadTs: nullableString(row.thread_ts),
    externalMessageId: nullableString(row.external_message_id),
    actorId: nullableString(row.actor_id),
    actorLabel: nullableString(row.actor_label),
    body: String(row.body),
    createdAt: String(row.created_at),
  };
}

function mapStep(row: SqlRow): WorkflowStepRecord {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    stepKey: row.step_key as WorkflowStepKey,
    hardGate: Number(row.hard_gate) === 1,
    status: row.status as WorkflowStepStatus,
    note: nullableString(row.note),
    startedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapFact(row: SqlRow): FactRecord {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    stepKey: row.step_key as WorkflowStepKey,
    factKey: String(row.fact_key),
    summary: String(row.summary),
    valueJson: String(row.value_json),
    verificationStatus: row.verification_status as FactRecord["verificationStatus"],
    sourceId: nullableString(row.source_id),
    evidenceIds: parseJson<string[]>(nullableString(row.evidence_ids_json), []),
    freshnessExpiresAt: nullableString(row.freshness_expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapIssue(row: SqlRow): IssueRecord {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    stepKey: row.step_key as WorkflowStepKey,
    severity: row.severity as IssueRecord["severity"],
    status: row.status as IssueRecord["status"],
    title: String(row.title),
    detail: String(row.detail),
    evidenceIds: parseJson<string[]>(nullableString(row.evidence_ids_json), []),
    createdAt: String(row.created_at),
    resolvedAt: nullableString(row.resolved_at),
  };
}

function mapArtifact(row: SqlRow): ArtifactRecord {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    stepKey: row.step_key as ArtifactRecord["stepKey"],
    title: String(row.title),
    sourceId: nullableString(row.source_id),
    storageBackend: String(row.storage_backend),
    relativePath: String(row.relative_path),
    contentType: String(row.content_type),
    sourceUrl: nullableString(row.source_url),
    metadataJson: String(row.metadata_json),
    createdAt: String(row.created_at),
  };
}

function mapReport(row: SqlRow): ReportRecord {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    kind: row.kind as ReportKind,
    status: row.status as ReportStatus,
    artifactId: nullableString(row.artifact_id),
    summary: nullableString(row.summary),
    versionNumber: Number(row.version_number ?? 1),
    isCurrent: Number(row.is_current ?? 1) === 1,
    supersededByReportId: nullableString(row.superseded_by_report_id),
    publishedAt: nullableString(row.published_at) ?? String(row.created_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapReviewTask(row: SqlRow): ReviewTaskRecord {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    stepKey: row.step_key as WorkflowStepKey,
    status: row.status as ReviewTaskRecord["status"],
    title: String(row.title),
    instructions: String(row.instructions),
    resolutionNotes: nullableString(row.resolution_notes),
    outcome: (nullableString(row.outcome) as ReviewOutcome | null) ?? null,
    createdAt: String(row.created_at),
    resolvedAt: nullableString(row.resolved_at),
  };
}

function mapJob(row: SqlRow): JobRecord {
  return {
    id: String(row.id),
    caseId: nullableString(row.case_id),
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    payloadJson: String(row.payload_json),
    attempts: Number(row.attempts),
    lastError: nullableString(row.last_error),
    runAfter: String(row.run_after),
    lockedAt: nullableString(row.locked_at),
    lockedBy: nullableString(row.locked_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapAuditEvent(row: SqlRow): AuditEventRecord {
  return {
    id: String(row.id),
    caseId: nullableString(row.case_id),
    eventType: String(row.event_type),
    actorType: String(row.actor_type),
    actorId: nullableString(row.actor_id),
    payloadJson: String(row.payload_json),
    createdAt: String(row.created_at),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function createStatusCountMap<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}
