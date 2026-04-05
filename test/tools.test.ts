import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getConfig } from "../src/config.js";
import { PolicyBotRuntime } from "../src/runtime.js";
import { createToolRuntime, createToolRunner, type ToolContext } from "../src/tools.js";

const policyDirectory = join(process.cwd(), "policy");

test("tool runtime lists cases, fetches case snapshots, and returns open review tasks", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-tools-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
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

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Acme Labs",
      counterpartyKind: "individual",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: null,
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const { runTool } = createToolRuntime(runtime);
    const health = (await runTool("get_health", {})) as {
      caseCounts: Record<string, number>;
      openReviewTaskCount: number;
    };
    assert.equal(health.caseCounts.draft, 1);
    assert.equal(health.openReviewTaskCount, 0);

    const cases = (await runTool("list_cases", {})) as Array<Record<string, unknown>>;
    assert.equal(cases.length, 1);
    assert.equal(cases[0]?.case_id, snapshot.caseRecord.id);

    const fullCase = (await runTool("get_case", {
      case_id: snapshot.caseRecord.id,
    })) as { case_id: string };
    assert.equal(fullCase.case_id, snapshot.caseRecord.id);

    await runtime.runWorkerUntilIdle("test-worker");
    const queue = (await runTool("get_review_queue", {
      case_id: snapshot.caseRecord.id,
    })) as Array<{ id: string; title: string; step: string }>;
    assert.ok(queue.length >= 2);
    assert.ok(queue.every((task) => typeof task.id === "string"));

    const reviewPacket = (await runTool("get_review_packet", {
      case_id: snapshot.caseRecord.id,
    })) as {
      case_id: string;
      reports: Record<string, { id: string; title: string; version: number }>;
      report_versions: Record<
        string,
        {
          report_id: string;
          version_number: number;
          published_at: string;
          is_current: boolean;
          superseded_by_report_id: string | null;
        }
      >;
      report_history_counts: Record<string, number>;
      case_readiness_banner: {
        status: string;
        mode: string;
        effort: string;
        nextAction: string;
        firstFileToOpen:
          | {
              kind: string;
              label: string;
              artifact_id: string | null;
              source_url: string | null;
              authoritative: boolean;
            }
          | null;
        decisionPathLength: string;
        primaryBlocker: string;
        reviewEntryPoint:
          | {
              step_key: string;
              start_here:
                | {
                    kind: string;
                    label: string;
                    artifact_id: string | null;
                    source_url: string | null;
                    authoritative: boolean;
                  }
                | null;
              clear_when: string;
            }
          | null;
        completionTarget: string;
        summary: string;
      };
      case_bottlenecks: Array<{
        step_key: string;
        summary: string;
        clearance_condition: string;
        review_handoff_note: string;
        review_blockers: string[];
      }>;
      decision_summary: {
        open_review_stages: number;
        hard_gate_stages: number;
        blocked_on_official_evidence: number;
        stages_with_source_gaps: number;
        stale_stages: number;
        unknown_freshness_stages: number;
        refresh_first_stages: number;
        authoritative_clearance_stages: number;
        multi_artifact_review_stages: number;
        well_supported_stages: number;
        thin_or_supporting_only_stages: number;
        ready_to_clear_stages: number;
        stages_with_review_blockers: number;
      };
      decision_checklist: Array<{
        step_key: string;
        stage_report: string | null;
        readiness: string;
        review_snapshot: string;
        stage_freshness: string;
        stage_freshness_note: string;
        rerun_recommendation: string;
        rerun_recommendation_reason: string;
        clearance_path: string;
        clearance_path_reason: string;
        clearance_condition: string;
        review_handoff_note: string;
        review_completeness: string;
        review_completeness_reason: string;
        recommended_outcome: string;
        recommended_outcome_reason: string;
        review_priority_reason: string;
        review_blockers: string[];
        reviewer_action: string;
        authoritative_evidence_count: number;
        best_next_click: {
          kind: string;
          label: string;
          artifact_id: string | null;
          source_url: string | null;
          authoritative: boolean;
        };
        top_evidence: Array<{
          title: string;
          artifact_id: string;
          source_url: string | null;
          authoritative?: boolean;
        }>;
      }>;
      open_review_tasks: Array<{ title: string }>;
    };
    assert.equal(reviewPacket.case_id, snapshot.caseRecord.id);
    assert.ok(typeof reviewPacket.reports.review_packet === "object");
    assert.ok(typeof reviewPacket.reports.working === "object");
    assert.ok(typeof reviewPacket.reports.traceability === "object");
    assert.ok(typeof reviewPacket.report_versions.working?.report_id === "string");
    assert.ok((reviewPacket.report_versions.working?.version_number ?? 0) >= 1);
    assert.equal(reviewPacket.report_versions.working?.is_current, true);
    assert.ok((reviewPacket.report_history_counts.working ?? 0) >= 1);
    assert.ok(typeof reviewPacket.case_readiness_banner.status === "string");
    assert.ok(reviewPacket.case_readiness_banner.status.length > 0);
    assert.ok(typeof reviewPacket.case_readiness_banner.mode === "string");
    assert.ok(reviewPacket.case_readiness_banner.mode.length > 0);
    assert.ok(typeof reviewPacket.case_readiness_banner.effort === "string");
    assert.ok(reviewPacket.case_readiness_banner.effort.length > 0);
    assert.ok(typeof reviewPacket.case_readiness_banner.nextAction === "string");
    assert.ok(reviewPacket.case_readiness_banner.nextAction.length > 0);
    assert.ok(reviewPacket.case_readiness_banner.firstFileToOpen != null);
    assert.ok(
      typeof reviewPacket.case_readiness_banner.firstFileToOpen?.kind === "string"
    );
    assert.ok(typeof reviewPacket.case_readiness_banner.decisionPathLength === "string");
    assert.ok(reviewPacket.case_readiness_banner.decisionPathLength.length > 0);
    assert.ok(typeof reviewPacket.case_readiness_banner.primaryBlocker === "string");
    assert.ok(reviewPacket.case_readiness_banner.primaryBlocker.length > 0);
    assert.ok(reviewPacket.case_readiness_banner.reviewEntryPoint != null);
    assert.ok(
      typeof reviewPacket.case_readiness_banner.reviewEntryPoint?.step_key === "string"
    );
    assert.ok(
      typeof reviewPacket.case_readiness_banner.reviewEntryPoint?.clear_when === "string"
    );
    assert.ok(typeof reviewPacket.case_readiness_banner.completionTarget === "string");
    assert.ok(reviewPacket.case_readiness_banner.completionTarget.length > 0);
    assert.ok(typeof reviewPacket.case_readiness_banner.summary === "string");
    assert.ok(reviewPacket.case_readiness_banner.summary.length > 0);
    assert.ok(Array.isArray(reviewPacket.case_bottlenecks));
    assert.ok(reviewPacket.case_bottlenecks.length > 0);
    assert.ok(
      reviewPacket.case_bottlenecks.every(
        (item) =>
          typeof item.step_key === "string" &&
          item.step_key.length > 0 &&
          typeof item.summary === "string" &&
          item.summary.length > 0 &&
          typeof item.clearance_condition === "string" &&
          item.clearance_condition.length > 0 &&
          typeof item.review_handoff_note === "string" &&
          item.review_handoff_note.length > 0 &&
          Array.isArray(item.review_blockers)
      )
    );
    assert.ok(reviewPacket.decision_summary.open_review_stages > 0);
    assert.ok(typeof reviewPacket.decision_summary.stale_stages === "number");
    assert.ok(typeof reviewPacket.decision_summary.unknown_freshness_stages === "number");
    assert.ok(typeof reviewPacket.decision_summary.refresh_first_stages === "number");
    assert.ok(typeof reviewPacket.decision_summary.authoritative_clearance_stages === "number");
    assert.ok(typeof reviewPacket.decision_summary.multi_artifact_review_stages === "number");
    assert.ok(typeof reviewPacket.decision_summary.well_supported_stages === "number");
    assert.ok(typeof reviewPacket.decision_summary.ready_to_clear_stages === "number");
    assert.ok(typeof reviewPacket.decision_summary.stages_with_review_blockers === "number");
    assert.ok(Array.isArray(reviewPacket.decision_checklist));
    assert.ok(reviewPacket.decision_checklist.length > 0);
    assert.ok(
      reviewPacket.decision_checklist.every(
        (item) =>
          typeof item.readiness === "string" &&
          item.readiness.length > 0 &&
          typeof item.review_snapshot === "string" &&
          item.review_snapshot.length > 0 &&
          typeof item.stage_freshness === "string" &&
          item.stage_freshness.length > 0 &&
          typeof item.stage_freshness_note === "string" &&
          item.stage_freshness_note.length > 0 &&
          typeof item.rerun_recommendation === "string" &&
          item.rerun_recommendation.length > 0 &&
          typeof item.rerun_recommendation_reason === "string" &&
          item.rerun_recommendation_reason.length > 0 &&
          typeof item.clearance_path === "string" &&
          item.clearance_path.length > 0 &&
          typeof item.clearance_path_reason === "string" &&
          item.clearance_path_reason.length > 0 &&
          typeof item.clearance_condition === "string" &&
          item.clearance_condition.length > 0 &&
          typeof item.review_handoff_note === "string" &&
          item.review_handoff_note.length > 0 &&
          typeof item.review_completeness === "string" &&
          item.review_completeness.length > 0 &&
          typeof item.review_completeness_reason === "string" &&
          item.review_completeness_reason.length > 0 &&
          typeof item.recommended_outcome === "string" &&
          item.recommended_outcome.length > 0 &&
          typeof item.recommended_outcome_reason === "string" &&
          item.recommended_outcome_reason.length > 0 &&
          typeof item.review_priority_reason === "string" &&
          item.review_priority_reason.length > 0 &&
          Array.isArray(item.review_blockers) &&
          typeof item.reviewer_action === "string" &&
          item.reviewer_action.length > 0 &&
          Array.isArray(item.top_evidence) &&
          typeof item.authoritative_evidence_count === "number" &&
          typeof item.best_next_click?.kind === "string"
      )
    );
    assert.ok(reviewPacket.open_review_tasks.every((task) => typeof task.title === "string"));

    assert.ok(reviewPacket.reports.review_packet);
    assert.ok(reviewPacket.reports.review_packet.id);
  } finally {
    runtime.close();
  }
});

