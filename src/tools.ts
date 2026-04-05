import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";

import type { PolicyBotRuntime } from "./runtime.js";
import type { CreateCaseInput, ReviewOutcome, WorkflowStepKey } from "./types.js";
import { asNullableString, parseJson } from "./utils.js";

export interface ToolContext {
  threadCaseId: string | null;
  channelId: string;
  threadTs: string;
  actorId: string | null;
  reviewerUserIds: string[] | null;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function summarizeFactFreshness(
  facts: Array<{ freshnessExpiresAt?: string | null }>
): {
  label: "current" | "stale" | "unknown";
  note: string;
} {
  const freshnessValues = facts
    .map((fact) => fact.freshnessExpiresAt)
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => ({ raw: value, parsed: Date.parse(value) }))
    .filter((value) => Number.isFinite(value.parsed))
    .sort((left, right) => left.parsed - right.parsed);

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
  stageFreshness: "current" | "stale" | "unknown",
  hardGate: boolean,
  readiness: string,
  reviewCompleteness: "blocked" | "well_supported" | "supported_with_gaps" | "supporting_only" | "thin"
): {
  label:
    | "refresh_first"
    | "review_current_evidence"
    | "review_current_evidence_then_refresh_if_needed";
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
      readiness === "blocked_missing_official_evidence" ||
      readiness === "awaiting_hard_gate_evidence" ||
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
  readiness: string,
  reviewCompleteness: "blocked" | "well_supported" | "supported_with_gaps" | "supporting_only" | "thin",
  authoritativeEvidenceCount: number,
  evidenceCount: number,
  sourceGapFactCount: number,
  openIssueCount: number,
  hasStageReport: boolean
): {
  label:
    | "additional_evidence_required"
    | "stage_report_then_authoritative_evidence"
    | "authoritative_evidence_only"
    | "multiple_artifacts_required";
  reason: string;
} {
  if (
    readiness === "blocked_missing_official_evidence" ||
    readiness === "awaiting_hard_gate_evidence" ||
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

  if (sourceGapFactCount > 0 || openIssueCount > 0 || readiness === "adverse_evidence_present") {
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
  clearancePath:
    | "additional_evidence_required"
    | "stage_report_then_authoritative_evidence"
    | "authoritative_evidence_only"
    | "multiple_artifacts_required",
  hardGate: boolean,
  readiness: string
): string {
  if (clearancePath === "additional_evidence_required") {
    return hardGate ||
      readiness === "blocked_missing_official_evidence" ||
      readiness === "awaiting_hard_gate_evidence"
      ? "Clear only after the required authoritative evidence is linked for this stage."
      : "Clear only after stronger linked evidence is added and the current blockers are resolved.";
  }

  if (clearancePath === "multiple_artifacts_required") {
    return readiness === "adverse_evidence_present"
      ? "Clear only if the linked adverse record is disproven or resolved and the remaining blockers are closed."
      : "Clear only after reviewing the linked artifacts together and resolving any remaining gaps or open issues.";
  }

  if (clearancePath === "stage_report_then_authoritative_evidence") {
    return "Clear after the stage report matches the linked authoritative evidence and no review blockers remain.";
  }

  return "Clear after a direct check of the linked authoritative evidence confirms the stage result.";
}

function summarizeReviewHandoffNote(
  clearancePath:
    | "additional_evidence_required"
    | "stage_report_then_authoritative_evidence"
    | "authoritative_evidence_only"
    | "multiple_artifacts_required",
  rerunRecommendation:
    | "refresh_first"
    | "review_current_evidence"
    | "review_current_evidence_then_refresh_if_needed",
  bestNextClickKind: "stage_report" | "authoritative_evidence" | "supporting_evidence" | "none",
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

function summarizeCaseReadinessBanner(
  entries: Array<{
    hardGate: boolean;
    readiness: string;
    rerunRecommendation:
      | "refresh_first"
      | "review_current_evidence"
      | "review_current_evidence_then_refresh_if_needed";
    reviewCompleteness: "blocked" | "well_supported" | "supported_with_gaps" | "supporting_only" | "thin";
    clearancePath:
      | "additional_evidence_required"
      | "stage_report_then_authoritative_evidence"
      | "authoritative_evidence_only"
      | "multiple_artifacts_required";
    sourceGapFactCount: number;
    openIssueCount: number;
  }>
): {
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
    if (
      entry.hardGate &&
      (entry.readiness === "blocked_missing_official_evidence" ||
        entry.readiness === "awaiting_hard_gate_evidence")
    ) {
      blockerCategories.add("hard_gate_evidence");
    }
    if (entry.readiness === "adverse_evidence_present") {
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

  if (entries.some((entry) => entry.readiness === "adverse_evidence_present")) {
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
        entry.hardGate &&
        (entry.readiness === "blocked_missing_official_evidence" ||
          entry.readiness === "awaiting_hard_gate_evidence")
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

const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "get_health",
    description:
      "Return a compact health snapshot for cases, jobs, issues, and review tasks.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_cases",
    description:
      "List recent counterparty cases with status and recommendation.",
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum cases to return.",
        },
      },
    },
  },
  {
    name: "get_case",
    description:
      "Fetch a case summary including steps, issues, and review tasks. Omit case_id to use the current thread's case.",
    input_schema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "The case ID. Omit to use the current thread's linked case.",
        },
      },
    },
  },
  {
    name: "get_review_queue",
    description: "List open review tasks across cases or for one case.",
    input_schema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "Optional case ID filter.",
        },
      },
    },
  },
  {
    name: "get_review_packet",
    description:
      "Return reviewer-facing evidence summaries and unresolved review tasks for one case. Omit case_id to use the current thread's case.",
    input_schema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "The case ID. Omit to use the current thread's linked case.",
        },
      },
    },
  },
  {
    name: "create_case",
    description:
      "Create a new counterparty screening case. This starts the automated workflow immediately.",
    input_schema: {
      type: "object",
      properties: {
        display_name: {
          type: "string",
          description: "The counterparty's name (e.g., 'Acme Labs').",
        },
        counterparty_kind: {
          type: "string",
          enum: ["entity", "individual"],
          description: "Whether this is a company/entity or an individual.",
        },
        legal_name: {
          type: "string",
          description: "Official legal name if different from display name.",
        },
        incorporation_country: {
          type: "string",
          description: "Country of incorporation (e.g., 'United States').",
        },
        incorporation_state: {
          type: "string",
          description: "State of incorporation (e.g., 'Delaware').",
        },
        website: {
          type: "string",
          description: "Company website URL.",
        },
        public_listing_url: {
          type: "string",
          description: "URL of the stock exchange listing page, if publicly traded.",
        },
        exchange_name: {
          type: "string",
          description: "Stock exchange name (e.g., 'NASDAQ'). Required with public_listing_url.",
        },
        stock_symbol: {
          type: "string",
          description: "Stock ticker symbol.",
        },
        registry_search_url: {
          type: "string",
          description: "URL to the official corporate registry search result.",
        },
        notes: {
          type: "string",
          description: "Any additional context about this screening request.",
        },
      },
      required: ["display_name", "counterparty_kind"],
    },
  },
  {
    name: "update_case",
    description:
      "Update screening fields on an existing case. This resets and re-queues the workflow with the new information.",
    input_schema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "The case ID. Omit to use the current thread's linked case.",
        },
        legal_name: { type: "string" },
        incorporation_country: { type: "string" },
        incorporation_state: { type: "string" },
        website: { type: "string" },
        public_listing_url: { type: "string" },
        exchange_name: { type: "string" },
        stock_symbol: { type: "string" },
        registry_search_url: { type: "string" },
        notes: { type: "string" },
      },
    },
  },
  {
    name: "resolve_review_task",
    description:
      "Resolve an open review task with an outcome (clear, concern, or reject) and reviewer notes. May require reviewer access.",
    input_schema: {
      type: "object",
      properties: {
        review_task_id: {
          type: "string",
          description: "The review task ID (e.g., 'rev_abc123').",
        },
        outcome: {
          type: "string",
          enum: ["clear", "concern", "reject"],
          description: "Review outcome: clear (pass), concern (flag but pass), reject (fail).",
        },
        notes: {
          type: "string",
          description: "Reviewer notes explaining the decision rationale.",
        },
      },
      required: ["review_task_id", "outcome", "notes"],
    },
  },
  {
    name: "rerun_step",
    description:
      "Re-execute a workflow step from scratch. Clears existing evidence and re-queues the step.",
    input_schema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "The case ID. Omit to use the current thread's linked case.",
        },
        step_key: {
          type: "string",
          enum: [
            "public_market_shortcut",
            "entity_resolution",
            "good_standing",
            "reputation_search",
            "bbb_review",
            "ofac_precheck",
            "ofac_search",
          ],
          description: "Which workflow step to re-execute.",
        },
      },
      required: ["step_key"],
    },
  },
  {
    name: "finalize_case",
    description:
      "Finalize a case decision as approved or terminated. This is the final human decision and closes the case. May require reviewer access.",
    input_schema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "The case ID. Omit to use the current thread's linked case.",
        },
        recommendation: {
          type: "string",
          enum: ["approved", "terminate"],
          description: "Final decision: approved (clear to proceed) or terminate (reject).",
        },
        notes: {
          type: "string",
          description: "Decision rationale for the audit trail.",
        },
      },
      required: ["recommendation", "notes"],
    },
  },
  {
    name: "run_pending_jobs",
    description: "Trigger background processing of queued workflow jobs.",
    input_schema: {
      type: "object",
      properties: {
        worker_count: {
          type: "number",
          description: "Number of concurrent workers. Default 1.",
        },
      },
    },
  },
  {
    name: "rebuild_report",
    description:
      "Regenerate all reports for a case with current data. Omit case_id to use the current thread's case.",
    input_schema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "The case ID. Omit to use the current thread's linked case.",
        },
      },
    },
  },
  {
    name: "export_case",
    description:
      "Export a case bundle with all artifacts, reports, and audit trail. Omit case_id to use the current thread's case.",
    input_schema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "The case ID. Omit to use the current thread's linked case.",
        },
      },
    },
  },
  {
    name: "search_cases",
    description:
      "Search existing cases by counterparty name. Useful for checking if a company has already been screened.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Name or partial name to search for.",
        },
        limit: {
          type: "number",
          description: "Maximum results. Default 10.",
        },
      },
      required: ["query"],
    },
  },
];

