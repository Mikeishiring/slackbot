import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import type {
  CounterpartyKind,
  PolicyBundle,
  PolicySourceConfig,
  PolicyStepConfig,
  WorkflowStepKey,
} from "./types.js";
import { normalizeName } from "./utils.js";

interface DecisionMatrixFile {
  version?: unknown;
  decision_matrix_version?: unknown;
  top_exchanges?: unknown;
  steps?: unknown;
}

interface SourceRegistryFile {
  version?: unknown;
  sources?: unknown;
}

export function loadPolicyBundle(policyDirectory: string): PolicyBundle {
  const decisionMatrixPath = resolve(policyDirectory, "decision-matrix.yml");
  const sourceRegistryPath = resolve(policyDirectory, "source-registry.yml");

  const decisionMatrix = parseYaml(
    readFileSync(decisionMatrixPath, "utf8")
  ) as DecisionMatrixFile;
  const sourceRegistry = parseYaml(
    readFileSync(sourceRegistryPath, "utf8")
  ) as SourceRegistryFile;

  const version = requireString(decisionMatrix.version, "decision-matrix.version");
  const decisionMatrixVersion = requireString(
    decisionMatrix.decision_matrix_version,
    "decision-matrix.decision_matrix_version"
  );

  return {
    version,
    decisionMatrixVersion,
    topExchanges: requireStringArray(
      decisionMatrix.top_exchanges,
      "decision-matrix.top_exchanges"
    ),
    steps: requirePolicySteps(decisionMatrix.steps),
    sources: requirePolicySources(sourceRegistry.sources),
  };
}

export function getApplicableSteps(
  bundle: PolicyBundle,
  kind: CounterpartyKind
): PolicyStepConfig[] {
  return bundle.steps
    .filter((step) => step.appliesTo.includes(kind))
    .sort((left, right) => left.order - right.order);
}

export function getPolicyStep(
  bundle: PolicyBundle,
  stepKey: WorkflowStepKey
): PolicyStepConfig {
  const step = bundle.steps.find((candidate) => candidate.key === stepKey);
  if (!step) {
    throw new Error(`Unknown policy step: ${stepKey}`);
  }

  return step;
}

export function isTopExchange(bundle: PolicyBundle, exchangeName: string): boolean {
  const normalized = normalizeName(exchangeName);
  return bundle.topExchanges.some(
    (candidate) => normalizeName(candidate) === normalized
  );
}

export function fillSourceTemplate(
  bundle: PolicyBundle,
  sourceId: string,
  replacements: Record<string, string>
): string {
  const source = bundle.sources.find((candidate) => candidate.id === sourceId);
  if (!source) {
    throw new Error(`Unknown source template: ${sourceId}`);
  }

  return Object.entries(replacements).reduce(
    (output, [key, value]) =>
      output.replaceAll(`{${key}}`, encodeURIComponent(value)),
    source.urlTemplate
  );
}

function requirePolicySteps(value: unknown): PolicyStepConfig[] {
  if (!Array.isArray(value)) {
    throw new Error("decision-matrix.steps must be an array");
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`decision-matrix.steps[${index}] must be an object`);
    }

    return {
      key: requireWorkflowStepKey(item.key, `decision-matrix.steps[${index}].key`),
      order: requireNumber(item.order, `decision-matrix.steps[${index}].order`),
      hardGate: requireBoolean(
        item.hard_gate,
        `decision-matrix.steps[${index}].hard_gate`
      ),
      appliesTo: requireCounterpartyKinds(
        item.applies_to,
        `decision-matrix.steps[${index}].applies_to`
      ),
      description: requireString(
        item.description,
        `decision-matrix.steps[${index}].description`
      ),
      evidenceRequirements: requireStringArray(
        item.evidence_requirements,
        `decision-matrix.steps[${index}].evidence_requirements`
      ),
      manualReviewAllowed: requireBoolean(
        item.manual_review_allowed,
        `decision-matrix.steps[${index}].manual_review_allowed`
      ),
    };
  });
}

function requirePolicySources(value: unknown): PolicySourceConfig[] {
  if (!Array.isArray(value)) {
    throw new Error("source-registry.sources must be an array");
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`source-registry.sources[${index}] must be an object`);
    }

    const trustTier = requireString(
      item.trust_tier,
      `source-registry.sources[${index}].trust_tier`
    );
    if (trustTier !== "A" && trustTier !== "B" && trustTier !== "C") {
      throw new Error(
        `source-registry.sources[${index}].trust_tier must be A, B, or C`
      );
    }

    return {
      id: requireString(item.id, `source-registry.sources[${index}].id`),
      label: requireString(item.label, `source-registry.sources[${index}].label`),
      sourceType: requireString(
        item.source_type,
        `source-registry.sources[${index}].source_type`
      ),
      trustTier,
      connector: requireString(
        item.connector,
        `source-registry.sources[${index}].connector`
      ),
      urlTemplate: requireString(
        item.url_template,
        `source-registry.sources[${index}].url_template`
      ),
      notes: requireString(item.notes, `source-registry.sources[${index}].notes`),
    };
  });
}

function requireWorkflowStepKey(value: unknown, field: string): WorkflowStepKey {
  const key = requireString(value, field);
  if (
    key !== "public_market_shortcut" &&
    key !== "entity_resolution" &&
    key !== "good_standing" &&
    key !== "reputation_search" &&
    key !== "bbb_review" &&
    key !== "ofac_precheck" &&
    key !== "ofac_search"
  ) {
    throw new Error(`${field} is not a supported workflow step`);
  }

  return key;
}

function requireCounterpartyKinds(
  value: unknown,
  field: string
): CounterpartyKind[] {
  const values = requireStringArray(value, field);
  return values.map((candidate, index) => {
    if (candidate !== "entity" && candidate !== "individual") {
      throw new Error(`${field}[${index}] must be 'entity' or 'individual'`);
    }

    return candidate;
  });
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be a string array`);
  }

  return value.map((item) => item.trim()).filter(Boolean);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }

  return value.trim();
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number`);
  }

  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