test("review packet tool exposes stage reports and reviewer highlights for search-heavy review steps", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-tools-highlights-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
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

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.includes("google") && request.url.includes("Search%20Focus")) {
      return new Response(
        [
          "<html><body>",
          '<script>var payload="\\x3ca href=\\"/url?q=https://news.example.com/search-focus-lawsuit&sa=U\\"\\x3eSearch Focus faces lawsuit review\\x3c/a\\x3e\\x3cdiv\\x3eInvestigation and complaint details discussed in article.\\x3c/div\\x3e\\x3ca href=\\"/url?q=https://blog.example.org/search-focus-update&sa=U\\"\\x3eSearch Focus product update\\x3c/a\\x3e\\x3cdiv\\x3eGeneral product update with no adverse phrasing.\\x3c/div\\x3e";</script>',
          "</body></html>",
        ].join(""),
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    if (request.url.includes("bbb.org") && request.url.includes("Search%20Focus")) {
      return new Response(
        "<html><body><p>BBB Rating A-</p><p>2 customer reviews</p><p>1 complaint closed in last 12 months</p></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    return originalFetch(input, init);
  };

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Search Focus",
      counterpartyKind: "individual",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: null,
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
    const { runTool } = createToolRuntime(runtime);
    const reviewPacket = (await runTool("get_review_packet", {
      case_id: snapshot.caseRecord.id,
    })) as {
      reviewer_highlights: Array<{ step_key: string; summary: string }>;
      stage_reports: Record<string, string>;
      open_review_tasks: Array<{ status: string }>;
    };

    assert.ok(
      reviewPacket.reviewer_highlights.some((highlight) =>
        /reputation/i.test(highlight.step_key)
      )
    );
    assert.ok(
      reviewPacket.reviewer_highlights.some((highlight) =>
        /bbb/i.test(highlight.step_key)
      )
    );
    const reputationHighlight = reviewPacket.reviewer_highlights.find(
      (highlight) => highlight.step_key === "reputation_search"
    );
    assert.ok(reputationHighlight);
    assert.match(
      reputationHighlight.summary,
      /Extracted (?!0 search-result candidates)/
    );
    assert.ok(typeof reviewPacket.stage_reports.reputation_search === "object");
    assert.ok(typeof reviewPacket.stage_reports.bbb_review === "object");
    assert.ok(reviewPacket.open_review_tasks.every((task) => task.status === "open"));
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
  }
});