export function getToolDefinitions(): Tool[] {
  return TOOL_DEFINITIONS;
}

export function createToolRunner(
  runtime: PolicyBotRuntime,
  context: ToolContext
): (name: string, input: Record<string, unknown>) => Promise<unknown> {
  return async (name, input) => {
    switch (name) {
      case "get_health":
        return runtime.getHealthSnapshot();
      case "list_cases":
        return runtime.workflow
          .listCases()
          .slice(0, readPositiveInteger(input.limit, DEFAULT_LIMIT, MAX_LIMIT, "limit"))
          .map((item) => ({
            case_id: item.id,
            display_name: item.displayName,
            counterparty_kind: item.counterpartyKind,
            status: item.caseStatus,
            recommendation: item.recommendation,
            created_at: item.createdAt,
          }));
      case "get_case": {
        const caseId = resolveCase(input.case_id, context);
        const snapshot = runtime.workflow.getCaseSnapshot(caseId);
        return {
          case_id: snapshot.caseRecord.id,
          display_name: snapshot.caseRecord.displayName,
          counterparty_kind: snapshot.caseRecord.counterpartyKind,
          status: snapshot.caseRecord.caseStatus,
          recommendation: snapshot.caseRecord.recommendation,
          decision_summary: snapshot.caseRecord.decisionSummary,
          legal_name: snapshot.caseRecord.legalName,
          jurisdiction: [snapshot.caseRecord.incorporationState, snapshot.caseRecord.incorporationCountry]
            .filter(Boolean)
            .join(", ") || null,
          website: snapshot.caseRecord.website,
          steps: snapshot.steps.map((step) => ({
            step: step.stepKey,
            status: step.status,
            hard_gate: step.hardGate,
            note: step.note,
          })),
          open_review_tasks: snapshot.reviewTasks
            .filter((task) => task.status === "open")
            .map((task) => ({
              id: task.id,
              title: task.title,
              step: task.stepKey,
              instructions: task.instructions,
            })),
          open_issues: snapshot.issues
            .filter((issue) => issue.status === "open")
            .map((issue) => ({
              severity: issue.severity,
              step: issue.stepKey,
              title: issue.title,
            })),
          facts_count: snapshot.facts.length,
          artifacts_count: snapshot.artifacts.length,
          created_at: snapshot.caseRecord.createdAt,
        };
      }
      case "get_review_queue":
        return runtime.workflow
          .listReviewTasks(readOptionalString(input.case_id, "case_id") ?? undefined)
          .filter((task) => task.status === "open")
          .map((task) => ({
            id: task.id,
            title: task.title,
            step: task.stepKey,
            case_id: task.caseId,
            instructions: task.instructions,
          }));
      case "create_case": {
        const displayName = readRequiredString(input.display_name, "display_name");
        const existingCases = runtime.storage.searchCasesByName(displayName, 5);
        const activeExisting = existingCases.filter(
          (item) => item.caseStatus !== "completed" && item.caseStatus !== "terminated"
        );

        const caseInput: CreateCaseInput = {
          displayName,
          counterpartyKind: readCounterpartyKind(input.counterparty_kind),
          legalName: asNullableString(input.legal_name),
          incorporationCountry: asNullableString(input.incorporation_country),
          incorporationState: asNullableString(input.incorporation_state),
          website: asNullableString(input.website),
          registrySearchUrl: asNullableString(input.registry_search_url),
          publicListingUrl: asNullableString(input.public_listing_url),
          exchangeName: asNullableString(input.exchange_name),
          stockSymbol: asNullableString(input.stock_symbol),
          requestedBy: context.actorId,
          notes: asNullableString(input.notes),
          slackChannelId: context.channelId,
          slackThreadTs: context.threadTs,
        };
        const snapshot = await runtime.createCase(caseInput);
        runtime.storage.bindCaseToThread(
          snapshot.caseRecord.id,
          context.channelId,
          context.threadTs
        );
        return {
          message: "Case created and queued for processing.",
          case_id: snapshot.caseRecord.id,
          display_name: snapshot.caseRecord.displayName,
          status: snapshot.caseRecord.caseStatus,
          recommendation: snapshot.caseRecord.recommendation,
          steps: snapshot.steps.map((step) => ({
            step: step.stepKey,
            status: step.status,
          })),
          ...(activeExisting.length > 0
            ? {
                duplicate_warning: `There are ${activeExisting.length} existing active case(s) for a similar name: ${activeExisting.map((item) => `${item.id} (${item.caseStatus})`).join(", ")}. You may want to check those before proceeding.`,
              }
            : {}),
          ...(existingCases.length > 0 && activeExisting.length === 0
            ? {
                prior_cases_note: `${existingCases.length} prior completed/terminated case(s) found for a similar name.`,
              }
            : {}),
        };
      }
      case "update_case": {
        const caseId = resolveCase(input.case_id, context);
        const updateInput = {
          ...(input.legal_name !== undefined ? { legalName: asNullableString(input.legal_name) } : {}),
          ...(input.incorporation_country !== undefined ? { incorporationCountry: asNullableString(input.incorporation_country) } : {}),
          ...(input.incorporation_state !== undefined ? { incorporationState: asNullableString(input.incorporation_state) } : {}),
          ...(input.website !== undefined ? { website: asNullableString(input.website) } : {}),
          ...(input.registry_search_url !== undefined ? { registrySearchUrl: asNullableString(input.registry_search_url) } : {}),
          ...(input.public_listing_url !== undefined ? { publicListingUrl: asNullableString(input.public_listing_url) } : {}),
          ...(input.exchange_name !== undefined ? { exchangeName: asNullableString(input.exchange_name) } : {}),
          ...(input.stock_symbol !== undefined ? { stockSymbol: asNullableString(input.stock_symbol) } : {}),
          ...(input.notes !== undefined ? { notes: asNullableString(input.notes) } : {}),
        };
        const snapshot = await runtime.workflow.updateCaseScreeningInput(caseId, updateInput);
        return {
          message: "Case updated and workflow requeued.",
          case_id: snapshot.caseRecord.id,
          status: snapshot.caseRecord.caseStatus,
          steps: snapshot.steps.map((step) => ({
            step: step.stepKey,
            status: step.status,
          })),
        };
      }
      case "resolve_review_task": {
        requireReviewerAccess(context);
        const taskId = readRequiredString(input.review_task_id, "review_task_id");
        const outcome = readReviewOutcome(input.outcome);
        const notes = readRequiredString(input.notes, "notes");
        const snapshot = await runtime.resolveReviewTask(taskId, outcome, notes, context.actorId);
        return {
          message: `Review task resolved as ${outcome}.`,
          case_id: snapshot.caseRecord.id,
          status: snapshot.caseRecord.caseStatus,
          recommendation: snapshot.caseRecord.recommendation,
          remaining_review_tasks: snapshot.reviewTasks.filter((task) => task.status === "open").length,
        };
      }
      case "rerun_step": {
        const caseId = resolveCase(input.case_id, context);
        const stepKey = readStepKey(input.step_key);
        const snapshot = await runtime.workflow.rerunStep(caseId, stepKey);
        return {
          message: `Requeued ${stepKey} for re-execution.`,
          case_id: snapshot.caseRecord.id,
          status: snapshot.caseRecord.caseStatus,
          steps: snapshot.steps.map((step) => ({
            step: step.stepKey,
            status: step.status,
          })),
        };
      }
      case "finalize_case": {
        requireReviewerAccess(context);
        const caseId = resolveCase(input.case_id, context);
        const recommendation = readFinalizationRecommendation(input.recommendation);
        const notes = readRequiredString(input.notes, "notes");
        const snapshot = await runtime.workflow.finalizeCaseDecision(caseId, recommendation, notes);
        return {
          message: `Case finalized as ${recommendation}.`,
          case_id: snapshot.caseRecord.id,
          status: snapshot.caseRecord.caseStatus,
          recommendation: snapshot.caseRecord.recommendation,
        };
      }
      case "run_pending_jobs": {
        const workers = readPositiveInteger(input.worker_count, 1, 3, "worker_count");
        const processed = await runtime.workflow.runUntilIdleConcurrent("slack-tool", workers, 5);
        return { message: `Processed ${processed} queued job(s) (max 5 per invocation).`, processed };
      }
      case "rebuild_report": {
        const caseId = resolveCase(input.case_id, context);
        const snapshot = await runtime.rebuildCaseReport(caseId);
        return {
          message: "Reports rebuilt.",
          case_id: snapshot.caseRecord.id,
          report_count: snapshot.reports.length,
        };
      }
      case "export_case": {
        const caseId = resolveCase(input.case_id, context);
        const result = await runtime.exportCase(caseId);
        return {
          message: `Case exported.`,
          case_id: result.caseId,
          bundle_directory: result.bundleDirectory,
        };
      }
      case "search_cases": {
        const query = typeof input.query === "string" ? input.query.trim() : "";
        if (!query) {
          return [];
        }
        const limit = readPositiveInteger(input.limit, DEFAULT_LIMIT, MAX_LIMIT, "limit");
        return runtime.storage.searchCasesByName(query, limit).map((item) => ({
          case_id: item.id,
          display_name: item.displayName,
          counterparty_kind: item.counterpartyKind,
          status: item.caseStatus,
          recommendation: item.recommendation,
          created_at: item.createdAt,
        }));
      }
      case "get_review_packet": {
        const snapshot = runtime.workflow.getCaseSnapshot(
          resolveCase(input.case_id, context)
        );
          const reportHistory = runtime.storage.listReportHistory(snapshot.caseRecord.id);
          const sourceGapFacts = snapshot.facts.filter((fact) => {
            const evidenceArtifacts = fact.evidenceIds
              .map((evidenceId) =>
                snapshot.artifacts.find((artifact) => artifact.id === evidenceId) ?? null
              )
              .filter((artifact): artifact is NonNullable<typeof artifact> => artifact != null);
            const hasArtifactSources = evidenceArtifacts.length > 0;
            const hasUrlSources = /https?:\/\//i.test(fact.valueJson);
            return !hasArtifactSources && !hasUrlSources;
          });
          const sourceGapIssues = snapshot.issues.filter((issue) => {
            const evidenceArtifacts = issue.evidenceIds
              .map((evidenceId) =>
                snapshot.artifacts.find((artifact) => artifact.id === evidenceId) ?? null
              )
              .filter((artifact): artifact is NonNullable<typeof artifact> => artifact != null);
            return evidenceArtifacts.length === 0;
          });
          const reports: Record<string, { id: string; title: string; version: number }> = {};
          for (const report of snapshot.reports) {
            if (!report.artifactId) {
              continue;
            }
            const artifact = snapshot.artifacts.find(
              (candidate) => candidate.id === report.artifactId
            );
            if (artifact) {
              reports[report.kind] = { id: report.id, title: artifact.title, version: report.versionNumber };
            }
          }
          const reportVersions = Object.fromEntries(
            snapshot.reports.map((report) => [
              report.kind,
              {
                report_id: report.id,
                version_number: report.versionNumber,
                published_at: report.publishedAt,
                is_current: report.isCurrent,
                superseded_by_report_id: report.supersededByReportId,
              },
            ])
          );
          const reportHistoryCounts = Object.fromEntries(
            reportHistory.reduce<Map<string, number>>((counts, report) => {
              counts.set(report.kind, (counts.get(report.kind) ?? 0) + 1);
              return counts;
            }, new Map<string, number>())
          );

          return {
            case_id: snapshot.caseRecord.id,
            case_status: snapshot.caseRecord.caseStatus,
            recommendation: snapshot.caseRecord.recommendation,
            reports,
            report_versions: reportVersions,
            report_history_counts: reportHistoryCounts,
            stage_reports: Object.fromEntries(
              snapshot.artifacts
                .filter((artifact) => {
                  if (artifact.storageBackend !== "local-report") {
                    return false;
                  }
                  const metadata = parseJson<Record<string, unknown>>(
                    artifact.metadataJson,
                    {}
                  );
                  return (
                    metadata.reportType === "step" &&
                    snapshot.reviewTasks.some(
                      (task) =>
                        task.status === "open" && task.stepKey === artifact.stepKey
                    )
                  );
                })
                .map((artifact) => [
                  String(artifact.stepKey),
                  { id: artifact.id, title: artifact.title },
                ])
            ),
            reviewer_highlights: snapshot.facts
              .filter(
                (fact) =>
                  snapshot.reviewTasks.some(
                    (task) => task.status === "open" && task.stepKey === fact.stepKey
                  ) &&
                  (fact.verificationStatus === "inferred" ||
                    fact.verificationStatus === "unverified" ||
                    fact.verificationStatus === "conflicted")
              )
              .map((fact) => ({
                step_key: fact.stepKey,
                verification_status: fact.verificationStatus,
                summary: fact.summary,
              })),
            entity_structures: snapshot.facts
              .filter((fact) => fact.factKey === "known_entity_structure")
              .map((fact) => parseJson<Record<string, unknown>>(fact.valueJson, {})),
            source_gaps: {
              fact_count: sourceGapFacts.length,
              issue_count: sourceGapIssues.length,
              fact_summaries: sourceGapFacts.map((fact) => fact.summary),
              issue_summaries: sourceGapIssues.map((issue) => issue.title),
            },
            case_readiness_banner: (() => {
              const items = snapshot.reviewTasks
                .filter((task) => task.status === "open")
                .map((task) => task.stepKey)
                .filter((stepKey, index, values) => values.indexOf(stepKey) === index)
                .map((stepKey) => {
                  const step = snapshot.steps.find((candidate) => candidate.stepKey === stepKey);
                  const stepFacts = snapshot.facts.filter((fact) => fact.stepKey === stepKey);
                  const supportedFactCount = stepFacts.filter((fact) => {
                    const evidenceArtifacts = fact.evidenceIds
                      .map((evidenceId) =>
                        snapshot.artifacts.find((artifact) => artifact.id === evidenceId) ?? null
                      )
                      .filter((artifact): artifact is NonNullable<typeof artifact> => artifact != null);
                    const hasArtifactSources = evidenceArtifacts.length > 0;
                    const hasUrlSources = /https?:\/\//i.test(fact.valueJson);
                    return hasArtifactSources || hasUrlSources;
                  }).length;
                  const sourceGapFactCount = stepFacts.length - supportedFactCount;
                  const openIssueCount = snapshot.issues.filter(
                    (issue) => issue.stepKey === stepKey && issue.status === "open"
                  ).length;
                  const evidenceCount = snapshot.artifacts.filter(
                    (artifact) =>
                      artifact.stepKey === stepKey && artifact.storageBackend !== "local-report"
                  ).length;
                  const authoritativeEvidenceCount = snapshot.artifacts.filter(
                    (artifact) =>
                      artifact.stepKey === stepKey &&
                      artifact.storageBackend !== "local-report" &&
                      (artifact.sourceId === "official_registry" ||
                        artifact.sourceId === "public_market_listing" ||
                        artifact.sourceId === "ofac_search" ||
                        artifact.sourceId === "ofac_dataset")
                  ).length;
                  const readiness =
                    step?.hardGate && step?.status === "blocked"
                      ? "blocked_missing_official_evidence"
                      : step?.status === "failed"
                        ? "adverse_evidence_present"
                        : evidenceCount === 0 && (step?.hardGate ?? false)
                          ? "awaiting_hard_gate_evidence"
                          : sourceGapFactCount > 0
                            ? "review_with_source_gaps"
                            : stepFacts.length === 0 && openIssueCount > 0
                              ? "issue_only_review"
                              : "review_ready";
                  const reviewCompleteness: "blocked" | "well_supported" | "supported_with_gaps" | "supporting_only" | "thin" =
                    evidenceCount === 0 && (step?.hardGate ?? false)
                      ? "blocked"
                      : authoritativeEvidenceCount > 0 &&
                          sourceGapFactCount === 0 &&
                          openIssueCount === 0
                        ? "well_supported"
                        : authoritativeEvidenceCount > 0
                          ? "supported_with_gaps"
                          : evidenceCount > 0
                            ? "supporting_only"
                            : "thin";
                  const rerunRecommendation = summarizeRerunRecommendation(
                    summarizeFactFreshness(stepFacts).label,
                    step?.hardGate ?? false,
                    readiness,
                    reviewCompleteness
                  );
                  const clearancePath = summarizeClearancePath(
                    step?.hardGate ?? false,
                    readiness,
                    reviewCompleteness,
                    authoritativeEvidenceCount,
                    evidenceCount,
                    sourceGapFactCount,
                    openIssueCount,
                    snapshot.artifacts.some((artifact) => {
                      if (artifact.storageBackend !== "local-report" || artifact.stepKey !== stepKey) {
                        return false;
                      }
                      const metadata = parseJson<Record<string, unknown>>(artifact.metadataJson, {});
                      return metadata.reportType === "step";
                    })
                  );
                  const clearanceCondition = summarizeClearanceCondition(
                    clearancePath.label,
                    step?.hardGate ?? false,
                    readiness
                  );
                  return {
                    stepKey,
                    hardGate: step?.hardGate ?? false,
                    readiness,
                    rerunRecommendation: rerunRecommendation.label,
                    reviewCompleteness,
                    clearancePath: clearancePath.label,
                    clearanceCondition,
                    sourceGapFactCount,
                    openIssueCount,
                  };
                });
              const prioritizedItems = [...items].sort((left, right) => {
                const priority = (item: {
                  hardGate: boolean;
                  readiness: string;
                  clearanceCondition: string;
                  sourceGapFactCount: number;
                  openIssueCount: number;
                  stepKey: string;
                }): number => {
                  const base =
                    item.readiness === "adverse_evidence_present"
                      ? 0
                      : item.readiness === "blocked_missing_official_evidence"
                        ? 1
                        : item.readiness === "awaiting_hard_gate_evidence"
                          ? 2
                          : item.readiness === "review_with_source_gaps"
                            ? 3
                            : item.readiness === "issue_only_review"
                              ? 4
                              : item.readiness === "review_ready"
                                ? 5
                                : 6;
                  return item.hardGate ? base : base + 10;
                };
                const leftPriority = priority(left);
                const rightPriority = priority(right);
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
              });
              const highestPriority = prioritizedItems[0] ?? null;
              const firstFileToOpen =
                highestPriority == null
                  ? null
                  : (() => {
                      const stepReportArtifact =
                        snapshot.artifacts.find((artifact) => {
                          if (
                            artifact.storageBackend !== "local-report" ||
                            artifact.stepKey !== highestPriority.stepKey
                          ) {
                            return false;
                          }
                          const metadata = parseJson<Record<string, unknown>>(
                            artifact.metadataJson,
                            {}
                          );
                          return metadata.reportType === "step";
                        }) ?? null;
                      if (stepReportArtifact != null) {
                        return {
                          kind: "stage_report",
                          label: `${highestPriority.stepKey} stage report`,
                          artifact_id: stepReportArtifact.id,
                          source_url: null,
                          authoritative: false,
                        };
                      }

                      const capturePriority = (
                        artifact: (typeof snapshot.artifacts)[number]
                      ): number => {
                        const metadata = parseJson<Record<string, unknown>>(
                          artifact.metadataJson,
                          {}
                        );
                        const captureType =
                          typeof metadata.captureType === "string"
                            ? metadata.captureType
                            : null;
                        if (captureType === "screenshot") return 0;
                        if (captureType === "pdf") return 1;
                        if (captureType === "html") return 2;
                        if (artifact.contentType === "application/pdf") return 3;
                        if (artifact.contentType.startsWith("image/")) return 4;
                        if (artifact.contentType === "text/html") return 5;
                        return 6;
                      };
                      const rankedEvidence = snapshot.artifacts
                        .filter(
                          (artifact) =>
                            artifact.stepKey === highestPriority.stepKey &&
                            artifact.storageBackend !== "local-report"
                        )
                        .sort((left, right) => {
                          const leftPriority = capturePriority(left);
                          const rightPriority = capturePriority(right);
                          if (leftPriority !== rightPriority) {
                            return leftPriority - rightPriority;
                          }
                          return left.title.localeCompare(right.title);
                        });
                      const selectedArtifact =
                        rankedEvidence.find(
                          (artifact) =>
                            artifact.sourceId === "official_registry" ||
                            artifact.sourceId === "public_market_listing" ||
                            artifact.sourceId === "ofac_search" ||
                            artifact.sourceId === "ofac_dataset"
                        ) ??
                        rankedEvidence[0] ??
                        null;
                      if (selectedArtifact == null) {
                        return null;
                      }
                      const metadata = parseJson<Record<string, unknown>>(
                        selectedArtifact.metadataJson,
                        {}
                      );
                      const authoritative =
                        selectedArtifact.sourceId === "official_registry" ||
                        selectedArtifact.sourceId === "public_market_listing" ||
                        selectedArtifact.sourceId === "ofac_search" ||
                        selectedArtifact.sourceId === "ofac_dataset";
                      return {
                        kind: authoritative
                          ? "authoritative_evidence"
                          : "supporting_evidence",
                        label: selectedArtifact.title,
                        artifact_id: selectedArtifact.id,
                        source_url:
                          selectedArtifact.sourceUrl ??
                          (typeof metadata.finalUrl === "string" ? metadata.finalUrl : null) ??
                          (typeof metadata.requestedUrl === "string"
                            ? metadata.requestedUrl
                            : null),
                        authoritative,
                      };
                    })();

              return {
                ...summarizeCaseReadinessBanner(items),
                firstFileToOpen,
                decisionPathLength:
                  highestPriority == null
                    ? "no_review_work"
                    : highestPriority.clearancePath === "authoritative_evidence_only"
                      ? "one_file_decision"
                      : highestPriority.clearancePath === "stage_report_then_authoritative_evidence"
                      ? "two_file_decision"
                        : "multi_artifact_decision",
                primaryBlocker:
                  highestPriority == null
                    ? "none"
                    : highestPriority.readiness === "adverse_evidence_present"
                      ? "adverse evidence present"
                      : highestPriority.hardGate &&
                          (highestPriority.readiness === "blocked_missing_official_evidence" ||
                            highestPriority.readiness === "awaiting_hard_gate_evidence")
                        ? "missing authoritative evidence"
                        : highestPriority.sourceGapFactCount > 0
                          ? "source gaps remain"
                          : highestPriority.openIssueCount > 0
                            ? "open issues remain"
                            : highestPriority.reviewCompleteness === "supporting_only"
                              ? "supporting evidence only"
                              : highestPriority.reviewCompleteness === "thin"
                                ? "thin record"
                                : "none",
                reviewEntryPoint:
                  highestPriority == null
                    ? null
                    : {
                        step_key: highestPriority.stepKey,
                        start_here: firstFileToOpen,
                        clear_when: highestPriority.clearanceCondition,
                      },
              };
            })(),
            decision_summary: (() => {
              const items = snapshot.reviewTasks
                .filter((task) => task.status === "open")
                .map((task) => task.stepKey)
                .filter((stepKey, index, values) => values.indexOf(stepKey) === index)
                .map((stepKey) => {
                  const step = snapshot.steps.find((candidate) => candidate.stepKey === stepKey);
                  const stepFacts = snapshot.facts.filter((fact) => fact.stepKey === stepKey);
                  const supportedFactCount = stepFacts.filter((fact) => {
                    const evidenceArtifacts = fact.evidenceIds
                      .map((evidenceId) =>
                        snapshot.artifacts.find((artifact) => artifact.id === evidenceId) ?? null
                      )
                      .filter((artifact): artifact is NonNullable<typeof artifact> => artifact != null);
                    const hasArtifactSources = evidenceArtifacts.length > 0;
                    const hasUrlSources = /https?:\/\//i.test(fact.valueJson);
                    return hasArtifactSources || hasUrlSources;
                  }).length;
                  const sourceGapFactCount = stepFacts.length - supportedFactCount;
                  const openIssueCount = snapshot.issues.filter(
                    (issue) => issue.stepKey === stepKey && issue.status === "open"
                  ).length;
                  const evidenceCount = snapshot.artifacts.filter(
                    (artifact) =>
                      artifact.stepKey === stepKey && artifact.storageBackend !== "local-report"
                  ).length;
                  const authoritativeEvidenceCount = snapshot.artifacts.filter(
                    (artifact) =>
                      artifact.stepKey === stepKey &&
                      artifact.storageBackend !== "local-report" &&
                      (artifact.sourceId === "official_registry" ||
                        artifact.sourceId === "public_market_listing" ||
                        artifact.sourceId === "ofac_search" ||
                        artifact.sourceId === "ofac_dataset")
                  ).length;
                  const readiness =
                    step?.hardGate && step?.status === "blocked"
                      ? "blocked_missing_official_evidence"
                      : step?.status === "failed"
                        ? "adverse_evidence_present"
                        : evidenceCount === 0 && (step?.hardGate ?? false)
                          ? "awaiting_hard_gate_evidence"
                          : sourceGapFactCount > 0
                            ? "review_with_source_gaps"
                            : stepFacts.length === 0 && openIssueCount > 0
                            ? "issue_only_review"
                            : "review_ready";
                  const stageFreshness = summarizeFactFreshness(stepFacts);
                  const rerunRecommendation = summarizeRerunRecommendation(
                    stageFreshness.label,
                    step?.hardGate ?? false,
                    readiness,
                    evidenceCount === 0 && (step?.hardGate ?? false)
                      ? "blocked"
                      : authoritativeEvidenceCount > 0 &&
                          sourceGapFactCount === 0 &&
                          openIssueCount === 0
                        ? "well_supported"
                        : authoritativeEvidenceCount > 0
                          ? "supported_with_gaps"
                          : evidenceCount > 0
                            ? "supporting_only"
                            : "thin"
                  );
                  const clearancePath = summarizeClearancePath(
                    step?.hardGate ?? false,
                    readiness,
                    evidenceCount === 0 && (step?.hardGate ?? false)
                      ? "blocked"
                      : authoritativeEvidenceCount > 0 &&
                          sourceGapFactCount === 0 &&
                          openIssueCount === 0
                        ? "well_supported"
                        : authoritativeEvidenceCount > 0
                          ? "supported_with_gaps"
                          : evidenceCount > 0
                            ? "supporting_only"
                            : "thin",
                    authoritativeEvidenceCount,
                    evidenceCount,
                    sourceGapFactCount,
                    openIssueCount,
                    snapshot.artifacts.some((artifact) => {
                      if (artifact.storageBackend !== "local-report" || artifact.stepKey !== stepKey) {
                        return false;
                      }
                      const metadata = parseJson<Record<string, unknown>>(artifact.metadataJson, {});
                      return metadata.reportType === "step";
                    })
                  );
                  return {
                    hardGate: step?.hardGate ?? false,
                    readiness,
                    evidenceCount,
                    authoritativeEvidenceCount,
                    openIssueCount,
                    sourceGapFactCount,
                    stageFreshness: stageFreshness.label,
                    rerunRecommendation: rerunRecommendation.label,
                    clearancePath: clearancePath.label,
                  };
                });
              return {
                open_review_stages: items.length,
                hard_gate_stages: items.filter((item) => item.hardGate).length,
                blocked_on_official_evidence: items.filter(
                  (item) =>
                    item.readiness === "blocked_missing_official_evidence" ||
                    item.readiness === "awaiting_hard_gate_evidence"
                ).length,
                stages_with_source_gaps: items.filter(
                  (item) => item.sourceGapFactCount > 0
                ).length,
                well_supported_stages: items.filter(
                  (item) =>
                    item.readiness !== "blocked_missing_official_evidence" &&
                    item.readiness !== "awaiting_hard_gate_evidence" &&
                    item.authoritativeEvidenceCount > 0 &&
                    item.sourceGapFactCount === 0 &&
                    item.openIssueCount === 0
                ).length,
                thin_or_supporting_only_stages: items.filter(
                  (item) =>
                    item.authoritativeEvidenceCount === 0 &&
                    item.readiness !== "blocked_missing_official_evidence" &&
                    item.readiness !== "awaiting_hard_gate_evidence"
                ).length,
                ready_to_clear_stages: items.filter(
                  (item) =>
                    item.authoritativeEvidenceCount > 0 &&
                    item.sourceGapFactCount === 0 &&
                    item.openIssueCount === 0 &&
                    item.readiness !== "adverse_evidence_present"
                ).length,
                stages_with_review_blockers: items.filter(
                  (item) =>
                    (item.hardGate && item.authoritativeEvidenceCount === 0) ||
                    item.evidenceCount === 0 ||
                    item.sourceGapFactCount > 0 ||
                    item.openIssueCount > 0 ||
                    item.readiness === "adverse_evidence_present"
                ).length,
                stale_stages: items.filter((item) => item.stageFreshness === "stale").length,
                unknown_freshness_stages: items.filter(
                  (item) => item.stageFreshness === "unknown"
                ).length,
                refresh_first_stages: items.filter(
                  (item) => item.rerunRecommendation === "refresh_first"
                ).length,
                authoritative_clearance_stages: items.filter(
                  (item) =>
                    item.clearancePath === "stage_report_then_authoritative_evidence" ||
                    item.clearancePath === "authoritative_evidence_only"
                ).length,
                multi_artifact_review_stages: items.filter(
                  (item) => item.clearancePath === "multiple_artifacts_required"
                ).length,
              };
            })(),
            case_bottlenecks: (() => {
              const items = snapshot.reviewTasks
                .filter((task) => task.status === "open")
                .map((task) => task.stepKey)
                .filter((stepKey, index, values) => values.indexOf(stepKey) === index)
                .map((stepKey) => {
                  const step = snapshot.steps.find((candidate) => candidate.stepKey === stepKey);
                  const stepFacts = snapshot.facts.filter((fact) => fact.stepKey === stepKey);
                  const supportedFactCount = stepFacts.filter((fact) => {
                    const evidenceArtifacts = fact.evidenceIds
                      .map((evidenceId) =>
                        snapshot.artifacts.find((artifact) => artifact.id === evidenceId) ?? null
                      )
                      .filter((artifact): artifact is NonNullable<typeof artifact> => artifact != null);
                    const hasArtifactSources = evidenceArtifacts.length > 0;
                    const hasUrlSources = /https?:\/\//i.test(fact.valueJson);
                    return hasArtifactSources || hasUrlSources;
                  }).length;
                  const sourceGapFactCount = stepFacts.length - supportedFactCount;
                  const openIssueCount = snapshot.issues.filter(
                    (issue) => issue.stepKey === stepKey && issue.status === "open"
                  ).length;
                  const evidenceCount = snapshot.artifacts.filter(
                    (artifact) =>
                      artifact.stepKey === stepKey && artifact.storageBackend !== "local-report"
                  ).length;
                  const authoritativeEvidenceCount = snapshot.artifacts.filter(
                    (artifact) =>
                      artifact.stepKey === stepKey &&
                      artifact.storageBackend !== "local-report" &&
                      (artifact.sourceId === "official_registry" ||
                        artifact.sourceId === "public_market_listing" ||
                        artifact.sourceId === "ofac_search" ||
                        artifact.sourceId === "ofac_dataset")
                  ).length;
                  const readiness =
                    step?.hardGate && step?.status === "blocked"
                      ? "blocked_missing_official_evidence"
                      : step?.status === "failed"
                        ? "adverse_evidence_present"
                        : evidenceCount === 0 && (step?.hardGate ?? false)
                          ? "awaiting_hard_gate_evidence"
                          : sourceGapFactCount > 0
                            ? "review_with_source_gaps"
                            : stepFacts.length === 0 && openIssueCount > 0
                              ? "issue_only_review"
                              : "review_ready";
                  const reviewCompleteness =
                    evidenceCount === 0 && (step?.hardGate ?? false)
                      ? "blocked"
                      : authoritativeEvidenceCount > 0 &&
                          sourceGapFactCount === 0 &&
                          openIssueCount === 0
                        ? "well_supported"
                        : authoritativeEvidenceCount > 0
                          ? "supported_with_gaps"
                          : evidenceCount > 0
                            ? "supporting_only"
                            : "thin";
                  const reviewSnapshot =
                    readiness === "adverse_evidence_present"
                      ? "treat as adverse / evidence attached"
                      : (step?.hardGate ?? false) && authoritativeEvidenceCount === 0
                        ? "blocked / hard gate / no authoritative evidence"
                        : reviewCompleteness === "well_supported"
                          ? "ready to clear / authoritative evidence present"
                          : reviewCompleteness === "supported_with_gaps"
                            ? sourceGapFactCount > 0 && openIssueCount > 0
                              ? "review now / authoritative evidence / gaps and issues remain"
                              : sourceGapFactCount > 0
                                ? "review now / authoritative evidence / source gaps remain"
                                : "review now / authoritative evidence / open issues remain"
                            : reviewCompleteness === "supporting_only"
                              ? "gather evidence / supporting evidence only"
                              : "gather evidence / thin record";
                  const clearancePath = summarizeClearancePath(
                    step?.hardGate ?? false,
                    readiness,
                    reviewCompleteness,
                    authoritativeEvidenceCount,
                    evidenceCount,
                    sourceGapFactCount,
                    openIssueCount,
                    snapshot.artifacts.some((artifact) => {
                      if (artifact.storageBackend !== "local-report" || artifact.stepKey !== stepKey) {
                        return false;
                      }
                      const metadata = parseJson<Record<string, unknown>>(artifact.metadataJson, {});
                      return metadata.reportType === "step";
                    })
                  );
                  const clearanceCondition = summarizeClearanceCondition(
                    clearancePath.label,
                    step?.hardGate ?? false,
                    readiness
                  );
                  const rerunRecommendation = summarizeRerunRecommendation(
                    summarizeFactFreshness(stepFacts).label,
                    step?.hardGate ?? false,
                    readiness,
                    reviewCompleteness
                  );
                  const bestNextClickKind =
                    snapshot.artifacts.some((artifact) => {
                      if (artifact.storageBackend !== "local-report" || artifact.stepKey !== stepKey) {
                        return false;
                      }
                      const metadata = parseJson<Record<string, unknown>>(artifact.metadataJson, {});
                      return metadata.reportType === "step";
                    })
                      ? "stage_report"
                      : authoritativeEvidenceCount > 0
                        ? "authoritative_evidence"
                        : evidenceCount > 0
                          ? "supporting_evidence"
                          : "none";
                  const reviewHandoffNote = summarizeReviewHandoffNote(
                    clearancePath.label,
                    rerunRecommendation.label,
                    bestNextClickKind,
                    step?.hardGate ?? false
                  );
                  const reviewBlockers = [
                    ...(step?.hardGate && authoritativeEvidenceCount === 0
                      ? ["missing authoritative evidence"]
                      : []),
                    ...(evidenceCount === 0 ? ["no evidence files linked"] : []),
                    ...(sourceGapFactCount > 0 ? ["source gaps remain"] : []),
                    ...(openIssueCount > 0 ? ["open issues remain"] : []),
                    ...(readiness === "adverse_evidence_present"
                      ? ["adverse evidence present"]
                      : []),
                  ];
                  return {
                    step_key: stepKey,
                    hard_gate: step?.hardGate ?? false,
                    readiness,
                    source_gap_fact_count: sourceGapFactCount,
                    open_issue_count: openIssueCount,
                    review_snapshot: reviewSnapshot,
                    clearance_condition: clearanceCondition,
                    review_handoff_note: reviewHandoffNote,
                    review_blockers: reviewBlockers,
                  };
                })
                .sort((left, right) => {
                  const priority = (item: {
                    hard_gate: boolean;
                    readiness: string;
                    source_gap_fact_count: number;
                    open_issue_count: number;
                    step_key: string;
                  }): number => {
                    const base =
                      item.readiness === "adverse_evidence_present"
                        ? 0
                        : item.readiness === "blocked_missing_official_evidence"
                          ? 1
                          : item.readiness === "awaiting_hard_gate_evidence"
                            ? 2
                            : item.readiness === "review_with_source_gaps"
                              ? 3
                              : item.readiness === "issue_only_review"
                                ? 4
                                : item.readiness === "review_ready"
                                  ? 5
                                  : 6;
                    return item.hard_gate ? base : base + 10;
                  };
                  const leftPriority = priority(left);
                  const rightPriority = priority(right);
                  if (leftPriority !== rightPriority) {
                    return leftPriority - rightPriority;
                  }
                  if (left.source_gap_fact_count !== right.source_gap_fact_count) {
                    return right.source_gap_fact_count - left.source_gap_fact_count;
                  }
                  if (left.open_issue_count !== right.open_issue_count) {
                    return right.open_issue_count - left.open_issue_count;
                  }
                  return left.step_key.localeCompare(right.step_key);
                })
                .slice(0, 2);

              return items.map((item, index) => ({
                step_key: item.step_key,
                summary: `${index === 0 ? "Primary blocker" : "Secondary blocker"}: ${item.review_snapshot}`,
                clearance_condition: item.clearance_condition,
                review_handoff_note: item.review_handoff_note,
                review_blockers: item.review_blockers,
              }));
            })(),
            decision_checklist: snapshot.reviewTasks
              .filter((task) => task.status === "open")
              .map((task) => task.stepKey)
              .filter((stepKey, index, values) => values.indexOf(stepKey) === index)
              .map((stepKey) => {
                const step = snapshot.steps.find((candidate) => candidate.stepKey === stepKey);
                const stepFacts = snapshot.facts.filter((fact) => fact.stepKey === stepKey);
                const supportedFactCount = stepFacts.filter((fact) => {
                  const evidenceArtifacts = fact.evidenceIds
                    .map((evidenceId) =>
                      snapshot.artifacts.find((artifact) => artifact.id === evidenceId) ?? null
                    )
                    .filter((artifact): artifact is NonNullable<typeof artifact> => artifact != null);
                  const hasArtifactSources = evidenceArtifacts.length > 0;
                  const hasUrlSources = /https?:\/\//i.test(fact.valueJson);
                  return hasArtifactSources || hasUrlSources;
                }).length;
                  const evidenceCount = snapshot.artifacts.filter(
                    (artifact) =>
                      artifact.stepKey === stepKey && artifact.storageBackend !== "local-report"
                  ).length;
                const topEvidence = snapshot.artifacts
                  .filter(
                    (artifact) =>
                      artifact.stepKey === stepKey &&
                      artifact.storageBackend !== "local-report"
                  )
                  .sort((left, right) => {
                    const capturePriority = (artifact: (typeof snapshot.artifacts)[number]): number => {
                      const metadata = parseJson<Record<string, unknown>>(
                        artifact.metadataJson,
                        {}
                      );
                      const captureType =
                        typeof metadata.captureType === "string"
                          ? metadata.captureType
                          : null;
                      if (captureType === "screenshot") return 0;
                      if (captureType === "pdf") return 1;
                      if (captureType === "html") return 2;
                      if (artifact.contentType === "application/pdf") return 3;
                      if (artifact.contentType.startsWith("image/")) return 4;
                      if (artifact.contentType === "text/html") return 5;
                      return 6;
                    };
                    const leftPriority = capturePriority(left);
                    const rightPriority = capturePriority(right);
                    if (leftPriority !== rightPriority) {
                      return leftPriority - rightPriority;
                    }
                    return left.title.localeCompare(right.title);
                  })
                  .slice(0, 2)
                  .map((artifact) => {
                    const metadata = parseJson<Record<string, unknown>>(
                      artifact.metadataJson,
                      {}
                    );
                    const authoritative =
                      artifact.sourceId === "official_registry" ||
                      artifact.sourceId === "public_market_listing" ||
                      artifact.sourceId === "ofac_search" ||
                      artifact.sourceId === "ofac_dataset";
                    return {
                      title: artifact.title,
                      artifact_id: artifact.id,
                      source_url:
                        artifact.sourceUrl ??
                        (typeof metadata.finalUrl === "string" ? metadata.finalUrl : null) ??
                        (typeof metadata.requestedUrl === "string"
                          ? metadata.requestedUrl
                          : null),
                      content_type: artifact.contentType,
                      authoritative,
                    };
                  });
                const authoritativeEvidenceCount = snapshot.artifacts.filter(
                  (artifact) =>
                    artifact.stepKey === stepKey &&
                    artifact.storageBackend !== "local-report" &&
                    (artifact.sourceId === "official_registry" ||
                      artifact.sourceId === "public_market_listing" ||
                      artifact.sourceId === "ofac_search" ||
                      artifact.sourceId === "ofac_dataset")
                ).length;
                const sourceGapFactCount = stepFacts.length - supportedFactCount;
                const openIssueCount = snapshot.issues.filter(
                  (issue) => issue.stepKey === stepKey && issue.status === "open"
                ).length;
                const stageReportPath =
                  Object.entries(
                    Object.fromEntries(
                      snapshot.artifacts
                        .filter((artifact) => {
                          if (artifact.storageBackend !== "local-report") {
                            return false;
                          }
                          const metadata = parseJson<Record<string, unknown>>(
                            artifact.metadataJson,
                            {}
                          );
                          return metadata.reportType === "step";
                        })
                        .map((artifact) => [
                          String(artifact.stepKey),
                          artifact.id,
                        ])
                    )
                  ).find(([candidateStepKey]) => candidateStepKey === stepKey)?.[1] ?? null;
                const bestNextClick =
                  stageReportPath != null
                    ? {
                        kind: "stage_report",
                        label: `${stepKey} stage report`,
                        artifact_id: stageReportPath,
                        source_url: null,
                        authoritative: false,
                      }
                    : topEvidence.find((artifact) => artifact.authoritative)
                      ? {
                          kind: "authoritative_evidence",
                          label:
                            topEvidence.find((artifact) => artifact.authoritative)?.title ??
                            "authoritative evidence",
                          artifact_id:
                            topEvidence.find((artifact) => artifact.authoritative)?.artifact_id ??
                            null,
                          source_url:
                            topEvidence.find((artifact) => artifact.authoritative)?.source_url ??
                            null,
                          authoritative: true,
                        }
                      : topEvidence[0]
                        ? {
                            kind: "supporting_evidence",
                            label: topEvidence[0].title,
                            artifact_id: topEvidence[0].artifact_id,
                            source_url: topEvidence[0].source_url,
                            authoritative: Boolean(topEvidence[0].authoritative),
                          }
                        : {
                            kind: "none",
                            label: "no linked file available",
                            path: null,
                            source_url: null,
                            authoritative: false,
                          };
                const readiness =
                  step?.hardGate && step?.status === "blocked"
                    ? "blocked_missing_official_evidence"
                    : step?.status === "failed"
                      ? "adverse_evidence_present"
                      : evidenceCount === 0 && (step?.hardGate ?? false)
                        ? "awaiting_hard_gate_evidence"
                        : sourceGapFactCount > 0
                          ? "review_with_source_gaps"
                          : stepFacts.length === 0 && openIssueCount > 0
                            ? "issue_only_review"
                            : "review_ready";
                const reviewCompleteness =
                  readiness === "blocked_missing_official_evidence" ||
                  readiness === "awaiting_hard_gate_evidence"
                    ? "blocked"
                    : authoritativeEvidenceCount > 0 &&
                        sourceGapFactCount === 0 &&
                        openIssueCount === 0
                      ? "well_supported"
                      : authoritativeEvidenceCount > 0
                        ? "supported_with_gaps"
                        : evidenceCount > 0
                          ? "supporting_only"
                          : "thin";
                const reviewCompletenessReason =
                  reviewCompleteness === "blocked"
                    ? evidenceCount > 0
                      ? "Supporting evidence exists, but the stage still lacks the authoritative evidence required to clear it."
                      : "No authoritative evidence is linked yet for this stage."
                    : reviewCompleteness === "well_supported"
                      ? "Authoritative evidence is linked and there are no current source gaps or open issues for this stage."
                      : reviewCompleteness === "supported_with_gaps"
                        ? sourceGapFactCount > 0 && openIssueCount > 0
                          ? "Authoritative evidence exists, but source gaps remain and the stage still has open issues."
                          : sourceGapFactCount > 0
                            ? "Authoritative evidence exists, but some findings in this stage still have source gaps."
                            : "Authoritative evidence exists, but the stage still has open issues to review."
                        : reviewCompleteness === "supporting_only"
                          ? "Only supporting evidence is linked for this stage; authoritative evidence is still missing."
                          : "This stage has little or no linked evidence yet, so the reviewer is working from a thin record.";
                const reviewSnapshot =
                  readiness === "adverse_evidence_present"
                    ? "treat as adverse / evidence attached"
                    : (step?.hardGate ?? false) && authoritativeEvidenceCount === 0
                      ? "blocked / hard gate / no authoritative evidence"
                      : reviewCompleteness === "well_supported"
                        ? "ready to clear / authoritative evidence present"
                        : reviewCompleteness === "supported_with_gaps"
                          ? sourceGapFactCount > 0 && openIssueCount > 0
                            ? "review now / authoritative evidence / gaps and issues remain"
                            : sourceGapFactCount > 0
                              ? "review now / authoritative evidence / source gaps remain"
                              : "review now / authoritative evidence / open issues remain"
                          : reviewCompleteness === "supporting_only"
                            ? "gather evidence / supporting evidence only"
                            : "gather evidence / thin record";
                const stageFreshness = summarizeFactFreshness(stepFacts);
                const rerunRecommendation = summarizeRerunRecommendation(
                  stageFreshness.label,
                  step?.hardGate ?? false,
                  readiness,
                  reviewCompleteness
                );
                const clearancePath = summarizeClearancePath(
                  step?.hardGate ?? false,
                  readiness,
                  reviewCompleteness,
                  authoritativeEvidenceCount,
                  evidenceCount,
                  sourceGapFactCount,
                  openIssueCount,
                  stageReportPath != null
                );
                const clearanceCondition = summarizeClearanceCondition(
                  clearancePath.label,
                  step?.hardGate ?? false,
                  readiness
                );
                const reviewHandoffNote = summarizeReviewHandoffNote(
                  clearancePath.label,
                  rerunRecommendation.label,
                  bestNextClick.kind as
                    | "stage_report"
                    | "authoritative_evidence"
                    | "supporting_evidence"
                    | "none",
                  step?.hardGate ?? false
                );
                const recommendedOutcome =
                  readiness === "adverse_evidence_present"
                    ? "treat_as_adverse"
                    : readiness === "blocked_missing_official_evidence" ||
                        readiness === "awaiting_hard_gate_evidence" ||
                        reviewCompleteness === "blocked" ||
                        reviewCompleteness === "supporting_only" ||
                        reviewCompleteness === "thin"
                      ? "gather_more_evidence"
                      : reviewCompleteness === "well_supported"
                        ? "ready_to_clear_if_evidence_checks_out"
                        : "review_evidence_now";
                const recommendedOutcomeReason =
                  recommendedOutcome === "treat_as_adverse"
                    ? "This stage has failed or shows adverse evidence and should not be cleared without disproving the underlying record."
                    : recommendedOutcome === "gather_more_evidence"
                      ? "The stage is not yet supported strongly enough to clear; gather the missing authoritative or supporting evidence first."
                      : recommendedOutcome === "ready_to_clear_if_evidence_checks_out"
                        ? "Coverage is strong enough that a reviewer can likely clear this stage after checking the linked evidence."
                        : "The stage has meaningful evidence attached, but the reviewer still needs to inspect it before deciding.";
                const reviewBlockers = [
                  ...(step?.hardGate && authoritativeEvidenceCount === 0
                    ? ["missing authoritative evidence"]
                    : []),
                  ...(evidenceCount === 0 ? ["no evidence files linked"] : []),
                  ...(sourceGapFactCount > 0 ? ["source gaps remain"] : []),
                  ...(openIssueCount > 0 ? ["open issues remain"] : []),
                  ...(readiness === "adverse_evidence_present"
                    ? ["adverse evidence present"]
                    : []),
                ];
                const reviewPriorityReason =
                  readiness === "adverse_evidence_present"
                    ? "Adverse evidence puts this stage at the top of the queue."
                    : step?.hardGate && readiness === "blocked_missing_official_evidence"
                      ? "This hard gate is blocked on authoritative evidence and should be reviewed first."
                      : step?.hardGate && readiness === "awaiting_hard_gate_evidence"
                        ? "This is a hard gate without enough evidence yet, so it stays near the top."
                        : sourceGapFactCount > 0
                          ? "Source gaps raise the review priority for this stage."
                          : openIssueCount > 0
                            ? "Open issues keep this stage ahead of routine review items."
                            : step?.hardGate
                              ? "This is a hard-gate stage, so it is prioritized ahead of softer review steps."
                              : "This is a routine review item after the higher-risk stages.";
                const reviewerAction =
                  step?.hardGate && step?.status === "blocked"
                    ? "Do not clear this stage yet. Add or capture the required official evidence, then re-run or resolve the review."
                    : step?.status === "failed"
                      ? "Treat this as adverse until the underlying evidence is disproven or superseded."
                      : evidenceCount === 0 && (step?.hardGate ?? false)
                        ? "This hard gate should not be cleared without linked official evidence for the stage."
                        : sourceGapFactCount > 0
                          ? "Review carefully. Some findings in this stage are missing accessible sources and should not be relied on without checking linked evidence."
                          : stepFacts.length === 0 &&
                              snapshot.issues.filter(
                                (issue) => issue.stepKey === stepKey && issue.status === "open"
                              ).length > 0
                            ? "Base the decision on the issue details and linked evidence for this stage."
                            : "Use the linked stage report and evidence to resolve the open review tasks for this stage.";
                return {
                  step_key: stepKey,
                  step_status: step?.status ?? "unknown",
                  hard_gate: step?.hardGate ?? false,
                  readiness,
                  review_snapshot: reviewSnapshot,
                  stage_freshness: stageFreshness.label,
                  stage_freshness_note: stageFreshness.note,
                  rerun_recommendation: rerunRecommendation.label,
                  rerun_recommendation_reason: rerunRecommendation.reason,
                  clearance_path: clearancePath.label,
                  clearance_path_reason: clearancePath.reason,
                  clearance_condition: clearanceCondition,
                  review_handoff_note: reviewHandoffNote,
                  review_completeness: reviewCompleteness,
                  review_completeness_reason: reviewCompletenessReason,
                  recommended_outcome: recommendedOutcome,
                  recommended_outcome_reason: recommendedOutcomeReason,
                  review_priority_reason: reviewPriorityReason,
                  review_blockers: reviewBlockers,
                  reviewer_action: reviewerAction,
                  stage_report: stageReportPath,
                  evidence_count: evidenceCount,
                  authoritative_evidence_count: authoritativeEvidenceCount,
                  best_next_click: bestNextClick,
                  top_evidence: topEvidence,
                  facts_with_sources: supportedFactCount,
                  fact_count: stepFacts.length,
                  source_gap_fact_count: sourceGapFactCount,
                  open_issue_count: openIssueCount,
                  open_review_tasks: snapshot.reviewTasks
                    .filter((task) => task.status === "open" && task.stepKey === stepKey)
                    .map((task) => ({
                      id: task.id,
                      title: task.title,
                      instructions: task.instructions,
                    })),
                };
              })
              .sort((left, right) => {
                const priority = (item: {
                  hard_gate: boolean;
                  readiness: string;
                  source_gap_fact_count: number;
                  open_issue_count: number;
                  step_key: string;
                }): number => {
                  const base =
                    item.readiness === "adverse_evidence_present"
                      ? 0
                      : item.readiness === "blocked_missing_official_evidence"
                        ? 1
                        : item.readiness === "awaiting_hard_gate_evidence"
                          ? 2
                          : item.readiness === "review_with_source_gaps"
                            ? 3
                            : item.readiness === "issue_only_review"
                              ? 4
                              : item.readiness === "review_ready"
                                ? 5
                                : 6;
                  return item.hard_gate ? base : base + 10;
                };
                const leftPriority = priority(left);
                const rightPriority = priority(right);
                if (leftPriority !== rightPriority) {
                  return leftPriority - rightPriority;
                }
                if (left.source_gap_fact_count !== right.source_gap_fact_count) {
                  return right.source_gap_fact_count - left.source_gap_fact_count;
                }
                if (left.open_issue_count !== right.open_issue_count) {
                  return right.open_issue_count - left.open_issue_count;
                }
                return left.step_key.localeCompare(right.step_key);
              }),
            open_review_tasks: snapshot.reviewTasks.filter(
              (task) => task.status === "open"
            ),
          };
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
  };
}

/** @deprecated Use getToolDefinitions + createToolRunner instead. Kept for backward compatibility. */
export function createToolRuntime(runtime: PolicyBotRuntime): {
  tools: Tool[];
  runTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
} {
  const fallbackContext: ToolContext = {
    threadCaseId: null,
    channelId: "",
    threadTs: "",
    actorId: null,
    reviewerUserIds: null,
  };
  return {
    tools: getToolDefinitions(),
    runTool: createToolRunner(runtime, fallbackContext),
  };
}

function requireReviewerAccess(context: ToolContext): void {
  if (!context.reviewerUserIds) {
    return;
  }

  if (!context.actorId || !context.reviewerUserIds.includes(context.actorId)) {
    throw new Error(
      "Only designated reviewers can resolve review tasks and finalize cases. Contact a reviewer to complete this action."
    );
  }
}

function resolveCase(
  inputCaseId: unknown,
  context: ToolContext
): string {
  const explicit = typeof inputCaseId === "string" && inputCaseId.trim() !== ""
    ? inputCaseId.trim()
    : null;
  const resolved = explicit ?? context.threadCaseId;
  if (!resolved) {
    throw new Error(
      "No case ID provided and this thread is not linked to a case. Please specify a case_id or create a case first."
    );
  }

  return resolved;
}

function readCounterpartyKind(value: unknown): CreateCaseInput["counterpartyKind"] {
  if (value === "entity" || value === "individual") {
    return value;
  }

  throw new Error("counterparty_kind must be 'entity' or 'individual'");
}

function readReviewOutcome(value: unknown): ReviewOutcome {
  if (value === "clear" || value === "concern" || value === "reject") {
    return value;
  }

  throw new Error("outcome must be 'clear', 'concern', or 'reject'");
}

function readStepKey(value: unknown): WorkflowStepKey {
  const valid = [
    "public_market_shortcut",
    "entity_resolution",
    "good_standing",
    "reputation_search",
    "bbb_review",
    "ofac_precheck",
    "ofac_search",
  ];
  if (typeof value === "string" && valid.includes(value)) {
    return value as WorkflowStepKey;
  }

  throw new Error(`step_key must be one of: ${valid.join(", ")}`);
}

function readFinalizationRecommendation(
  value: unknown
): "approved" | "terminate" {
  if (value === "approved" || value === "terminate") {
    return value;
  }

  throw new Error("recommendation must be 'approved' or 'terminate'");
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function readOptionalString(
  value: unknown,
  fieldName: string
): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function readPositiveInteger(
  value: unknown,
  fallback: number,
  max: number,
  fieldName: string
): number {
  if (value == null) {
    return fallback;
  }

  const parsed =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a number`);
  }

  return Math.min(Math.max(Math.floor(parsed), 1), max);
}