test("review packet tool exposes known entity structure and entity-resolution stage report for multi-entity cases", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-tools-entities-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
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

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === "https://docs.flashbots.net/policies/terms-of-service") {
      return new Response(
        "<html><body><h1>Flashbots Terms</h1><p>These terms govern services provided by Flashbots Ltd.</p></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      );
    }

    return originalFetch(input, init);
  };

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Flashbots",
      counterpartyKind: "entity",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: null,
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
    const { runTool } = createToolRuntime(runtime);
    const reviewPacket = (await runTool("get_review_packet", {
      case_id: snapshot.caseRecord.id,
    })) as {
      reports: Record<string, string>;
      entity_structures: Array<{ brand?: string; entities?: Array<{ legalName?: string }> }>;
      stage_reports: Record<string, string>;
      decision_checklist: Array<{
        step_key: string;
        review_snapshot?: string;
        stage_freshness?: string;
        stage_freshness_note?: string;
        rerun_recommendation?: string;
        rerun_recommendation_reason?: string;
        clearance_path?: string;
        clearance_path_reason?: string;
        clearance_condition?: string;
        review_handoff_note?: string;
        review_completeness?: string;
        review_completeness_reason?: string;
        recommended_outcome?: string;
        recommended_outcome_reason?: string;
        review_priority_reason?: string;
        review_blockers?: string[];
        best_next_click: { kind: string; artifact_id: string | null };
        top_evidence: Array<{
          title: string;
          artifact_id: string;
          source_url: string | null;
          authoritative?: boolean;
        }>;
      }>;
      open_review_tasks: Array<{ title: string }>;
    };

    assert.ok(
      reviewPacket.entity_structures.some(
        (entityStructure) =>
          entityStructure.brand === "Flashbots" &&
          entityStructure.entities?.some(
            (entity) => entity.legalName === "FLASHBOTS US, LLC"
          )
      )
    );
    assert.ok(typeof reviewPacket.stage_reports.entity_resolution === "object");
    assert.ok(
      reviewPacket.open_review_tasks.some(
        (task) => /Confirm in-scope legal entity/i.test(task.title)
      )
    );
    assert.ok(reviewPacket.reports?.working);
    assert.ok(typeof reviewPacket.reports.working === "object");
    assert.ok(reviewPacket.reports?.traceability);
    assert.ok(typeof reviewPacket.reports.traceability === "object");
    assert.equal(reviewPacket.decision_checklist[0]?.step_key, "good_standing");
    assert.ok(typeof reviewPacket.decision_checklist[0]?.review_snapshot === "string");
    assert.ok(typeof reviewPacket.decision_checklist[0]?.stage_freshness === "string");
    assert.ok(typeof reviewPacket.decision_checklist[0]?.stage_freshness_note === "string");
    assert.ok(typeof reviewPacket.decision_checklist[0]?.rerun_recommendation === "string");
    assert.ok(typeof reviewPacket.decision_checklist[0]?.rerun_recommendation_reason === "string");
    assert.ok(typeof reviewPacket.decision_checklist[0]?.clearance_path === "string");
    assert.ok(typeof reviewPacket.decision_checklist[0]?.clearance_path_reason === "string");
    assert.ok(typeof reviewPacket.decision_checklist[0]?.clearance_condition === "string");
    assert.ok(typeof reviewPacket.decision_checklist[0]?.review_handoff_note === "string");
    assert.ok(typeof reviewPacket.decision_checklist[0]?.review_completeness === "string");
    assert.ok(typeof reviewPacket.decision_checklist[0]?.review_completeness_reason === "string");
    assert.ok(typeof reviewPacket.decision_checklist[0]?.recommended_outcome === "string");
    assert.ok(typeof reviewPacket.decision_checklist[0]?.recommended_outcome_reason === "string");
    assert.ok(typeof reviewPacket.decision_checklist[0]?.review_priority_reason === "string");
    assert.ok(Array.isArray(reviewPacket.decision_checklist[0]?.review_blockers));
    assert.ok(
      reviewPacket.decision_checklist.some((item) => item.top_evidence.length >= 1)
    );
    assert.ok(
      reviewPacket.decision_checklist.some((item) =>
        item.top_evidence.some((evidence) => typeof evidence.authoritative === "boolean")
      )
    );
    assert.ok(
      reviewPacket.decision_checklist.some(
        (item) =>
          item.best_next_click.kind !== "none" &&
          typeof item.best_next_click.artifact_id === "string"
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
    runtime.close();
  }
});

test("review packet output includes traceability summary", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-tools-traceability-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
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

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Acme Labs",
      counterpartyKind: "individual",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: null,
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
    const { runTool } = createToolRuntime(runtime);
    const reviewPacket = (await runTool("get_review_packet", {
      case_id: snapshot.caseRecord.id,
    })) as {
      reports: Record<string, { id: string; title: string; version: number }>;
    };

    assert.ok(reviewPacket.reports.review_packet);
    const freshSnapshot = runtime.workflow.getCaseSnapshot(snapshot.caseRecord.id);
    const packetArtifact = freshSnapshot.artifacts.find(
      (artifact) => freshSnapshot.reports.some(
        (report) => report.kind === "review_packet" && report.artifactId === artifact.id
      )
    );
    assert.ok(packetArtifact);
    const packetPath = runtime.artifactStore.resolveAbsolutePath(packetArtifact!);
    const packetBody = readFileSync(packetPath, "utf8");
    assert.match(packetBody, /## Review Readiness/);
    assert.match(packetBody, /Status:/);
    assert.match(packetBody, /Mode:/);
    assert.match(packetBody, /Effort:/);
    assert.match(packetBody, /Next action:/);
    assert.match(packetBody, /Completion target:/);
    assert.match(packetBody, /Summary:/);
    assert.match(packetBody, /## Case Bottlenecks/);
    assert.match(packetBody, /## Traceability Summary/);
    assert.match(packetBody, /## Decision Package/);
    assert.match(packetBody, /Primary blocker:/);
    assert.match(packetBody, /## Decision Checklist/);
    assert.match(packetBody, /Open review stages:/);
    assert.match(packetBody, /Hard-gate stages:/);
    assert.match(packetBody, /Blocked on official evidence:/);
    assert.match(packetBody, /Stale stages:/);
    assert.match(packetBody, /Unknown freshness stages:/);
    assert.match(packetBody, /Refresh-first stages:/);
    assert.match(packetBody, /Authoritative-clearance stages:/);
    assert.match(packetBody, /Multi-artifact review stages:/);
    assert.match(packetBody, /Well-supported stages:/);
    assert.match(packetBody, /Thin or supporting-only stages:/);
    assert.match(packetBody, /Ready-to-clear stages:/);
    assert.match(packetBody, /Stages with review blockers:/);
    assert.match(packetBody, /hard_gate=/);
    assert.match(packetBody, /readiness=/);
    assert.match(packetBody, /review_snapshot=/);
    assert.match(packetBody, /freshness=/);
    assert.match(packetBody, /rerun_recommendation=/);
    assert.match(packetBody, /clearance_path=/);
    assert.match(packetBody, /review_completeness=/);
    assert.match(packetBody, /Start here:/);
    assert.match(packetBody, /Handoff:/);
    assert.match(packetBody, /recommended_outcome=/);
    assert.match(packetBody, /authoritative_evidence=/);
    assert.match(packetBody, /Best next click:/);
    assert.match(packetBody, /Freshness note:/);
    assert.match(packetBody, /Rerun note:/);
    assert.match(packetBody, /Clearance note:/);
    assert.match(packetBody, /Handoff note:/);
    assert.match(packetBody, /Clear when:/);
    assert.match(packetBody, /Priority note:/);
    assert.match(packetBody, /Coverage note:/);
    assert.match(packetBody, /Outcome note:/);
    assert.match(packetBody, /Review blockers:/);
    assert.match(packetBody, /Top evidence:/);
    assert.match(packetBody, /Reviewer action:/);
    assert.match(packetBody, /stage_report=/);
    assert.match(packetBody, /Facts with accessible sources:/);
    assert.match(packetBody, /Traceability Gaps/);
    assert.match(packetBody, /## Unsupported Findings/);
    assert.match(packetBody, /## Source Index/);
    assert.ok(
      packetBody.indexOf("Good Standing [good_standing]") <
        packetBody.indexOf("Reputation Search [reputation_search]")
    );
  } finally {
    runtime.close();
  }
});

test("action tools: create_case, get_case via thread context, resolve_review, finalize_case", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-tools-actions-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
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

  const context: ToolContext = {
    threadCaseId: null,
    channelId: "C_TEST",
    threadTs: "1000.000",
    actorId: "U_TESTER",
    reviewerUserIds: null,
  };

  try {
    const runTool = createToolRunner(runtime, context);

    // create_case via tool
    const created = (await runTool("create_case", {
      display_name: "Action Test Corp",
      counterparty_kind: "individual",
      notes: "Testing action tools",
    })) as { case_id: string; message: string; status: string };

    assert.ok(created.case_id);
    assert.match(created.message, /created/i);
    assert.equal(created.status, "draft");

    // get_case via thread context (no case_id needed)
    const threadContext: ToolContext = {
      ...context,
      threadCaseId: created.case_id,
    };
    const threadRunTool = createToolRunner(runtime, threadContext);

    const caseInfo = (await threadRunTool("get_case", {})) as {
      case_id: string;
      display_name: string;
      status: string;
    };
    assert.equal(caseInfo.case_id, created.case_id);
    assert.equal(caseInfo.display_name, "Action Test Corp");

    // run jobs to process the workflow
    await runtime.runWorkerUntilIdle("action-test");

    // check review queue
    const queue = (await threadRunTool("get_review_queue", {})) as Array<{
      id: string;
      title: string;
      step: string;
    }>;
    assert.ok(queue.length >= 2);

    // resolve first review task
    const firstTask = queue[0]!;
    const resolved = (await threadRunTool("resolve_review_task", {
      review_task_id: firstTask.id,
      outcome: "clear",
      notes: "Automated test clearance.",
    })) as { message: string; case_id: string; remaining_review_tasks: number };
    assert.match(resolved.message, /clear/i);
    assert.equal(resolved.case_id, created.case_id);

    // finalize case
    const finalized = (await threadRunTool("finalize_case", {
      recommendation: "approved",
      notes: "All checks passed in test.",
    })) as { message: string; status: string; recommendation: string };
    assert.match(finalized.message, /approved/i);
    assert.equal(finalized.status, "completed");
    assert.equal(finalized.recommendation, "approved");

    // verify the case thread was bound
    const boundCase = runtime.storage.findCaseByThread("C_TEST", "1000.000");
    assert.ok(boundCase);
    assert.equal(boundCase!.id, created.case_id);
  } finally {
    runtime.close();
  }
});

test("action tools: rerun_step clears and requeues a step", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-tools-rerun-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
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

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "Rerun Tool Test",
      counterpartyKind: "individual",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: null,
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    await runtime.runWorkerUntilIdle("rerun-test");

    const context: ToolContext = {
      threadCaseId: snapshot.caseRecord.id,
      channelId: "C_TEST",
      threadTs: "2000.000",
      actorId: "U_TESTER",
      reviewerUserIds: null,
    };
    const runTool = createToolRunner(runtime, context);

    const result = (await runTool("rerun_step", {
      step_key: "reputation_search",
    })) as { message: string; steps: Array<{ step: string; status: string }> };

    assert.match(result.message, /reputation_search/i);
    const repStep = result.steps.find((step) => step.step === "reputation_search");
    assert.ok(repStep);
    assert.equal(repStep!.status, "pending");
  } finally {
    runtime.close();
  }
});

test("action tools: resolve_case_id falls back to thread context", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-tools-resolve-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
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

  try {
    // No thread case, no explicit case_id — should error
    const noContext: ToolContext = {
      threadCaseId: null,
      channelId: "C_TEST",
      threadTs: "3000.000",
      reviewerUserIds: null,
      actorId: "U_TESTER",
    };
    const runTool = createToolRunner(runtime, noContext);

    await assert.rejects(
      () => runTool("get_case", {}),
      (error: Error) => {
        assert.match(error.message, /no case id/i);
        return true;
      }
    );
  } finally {
    runtime.close();
  }
});

test("action tools: access control blocks non-reviewers from finalize and resolve", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-tools-acl-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
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

  try {
    const snapshot = await runtime.workflow.createCase({
      displayName: "ACL Test Corp",
      counterpartyKind: "individual",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: null,
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    await runtime.runWorkerUntilIdle("acl-test");

    // Restricted context: only U_REVIEWER can finalize
    const restricted: ToolContext = {
      threadCaseId: snapshot.caseRecord.id,
      channelId: "C_TEST",
      threadTs: "4000.000",
      actorId: "U_RANDOM",
      reviewerUserIds: ["U_REVIEWER"],
    };
    const runTool = createToolRunner(runtime, restricted);

    // Non-reviewer should be blocked from finalize
    await assert.rejects(
      () => runTool("finalize_case", { recommendation: "approved", notes: "test" }),
      (error: Error) => {
        assert.match(error.message, /reviewer/i);
        return true;
      }
    );

    // Non-reviewer should be blocked from resolve
    const queue = runtime.workflow.listReviewTasks(snapshot.caseRecord.id);
    const openTask = queue.find((task) => task.status === "open");
    if (openTask) {
      await assert.rejects(
        () => runTool("resolve_review_task", {
          review_task_id: openTask.id,
          outcome: "clear",
          notes: "test",
        }),
        (error: Error) => {
          assert.match(error.message, /reviewer/i);
          return true;
        }
      );
    }

    // Reviewer SHOULD succeed
    const allowed: ToolContext = {
      threadCaseId: snapshot.caseRecord.id,
      channelId: "C_TEST",
      threadTs: "4000.000",
      actorId: "U_REVIEWER",
      reviewerUserIds: ["U_REVIEWER"],
    };
    const reviewerTool = createToolRunner(runtime, allowed);
    const result = (await reviewerTool("finalize_case", {
      recommendation: "approved",
      notes: "Reviewer approved.",
    })) as { message: string; status: string };
    assert.match(result.message, /approved/i);
    assert.equal(result.status, "completed");
  } finally {
    runtime.close();
  }
});

test("action tools: search_cases finds by name and empty query returns nothing", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-tools-search-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
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

  try {
    await runtime.workflow.createCase({
      displayName: "Searchable Corp",
      counterpartyKind: "individual",
      legalName: null,
      incorporationCountry: null,
      incorporationState: null,
      website: null,
      registrySearchUrl: null,
      publicListingUrl: null,
      exchangeName: null,
      stockSymbol: null,
      requestedBy: "tester",
      notes: null,
      slackChannelId: null,
      slackThreadTs: null,
    });

    const context: ToolContext = {
      threadCaseId: null,
      channelId: "C_TEST",
      threadTs: "5000.000",
      actorId: "U_TESTER",
      reviewerUserIds: null,
    };
    const runTool = createToolRunner(runtime, context);

    // Search by name
    const found = (await runTool("search_cases", { query: "Searchable" })) as Array<{
      display_name: string;
    }>;
    assert.equal(found.length, 1);
    assert.equal(found[0]?.display_name, "Searchable Corp");

    // Search by partial name
    const partial = (await runTool("search_cases", { query: "search" })) as Array<unknown>;
    assert.equal(partial.length, 1);

    // Empty query returns nothing
    const empty = (await runTool("search_cases", { query: "   " })) as Array<unknown>;
    assert.equal(empty.length, 0);

    // Non-matching query
    const none = (await runTool("search_cases", { query: "zzzznotfound" })) as Array<unknown>;
    assert.equal(none.length, 0);
  } finally {
    runtime.close();
  }
});

test("action tools: create_case returns duplicate_warning for active cases with same name", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "policy-bot-tools-dupe-"));
  const runtime = new PolicyBotRuntime(
    getConfig({
      POLICY_BOT_RUNTIME: "local",
      POLICY_BOT_POLICY_DIR: policyDirectory,
      POLICY_BOT_DB_PATH: join(tempRoot, "bot.sqlite"),
      POLICY_BOT_ARTIFACT_DIR: join(tempRoot, "artifacts"),
      POLICY_BOT_REPORT_DIR: join(tempRoot, "reports"),
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

  try {
    const context: ToolContext = {
      threadCaseId: null,
      channelId: "C_TEST",
      threadTs: "6000.000",
      actorId: "U_TESTER",
      reviewerUserIds: null,
    };
    const runTool = createToolRunner(runtime, context);

    // Create first case
    const first = (await runTool("create_case", {
      display_name: "Duplicate Test Co",
      counterparty_kind: "individual",
    })) as { case_id: string; duplicate_warning?: string };
    assert.ok(first.case_id);
    assert.equal(first.duplicate_warning, undefined);

    // Create second case with same name — different thread
    const context2: ToolContext = {
      threadCaseId: null,
      channelId: "C_TEST",
      threadTs: "6001.000",
      actorId: "U_TESTER",
      reviewerUserIds: null,
    };
    const runTool2 = createToolRunner(runtime, context2);
    const second = (await runTool2("create_case", {
      display_name: "DUPLICATE TEST CO",
      counterparty_kind: "individual",
    })) as { case_id: string; duplicate_warning?: string };
    assert.ok(second.case_id);
    assert.ok(second.duplicate_warning);
    assert.match(second.duplicate_warning, /existing active case/i);
  } finally {
    runtime.close();
  }
});
