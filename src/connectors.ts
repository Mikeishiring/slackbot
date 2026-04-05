import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { chromium } from "playwright";

import type {
  ArtifactStore,
  CaptureResult,
  CaptureService,
} from "./artifacts.js";
import { fillSourceTemplate, isTopExchange } from "./policy.js";
import type { PolicyBotStorage } from "./storage.js";
import type {
  ArtifactRecord,
  CaseSnapshot,
  NewFactInput,
  NewIssueInput,
  NewReviewTaskInput,
  PolicyBundle,
  StepExecutionResult,
  UpdateCaseScreeningInput,
  WorkflowStepKey,
} from "./types.js";
import {
  addDays,
  ensureDirectory,
  normalizeName,
  parseJson,
  sha256,
  slugify,
  uniqueStrings,
} from "./utils.js";

export interface ConnectorContext {
  snapshot: CaseSnapshot;
  policy: PolicyBundle;
  storage: PolicyBotStorage;
  artifactStore: ArtifactStore;
  captureService: CaptureService | null;
  webSearchClient: WebSearchClient | null;
}

export interface StepConnector {
  readonly stepKey: WorkflowStepKey;
  execute(context: ConnectorContext): Promise<StepExecutionResult>;
}

const ADVERSE_KEYWORDS = [
  "scam",
  "fraud",
  "sued",
  "lawsuit",
  "investigation",
  "complaint",
  "complaints",
  "penalty",
  "fine",
  "sanction",
  "ripoff",
] as const;

type OfacDatasetSnapshot = {
  names: string[];
  sourceUrl: string;
  fetchedAt: string;
};

export interface OfacDatasetClient {
  loadCurrentDataset(): Promise<OfacDatasetSnapshot>;
}

export interface WebSearchResult {
  title: string;
  link: string;
  snippet: string;
}

export interface WebSearchClient {
  search(query: string, start: number): Promise<WebSearchResult[]>;
}

export class BraveSearchClient implements WebSearchClient {
  public constructor(private readonly apiKey: string) {}

  public async search(query: string, start: number): Promise<WebSearchResult[]> {
    const params = new URLSearchParams({
      q: query,
      offset: String(start),
      count: "10",
    });
    const url = `https://api.search.brave.com/res/v1/web/search?${params}`;
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Brave Search API returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };

    return (body.web?.results ?? []).map((item) => ({
      title: item.title ?? "",
      link: item.url ?? "",
      snippet: item.description ?? "",
    }));
  }
}

export class GoogleCustomSearchClient implements WebSearchClient {
  public constructor(
    private readonly apiKey: string,
    private readonly searchEngineId: string
  ) {}

  public async search(query: string, start: number): Promise<WebSearchResult[]> {
    const params = new URLSearchParams({
      key: this.apiKey,
      cx: this.searchEngineId,
      q: query,
      start: String(start + 1),
      num: "10",
    });
    const url = `https://www.googleapis.com/customsearch/v1?${params}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Google Custom Search API returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      items?: Array<{ title?: string; link?: string; snippet?: string }>;
    };

    return (body.items ?? []).map((item) => ({
      title: item.title ?? "",
      link: item.link ?? "",
      snippet: item.snippet ?? "",
    }));
  }
}

interface EntityResolutionOutcome {
  status: "passed" | "blocked";
  registryUrl: string | null;
  facts: NewFactInput[];
  issues: NewIssueInput[];
  reviewTasks: NewReviewTaskInput[];
  evidenceIds: string[];
  note: string | null;
  casePatch: UpdateCaseScreeningInput;
}

interface EntityEvidenceCandidate {
  url: string;
  title: string;
  sourceId: string | null;
  curatedPatch?: UpdateCaseScreeningInput;
  curatedRationale?: string[];
}

interface OfficialRegistrySuggestion {
  label: string;
  url: string;
  notes: string;
  exactEntityName?: string;
  fileNumber?: string;
  purpose?: "locate_entity" | "verify_status" | "obtain_certificate" | "access_support";
  authorityUrl?: string | null;
  requiresRegistration?: boolean;
  requiresPayment?: boolean;
}

interface KnownEntityStructureEntity {
  legalName: string;
  jurisdiction: string;
  role: string;
  registrySearchUrl?: string | null;
  exactEntityName?: string | null;
  fileNumber?: string | null;
  sourceUrls?: string[];
  notes?: string[];
}

interface KnownEntityStructure {
  brand: string;
  scopeNote: string;
  entities: KnownEntityStructureEntity[];
}

interface KnownEntitySourceHint {
  names: string[];
  websiteHosts?: string[];
  evidenceCandidates: EntityEvidenceCandidate[];
  registrySuggestions?: OfficialRegistrySuggestion[];
  entityStructure?: KnownEntityStructure;
}

export interface EntityEvidenceLoaderConfig {
  cacheDirectory?: string | null;
  cacheTtlMs?: number;
  browserAttempts?: number;
  browserWaitMs?: number;
  loadTimeoutMs?: number;
}

interface CachedEntityEvidencePage {
  html: string;
  finalUrl: string;
  loadMode: "http_fetch" | "browser";
  fetchedAt: string;
}

interface LoadedEntityEvidencePage {
  html: string;
  finalUrl: string;
  loadMode: "http_fetch" | "browser" | "cache";
}

interface SearchHitSummary {
  title: string;
  url: string;
  domain: string | null;
  snippet: string | null;
  adverseKeywords: string[];
}

interface ReputationSearchPageSummary {
  query: string;
  pageNumber: number;
  url: string;
  extractedResultCount: number;
  likelyAdverseCount: number;
  extractionSource: "captured_html" | "live_fetch" | "none";
  fetchError: string | null;
  captureError: string | null;
  structureStatus: "ok" | "challenge" | "layout_changed" | "thin_content";
  structureSignals: string[];
  results: SearchHitSummary[];
}

interface BbbSearchSummary {
  rating: string | null;
  reviewCount: number | null;
  complaintCount: number | null;
  flaggedKeywords: string[];
  fetchError: string | null;
  extractionSource: "captured_html" | "live_fetch" | "none";
  structureStatus: "ok" | "challenge" | "layout_changed" | "thin_content";
  structureSignals: string[];
}

interface ExternalPageDiagnostics {
  structureStatus: "ok" | "challenge" | "layout_changed" | "thin_content";
  structureSignals: string[];
}

interface ReusableFreshStepFact {
  priorSnapshot: CaseSnapshot;
  fact: ArtifactCompatibleFactRecord;
}

type ArtifactCompatibleFactRecord = CaseSnapshot["facts"][number];

class EntityEvidenceLoader {
  private readonly memoryCache = new Map<string, CachedEntityEvidencePage>();
  private readonly cacheDirectory: string | null;
  private readonly cacheTtlMs: number;
  private readonly browserAttempts: number;
  private readonly browserWaitMs: number;
  private readonly loadTimeoutMs: number;

  public constructor(config: EntityEvidenceLoaderConfig = {}) {
    this.cacheDirectory = config.cacheDirectory ?? null;
    this.cacheTtlMs = config.cacheTtlMs ?? 24 * 60 * 60 * 1000;
    this.browserAttempts = config.browserAttempts ?? 3;
    this.browserWaitMs = config.browserWaitMs ?? 4_000;
    this.loadTimeoutMs = config.loadTimeoutMs ?? 20_000;
  }

  public async load(url: string): Promise<LoadedEntityEvidencePage | null> {
    const memoryHit = this.memoryCache.get(url);
    if (memoryHit && !isExpired(memoryHit.fetchedAt, this.cacheTtlMs)) {
      return {
        html: memoryHit.html,
        finalUrl: memoryHit.finalUrl,
        loadMode: "cache",
      };
    }

    const diskHit = await this.readDiskCache(url);
    if (diskHit && !isExpired(diskHit.fetchedAt, this.cacheTtlMs)) {
      this.memoryCache.set(url, diskHit);
      return {
        html: diskHit.html,
        finalUrl: diskHit.finalUrl,
        loadMode: "cache",
      };
    }

    const loaded = await promiseWithTimeout(
      loadEntityEvidencePageLive(url, this.browserAttempts, this.browserWaitMs),
      this.loadTimeoutMs
    ).catch(() => null);
    if (!loaded) {
      return null;
    }

    const cached: CachedEntityEvidencePage = {
      html: loaded.html,
      finalUrl: loaded.finalUrl,
      loadMode: loaded.loadMode,
      fetchedAt: new Date().toISOString(),
    };
    this.memoryCache.set(url, cached);
    await this.writeDiskCache(url, cached);

    return loaded;
  }

  private async readDiskCache(url: string): Promise<CachedEntityEvidencePage | null> {
    const cachePath = this.resolveCachePath(url);
    if (!cachePath) {
      return null;
    }

    try {
      const body = await readFile(cachePath, "utf8");
      const parsed = JSON.parse(body) as Partial<CachedEntityEvidencePage>;
      if (
        typeof parsed.html === "string" &&
        typeof parsed.finalUrl === "string" &&
        typeof parsed.fetchedAt === "string" &&
        (parsed.loadMode === "http_fetch" || parsed.loadMode === "browser")
      ) {
        return {
          html: parsed.html,
          finalUrl: parsed.finalUrl,
          loadMode: parsed.loadMode,
          fetchedAt: parsed.fetchedAt,
        };
      }
    } catch {
      return null;
    }

    return null;
  }

  private async writeDiskCache(
    url: string,
    cached: CachedEntityEvidencePage
  ): Promise<void> {
    const cachePath = this.resolveCachePath(url);
    if (!cachePath) {
      return;
    }

    await ensureDirectory(dirname(cachePath));
    await writeFile(cachePath, JSON.stringify(cached, null, 2), "utf8");
  }

  private resolveCachePath(url: string): string | null {
    if (!this.cacheDirectory) {
      return null;
    }

    return `${this.cacheDirectory}/${sha256(url)}.json`;
  }
}

export class PublicMarketShortcutConnector implements StepConnector {
  public readonly stepKey = "public_market_shortcut" as const;

  public async execute(context: ConnectorContext): Promise<StepExecutionResult> {
    const { caseRecord } = context.snapshot;
    if (caseRecord.counterpartyKind !== "entity") {
      return skipped("Public-market shortcut does not apply to individuals.");
    }

    if (!caseRecord.publicListingUrl || !caseRecord.exchangeName) {
      return skipped("No public listing evidence supplied; continuing with full screening.");
    }

    if (!isTopExchange(context.policy, caseRecord.exchangeName)) {
      return skipped("Exchange is not on the top-exchange shortcut list.");
    }

    const artifactIds = await captureOptional(
      context,
      caseRecord.publicListingUrl,
      "Public Market Listing",
      "public_market_listing"
    );

    if (artifactIds.error || artifactIds.artifactIds.length === 0) {
      return {
        status: "manual_review_required",
        note: "Public listing URL supplied, but automatic evidence capture did not complete.",
        facts: [],
        issues: artifactIds.error
          ? [
              {
                stepKey: this.stepKey,
                severity: "medium",
                title: "Public-market listing capture failed",
                detail: artifactIds.error,
                evidenceIds: [],
              },
            ]
          : [],
        reviewTasks: [
          {
            stepKey: this.stepKey,
            title: "Review public-market shortcut evidence",
            instructions:
              "Confirm the listing page shows the counterparty on a top-ten exchange, capture evidence manually if needed, and then resolve the review task.",
          },
        ],
      };
    }

    return {
      status: "passed",
      note: `Top-exchange public listing captured via ${artifactIds.captureMode ?? "capture"}.`,
      facts: [
        {
          stepKey: this.stepKey,
          factKey: "public_market_shortcut",
          summary: `${caseRecord.displayName} appears listed on ${caseRecord.exchangeName}.`,
          value: {
            exchangeName: caseRecord.exchangeName,
            stockSymbol: caseRecord.stockSymbol,
            publicListingUrl: caseRecord.publicListingUrl,
            captureMode: artifactIds.captureMode,
          },
          verificationStatus: "verified",
          sourceId: "public_market_listing",
          evidenceIds: artifactIds.artifactIds,
          freshnessExpiresAt: addDays(new Date().toISOString(), 30),
        },
      ],
      issues: [],
      reviewTasks: [],
    };
  }
}

export class EntityResolutionConnector implements StepConnector {
  public readonly stepKey = "entity_resolution" as const;

  public constructor(
    private readonly entityEvidenceLoader: EntityEvidenceLoader = new EntityEvidenceLoader()
  ) {}

  public async execute(context: ConnectorContext): Promise<StepExecutionResult> {
    const { caseRecord } = context.snapshot;
    if (caseRecord.counterpartyKind !== "entity") {
      return skipped("Entity resolution does not apply to individuals.");
    }

    if (isPublicShortcutPassed(context.snapshot)) {
      return skipped("Public-market shortcut satisfied; no further screening required.");
    }

    const knownEntityStructure = await buildKnownEntityStructureOutputs(context, caseRecord);

    const directRegistryUrl = caseRecord.registrySearchUrl?.trim() ?? "";
    if (directRegistryUrl) {
      return {
        status: "passed",
        note: "Official registry result URL is already available.",
        facts: [
          {
            stepKey: this.stepKey,
            factKey: "official_registry_url_available",
            summary: "An official registry result URL is available for the case.",
            value: {
              registrySearchUrl: directRegistryUrl,
            },
            verificationStatus: "verified",
            sourceId: "official_registry",
            evidenceIds: [],
            freshnessExpiresAt: addDays(new Date().toISOString(), 30),
          },
          ...knownEntityStructure.facts,
        ],
        issues: knownEntityStructure.issues,
        reviewTasks: knownEntityStructure.reviewTasks,
      };
    }

    let resolvedCaseRecord = caseRecord;
    const reusedFacts: NewFactInput[] = [];
    const reusedIssues: NewIssueInput[] = [];

    const priorCase = context.storage.findLatestProfileCaseWithRegistryUrl(
      context.snapshot.profile.id,
      caseRecord.id
    );
    if (priorCase?.registrySearchUrl) {
      const reuseArtifact = await context.artifactStore.saveArtifact({
        caseId: caseRecord.id,
        stepKey: this.stepKey,
        title: "Registry URL Reuse Summary",
        sourceId: "profile_reuse",
        sourceUrl: priorCase.registrySearchUrl,
        fileName: "registry-url-reuse.md",
        contentType: "text/markdown",
        body: [
          "# Registry URL Reuse",
          "",
          `- Prior case: ${priorCase.id}`,
          `- Prior display name: ${priorCase.displayName}`,
          `- Reused registry URL: ${priorCase.registrySearchUrl}`,
        ].join("\n"),
        category: "evidence",
        metadata: {
          priorCaseId: priorCase.id,
          registrySearchUrl: priorCase.registrySearchUrl,
        },
      });
      const casePatch: UpdateCaseScreeningInput = {
        legalName: caseRecord.legalName ?? priorCase.legalName,
        incorporationCountry:
          caseRecord.incorporationCountry ?? priorCase.incorporationCountry,
        incorporationState:
          caseRecord.incorporationState ?? priorCase.incorporationState,
        website: caseRecord.website ?? priorCase.website,
        registrySearchUrl: priorCase.registrySearchUrl,
      };
      context.storage.updateCaseScreeningFields(caseRecord.id, casePatch);
      return {
        status: "passed",
        note: `Reused official registry URL from prior case ${priorCase.id}.`,
        facts: [
          {
            stepKey: this.stepKey,
            factKey: "official_registry_url_reused",
            summary: "Reused an official registry URL from a prior case for the same profile.",
            value: {
              priorCaseId: priorCase.id,
              registrySearchUrl: priorCase.registrySearchUrl,
            },
            verificationStatus: "verified",
            sourceId: "profile_reuse",
            evidenceIds: [reuseArtifact.id],
            freshnessExpiresAt: addDays(new Date().toISOString(), 30),
          },
          ...knownEntityStructure.facts,
        ],
        issues: knownEntityStructure.issues,
        reviewTasks: knownEntityStructure.reviewTasks,
      };
    }

    const priorResolvedCase = context.storage.findLatestProfileCaseWithResolvedEntity(
      context.snapshot.profile.id,
      resolvedCaseRecord.id
    );
    if (priorResolvedCase) {
      const casePatch = limitPatchToMissingEntityFields(resolvedCaseRecord, {
        legalName: priorResolvedCase.legalName,
        incorporationCountry: priorResolvedCase.incorporationCountry,
        incorporationState: priorResolvedCase.incorporationState,
        website: priorResolvedCase.website,
      });
      if (Object.keys(casePatch).length > 0) {
        const reuseArtifact = await context.artifactStore.saveArtifact({
          caseId: resolvedCaseRecord.id,
          stepKey: this.stepKey,
          title: "Resolved Entity Reuse Summary",
          sourceId: "profile_reuse",
          sourceUrl: priorResolvedCase.website,
          fileName: "resolved-entity-reuse.md",
          contentType: "text/markdown",
          body: [
            "# Resolved Entity Reuse",
            "",
            `- Prior case: ${priorResolvedCase.id}`,
            `- Prior display name: ${priorResolvedCase.displayName}`,
            `- Reused legal name: ${priorResolvedCase.legalName ?? "None"}`,
            `- Reused incorporation country: ${priorResolvedCase.incorporationCountry ?? "None"}`,
            `- Reused incorporation state: ${priorResolvedCase.incorporationState ?? "None"}`,
            `- Reused website: ${priorResolvedCase.website ?? "None"}`,
          ].join("\n"),
          category: "evidence",
          metadata: {
            priorCaseId: priorResolvedCase.id,
            reusedFields: casePatch,
          },
        });
        context.storage.updateCaseScreeningFields(resolvedCaseRecord.id, casePatch);
        resolvedCaseRecord = applyCasePatch(resolvedCaseRecord, casePatch);
        reusedFacts.push({
          stepKey: this.stepKey,
          factKey: "entity_identity_reused",
          summary:
            "Reused resolved entity identity fields from a prior case for the same profile.",
          value: {
            priorCaseId: priorResolvedCase.id,
            reusedFields: casePatch,
          },
          verificationStatus: "inferred",
          sourceId: "profile_reuse",
          evidenceIds: [reuseArtifact.id],
          freshnessExpiresAt: addDays(new Date().toISOString(), 30),
        });
      }
    }

    const websiteInference = await inferEntityDetailsFromWebsite(
      context,
      resolvedCaseRecord,
      this.entityEvidenceLoader
    );
    if (Object.keys(websiteInference.casePatch).length > 0) {
      context.storage.updateCaseScreeningFields(
        resolvedCaseRecord.id,
        websiteInference.casePatch
      );
      resolvedCaseRecord = applyCasePatch(
        resolvedCaseRecord,
        websiteInference.casePatch
      );
    }

    const genericRegistryRouting = await buildEntityResolutionRouting(
      context,
      resolvedCaseRecord
    );

    const exactOfficialMatch = await tryResolveCompaniesHouseRegistryUrl(
      context,
      resolvedCaseRecord
    );
    if (exactOfficialMatch) {
      if (Object.keys(exactOfficialMatch.casePatch).length > 0) {
        context.storage.updateCaseScreeningFields(
          resolvedCaseRecord.id,
          exactOfficialMatch.casePatch
        );
      }
      return {
        status: exactOfficialMatch.status,
        note: exactOfficialMatch.note,
        facts: [
          ...reusedFacts,
          ...websiteInference.facts,
          ...knownEntityStructure.facts,
          ...exactOfficialMatch.facts,
        ],
        issues: [
          ...reusedIssues,
          ...websiteInference.issues,
          ...knownEntityStructure.issues,
          ...exactOfficialMatch.issues,
        ],
        reviewTasks: [...knownEntityStructure.reviewTasks, ...exactOfficialMatch.reviewTasks],
      };
    }

    if (genericRegistryRouting) {
      if (Object.keys(genericRegistryRouting.casePatch).length > 0) {
        context.storage.updateCaseScreeningFields(
          resolvedCaseRecord.id,
          genericRegistryRouting.casePatch
        );
      }
      return {
        status: genericRegistryRouting.status,
        note: genericRegistryRouting.note,
        facts: [
          ...reusedFacts,
          ...websiteInference.facts,
          ...knownEntityStructure.facts,
          ...genericRegistryRouting.facts,
        ],
        issues: [
          ...reusedIssues,
          ...websiteInference.issues,
          ...knownEntityStructure.issues,
          ...genericRegistryRouting.issues,
        ],
        reviewTasks: [...knownEntityStructure.reviewTasks, ...genericRegistryRouting.reviewTasks],
      };
    }

    const blocker = await buildEntityResolutionBlocker(context, resolvedCaseRecord);
    if (Object.keys(blocker.casePatch).length > 0) {
      context.storage.updateCaseScreeningFields(resolvedCaseRecord.id, blocker.casePatch);
    }
    return {
      status: blocker.status,
      note: blocker.note,
      facts: [
        ...reusedFacts,
        ...websiteInference.facts,
        ...knownEntityStructure.facts,
        ...blocker.facts,
      ],
      issues: [
        ...reusedIssues,
        ...websiteInference.issues,
        ...knownEntityStructure.issues,
        ...blocker.issues,
      ],
      reviewTasks: [...knownEntityStructure.reviewTasks, ...blocker.reviewTasks],
    };
  }
}

export class GoodStandingConnector implements StepConnector {
  public readonly stepKey = "good_standing" as const;

  public async execute(context: ConnectorContext): Promise<StepExecutionResult> {
    const { caseRecord } = context.snapshot;
    if (caseRecord.counterpartyKind !== "entity") {
      return skipped("Good-standing verification does not apply to individuals.");
    }

    if (isPublicShortcutPassed(context.snapshot)) {
      return skipped("Public-market shortcut satisfied; no further screening required.");
    }

    const reusableFact = findReusableFreshStepFact(
      context.snapshot,
      context.storage,
      this.stepKey,
      "good_standing_status"
    );
    if (reusableFact) {
      const reusedValue = parseJson<Record<string, unknown>>(
        reusableFact.fact.valueJson,
        {}
      );
      const reusedRegistryUrl =
        readObjectString(reusedValue, "registrySearchUrl") ??
        reusableFact.priorSnapshot.caseRecord.registrySearchUrl;
      if (!caseRecord.registrySearchUrl && reusedRegistryUrl) {
        context.storage.updateCaseScreeningFields(caseRecord.id, {
          registrySearchUrl: reusedRegistryUrl,
        });
      }
      const reuseArtifact = await context.artifactStore.saveArtifact({
        caseId: caseRecord.id,
        stepKey: this.stepKey,
        title: "Good Standing Reuse Summary",
        sourceId: "official_registry",
        sourceUrl: reusedRegistryUrl,
        fileName: "good-standing-reuse.md",
        contentType: "text/markdown",
        body: [
          "# Good Standing Reuse",
          "",
          `- Prior case: ${reusableFact.priorSnapshot.caseRecord.id}`,
          `- Prior counterparty: ${reusableFact.priorSnapshot.caseRecord.displayName}`,
          `- Reused fact summary: ${reusableFact.fact.summary}`,
          `- Reused registry URL: ${reusedRegistryUrl ?? "None"}`,
          `- Fresh until: ${reusableFact.fact.freshnessExpiresAt ?? "None"}`,
        ].join("\n"),
        category: "evidence",
        metadata: {
          priorCaseId: reusableFact.priorSnapshot.caseRecord.id,
          reusedFactId: reusableFact.fact.id,
          reusedRegistryUrl,
          freshnessExpiresAt: reusableFact.fact.freshnessExpiresAt,
        },
      });

      return {
        status: "passed",
        note: `Reused fresh official good-standing evidence from prior case ${reusableFact.priorSnapshot.caseRecord.id}.`,
        facts: [
          {
            stepKey: this.stepKey,
            factKey: "good_standing_status",
            summary: `Reused fresh good-standing verification from prior case ${reusableFact.priorSnapshot.caseRecord.id}.`,
            value: {
              ...reusedValue,
              reusedFromCaseId: reusableFact.priorSnapshot.caseRecord.id,
              registrySearchUrl: reusedRegistryUrl,
            },
            verificationStatus: "verified",
            sourceId: "official_registry",
            evidenceIds: [reuseArtifact.id],
            freshnessExpiresAt: reusableFact.fact.freshnessExpiresAt,
          },
        ],
        issues: [],
        reviewTasks: [],
      };
    }

    const registryUrl = context.snapshot.caseRecord.registrySearchUrl?.trim() ?? "";
    const manualRouting = getManualRegistryRouting(context.snapshot);
    if (manualRouting) {
      return {
        status: "manual_review_required",
        note: manualRouting.note,
        facts: [
          {
            stepKey: this.stepKey,
            factKey: "good_standing_status",
            summary: manualRouting.summary,
            value: {
              registrySearchUrl: manualRouting.registryUrl,
              routingMode: manualRouting.routingMode,
              jurisdiction: manualRouting.jurisdiction,
            },
            verificationStatus: "unverified",
            sourceId: "official_registry",
            evidenceIds: manualRouting.evidenceIds,
            freshnessExpiresAt: null,
          },
        ],
        issues: [
          {
            stepKey: this.stepKey,
            severity: "high",
            title: "Good standing requires manual registry completion",
            detail: manualRouting.issueDetail,
            evidenceIds: manualRouting.evidenceIds,
          },
        ],
        reviewTasks: [
          {
            stepKey: this.stepKey,
            title: "Complete official registry good-standing check",
            instructions: manualRouting.instructions,
          },
        ],
      };
    }

    if (!registryUrl) {
      return {
        status: "blocked",
        note: "Good-standing verification is blocked until entity resolution provides an official registry result URL.",
        facts: [],
        issues: [
          {
            stepKey: this.stepKey,
            severity: "high",
            title: "Good standing is blocked pending entity resolution",
            detail:
              "No official registry result URL is available yet. Complete entity resolution or update the case input with the official registry result URL.",
            evidenceIds: [],
          },
        ],
        reviewTasks: [],
      };
    }

    let pageText: string;
    try {
      const response = await fetch(registryUrl, {
        headers: { "User-Agent": "PolicyBot/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(`Registry fetch failed with HTTP ${response.status}`);
      }

      pageText = await response.text();
    } catch (error) {
      return {
        status: "manual_review_required",
        note: "Registry fetch failed and needs manual fallback.",
        facts: [],
        issues: [
          {
            stepKey: this.stepKey,
            severity: "high",
            title: "Registry fetch failed",
            detail:
              error instanceof Error
                ? error.message
                : "Registry fetch failed.",
            evidenceIds: [],
          },
        ],
        reviewTasks: [
          {
            stepKey: this.stepKey,
            title: "Review official registry manually",
            instructions:
              "Open the official registry result URL manually, confirm whether the entity is active or in good standing, capture the page, and resolve this task with notes.",
          },
        ],
      };
    }

    const textArtifact = await context.artifactStore.saveArtifact({
      caseId: caseRecord.id,
      stepKey: this.stepKey,
      title: "Registry Result HTML",
      sourceId: "official_registry",
      sourceUrl: registryUrl,
      fileName: "registry-result.html",
      contentType: "text/html",
      body: pageText,
      category: "evidence",
      metadata: {
        sourceUrl: registryUrl,
      },
    });

    const capture = await captureOptional(
      context,
      registryUrl,
      "Registry Result",
      "official_registry"
    );
    const evidenceIds = [textArtifact.id, ...capture.artifactIds];
    const statusEvidence = findGoodStandingIndicator(pageText);

    if (statusEvidence.negativeMatch) {
      return {
        status: "failed",
        note: `Registry page showed negative status indicator: ${statusEvidence.negativeMatch}.`,
        facts: [
          {
            stepKey: this.stepKey,
            factKey: "good_standing_status",
            summary: `Registry page showed negative status indicator: ${statusEvidence.negativeMatch}.`,
            value: {
              registrySearchUrl: registryUrl,
              negativeMatch: statusEvidence.negativeMatch,
            },
            verificationStatus: "verified",
            sourceId: "official_registry",
            evidenceIds,
            freshnessExpiresAt: null,
          },
        ],
        issues: [
          {
            stepKey: this.stepKey,
            severity: "high",
            title: "Good standing not verified",
            detail: `The official registry page indicated ${statusEvidence.negativeMatch}.`,
            evidenceIds,
          },
        ],
        reviewTasks: [],
      };
    }

    if (!statusEvidence.positiveMatch) {
      return {
        status: "manual_review_required",
        note: "Registry page did not show a clear active or good-standing indicator.",
        facts: [
          {
            stepKey: this.stepKey,
            factKey: "good_standing_status",
            summary: "No active or good-standing indicator was found on the registry page.",
            value: {
              registrySearchUrl: registryUrl,
            },
            verificationStatus: "unverified",
            sourceId: "official_registry",
            evidenceIds,
            freshnessExpiresAt: null,
          },
        ],
        issues: [
          {
            stepKey: this.stepKey,
            severity: "high",
            title: "Registry status requires manual interpretation",
            detail:
              "The official registry page was captured, but it did not show an active or good-standing status.",
            evidenceIds,
          },
        ],
        reviewTasks: [
          {
            stepKey: this.stepKey,
            title: "Interpret official registry status",
            instructions:
              "Review the captured official registry page, determine whether the entity is active or in good standing, and resolve this task with supporting notes.",
          },
        ],
      };
    }

    if (capture.error || capture.artifactIds.length === 0) {
      return {
        status: "manual_review_required",
        note: `Registry status matched ${statusEvidence.positiveMatch}, but the required evidence capture did not complete.`,
        facts: [
          {
            stepKey: this.stepKey,
            factKey: "good_standing_status",
            summary: `${caseRecord.displayName} appears ${statusEvidence.positiveMatch} in the official registry, but the capture set is incomplete.`,
            value: {
              statusPhrase: statusEvidence.positiveMatch,
              registrySearchUrl: registryUrl,
            },
            verificationStatus: "verified",
            sourceId: "official_registry",
            evidenceIds,
            freshnessExpiresAt: addDays(new Date().toISOString(), 30),
          },
        ],
        issues: [
          {
            stepKey: this.stepKey,
            severity: "medium",
            title: "Registry evidence capture incomplete",
            detail:
              capture.error ??
              "Automated PDF or screenshot capture did not complete for the registry page.",
            evidenceIds,
          },
        ],
        reviewTasks: [
          {
            stepKey: this.stepKey,
            title: "Complete registry evidence capture",
            instructions:
              "The registry page indicates active or good standing, but the required saved evidence is incomplete. Capture the registry result page manually and resolve this task.",
          },
        ],
      };
    }

    return {
      status: "passed",
      note: `Verified registry status phrase: ${statusEvidence.positiveMatch}.`,
      facts: [
        {
          stepKey: this.stepKey,
          factKey: "good_standing_status",
          summary: `${caseRecord.displayName} appears ${statusEvidence.positiveMatch} in the official registry.`,
          value: {
            statusPhrase: statusEvidence.positiveMatch,
            registrySearchUrl: registryUrl,
            captureMode: capture.captureMode,
          },
          verificationStatus: "verified",
          sourceId: "official_registry",
          evidenceIds,
          freshnessExpiresAt: addDays(new Date().toISOString(), 30),
        },
      ],
      issues: [],
      reviewTasks: [],
    };
  }
}

export class ReputationSearchConnector implements StepConnector {
  public readonly stepKey = "reputation_search" as const;

  public async execute(context: ConnectorContext): Promise<StepExecutionResult> {
    if (isPublicShortcutPassed(context.snapshot)) {
      return skipped("Public-market shortcut satisfied; no further screening required.");
    }

    const name = context.snapshot.caseRecord.displayName;
    const queries = [
      name,
      `${name} scam`,
      `${name} fraud`,
      `${name} sued`,
      `${name} investigation`,
      `${name} complaint`,
      `${name} regulatory action`,
    ];
    const evidenceIds: string[] = [];
    const captureFailures: string[] = [];
    const pageSummaries: ReputationSearchPageSummary[] = [];

    const queryArtifact = await context.artifactStore.saveArtifact({
      caseId: context.snapshot.caseRecord.id,
      stepKey: this.stepKey,
      title: "Reputation Search Plan",
      sourceId: "google_search",
      sourceUrl: null,
      fileName: "reputation-search-plan.md",
      contentType: "text/markdown",
      body: queries
        .map((query) => `- ${query}`)
        .join("\n"),
      category: "evidence",
      metadata: {
        queries,
      },
    });
    evidenceIds.push(queryArtifact.id);

    let searchIndex = 0;
    for (const query of queries) {
      for (const offset of [0, 10]) {
        if (searchIndex > 0 && !context.webSearchClient) {
          await delay(2_000 + Math.floor(Math.random() * 2_000));
        }
        searchIndex += 1;

        const pageNumber = offset === 0 ? 1 : 2;
        const url = fillSourceTemplate(context.policy, "google_search", {
          query,
          offset: String(offset),
        });

        // Try web search API first (reliable, no bot detection)
        if (context.webSearchClient) {
          if (offset > 0) {
            continue;
          }
          const apiResults = await tryWebApiSearch(
            context,
            query,
            0,
            url,
            name,
            evidenceIds,
            pageSummaries,
            1
          );
          if (apiResults) {
            continue;
          }
        }

        // Fallback to browser capture
        const capture = await captureOptional(
          context,
          url,
          `Google Search ${query} page ${pageNumber}`,
          "google_search"
        );
        evidenceIds.push(...capture.artifactIds);
        const extraction = await summarizeGoogleSearchPage(
          url,
          capture.artifacts,
          context.artifactStore,
          deriveIgnoredAdverseKeywords(query, name)
        );
        pageSummaries.push({
          query,
          pageNumber,
          url,
          extractedResultCount: extraction.results.length,
          likelyAdverseCount: extraction.results.filter(
            (result) => result.adverseKeywords.length > 0
          ).length,
          extractionSource: extraction.extractionSource,
          fetchError: extraction.fetchError,
          captureError: capture.error,
          structureStatus: extraction.structureStatus,
          structureSignals: extraction.structureSignals,
          results: extraction.results.slice(0, 8),
        });
        if (capture.error) {
          captureFailures.push(
            `${query} page ${pageNumber}: ${capture.error}`
          );
        }
      }
    }

    const summaryArtifact = await context.artifactStore.saveArtifact({
      caseId: context.snapshot.caseRecord.id,
      stepKey: this.stepKey,
      title: "Reputation Search Summary",
      sourceId: "google_search",
      sourceUrl: null,
      fileName: "reputation-search-summary.md",
      contentType: "text/markdown",
      body: renderReputationSearchSummary(name, pageSummaries),
      category: "evidence",
      metadata: {
        queryCount: queries.length,
        pageCount: pageSummaries.length,
        likelyAdverseCount: pageSummaries.reduce(
          (sum, page) => sum + page.likelyAdverseCount,
          0
        ),
      },
    });
    evidenceIds.push(summaryArtifact.id);

    const extractedResultCount = pageSummaries.reduce(
      (sum, page) => sum + page.extractedResultCount,
      0
    );
    const likelyAdverseCount = pageSummaries.reduce(
      (sum, page) => sum + page.likelyAdverseCount,
      0
    );
    const degradedPages = pageSummaries.filter((page) => page.structureStatus !== "ok");

    return {
      status: "manual_review_required",
      note:
        degradedPages.length > 0
          ? `Prepared search evidence, but ${degradedPages.length} Google page extraction(s) look degraded and need manual review.`
          : captureFailures.length === 0
            ? `Prepared search evidence and extracted ${extractedResultCount} result candidates for analyst review.`
            : `Prepared search evidence with ${captureFailures.length} capture failure(s).`,
      facts: [
        {
          stepKey: this.stepKey,
          factKey: "reputation_search_summary",
          summary:
            likelyAdverseCount > 0
              ? `Extracted ${extractedResultCount} search-result candidates; ${likelyAdverseCount} contain likely adverse keywords and should be reviewed first.`
              : `Extracted ${extractedResultCount} search-result candidates across the required Google queries; no adverse keywords were flagged automatically.`,
          value: {
            queryCount: queries.length,
            pageCount: pageSummaries.length,
            extractedResultCount,
            likelyAdverseCount,
            pages: pageSummaries,
          },
          verificationStatus: "inferred",
          sourceId: "google_search",
          evidenceIds: [queryArtifact.id, summaryArtifact.id],
          freshnessExpiresAt: addDays(new Date().toISOString(), 1),
        },
      ],
      issues:
        [
          ...(captureFailures.length === 0
            ? []
            : [
                {
                  stepKey: this.stepKey,
                  severity: "medium" as const,
                  title: "Some Google search captures failed",
                  detail: captureFailures.join(" | "),
                  evidenceIds,
                },
              ]),
          ...(degradedPages.length === 0
            ? []
            : [
                {
                  stepKey: this.stepKey,
                  severity: "medium" as const,
                  title: "Google search extraction may be degraded",
                  detail: degradedPages
                    .map(
                      (page) =>
                        `${page.query} page ${page.pageNumber}: ${page.structureStatus} (${page.structureSignals.join(", ") || "no signals"})`
                    )
                    .join(" | "),
                  evidenceIds,
                },
              ]),
        ],
      reviewTasks: [
        {
          stepKey: this.stepKey,
          title: "Review reputational search results",
          instructions: buildReputationReviewInstructions(
            likelyAdverseCount,
            extractedResultCount,
            degradedPages.length
          ),
        },
      ],
    };
  }
}

export class BetterBusinessBureauConnector implements StepConnector {
  public readonly stepKey = "bbb_review" as const;

  public async execute(context: ConnectorContext): Promise<StepExecutionResult> {
    if (isPublicShortcutPassed(context.snapshot)) {
      return skipped("Public-market shortcut satisfied; no further screening required.");
    }

    const url = fillSourceTemplate(context.policy, "bbb_search", {
      query: context.snapshot.caseRecord.displayName,
    });
    const capture = await captureOptional(
      context,
      url,
      "BBB Search",
      "bbb_search"
    );
    const summary = await summarizeBbbSearchPage(
      url,
      capture.artifacts,
      context.artifactStore
    );
    const summaryArtifact = await context.artifactStore.saveArtifact({
      caseId: context.snapshot.caseRecord.id,
      stepKey: this.stepKey,
      title: "BBB Summary",
      sourceId: "bbb_search",
      sourceUrl: url,
      fileName: "bbb-summary.md",
      contentType: "text/markdown",
      body: renderBbbSummary(
        context.snapshot.caseRecord.displayName,
        url,
        summary
      ),
      category: "evidence",
      metadata: {
        ...summary,
      },
    });
    const evidenceIds = [...capture.artifactIds, summaryArtifact.id];

    return {
      status: "manual_review_required",
      note:
        summary.structureStatus !== "ok"
          ? `BBB search evidence was prepared, but extraction looks ${summary.structureStatus} and needs manual checking.`
          : capture.error == null
            ? "BBB search capture prepared; analyst review is required."
            : "BBB search capture failed and requires manual fallback.",
      facts: [
        {
          stepKey: this.stepKey,
          factKey: "bbb_search_summary",
          summary: buildBbbSummarySentence(summary),
          value: summary,
          verificationStatus: "inferred",
          sourceId: "bbb_search",
          evidenceIds: [summaryArtifact.id],
          freshnessExpiresAt: addDays(new Date().toISOString(), 1),
        },
      ],
      issues:
        [
          ...(capture.error == null
            ? []
            : [
                {
                  stepKey: this.stepKey,
                  severity: "medium" as const,
                  title: "BBB capture failed",
                  detail: capture.error,
                  evidenceIds,
                },
              ]),
          ...(summary.structureStatus === "ok"
            ? []
            : [
                {
                  stepKey: this.stepKey,
                  severity: "medium" as const,
                  title: "BBB extraction may be degraded",
                  detail: `${summary.structureStatus}: ${summary.structureSignals.join(", ") || "no signals"}`,
                  evidenceIds,
                },
              ]),
        ],
      reviewTasks: [
        {
          stepKey: this.stepKey,
          title: "Review BBB results",
          instructions: buildBbbReviewInstructions(summary),
        },
      ],
    };
  }
}

export class OfacPrecheckConnector implements StepConnector {
  public readonly stepKey = "ofac_precheck" as const;

  public constructor(private readonly datasetClient: OfacDatasetClient) {}

  public async execute(context: ConnectorContext): Promise<StepExecutionResult> {
    if (isPublicShortcutPassed(context.snapshot)) {
      return skipped("Public-market shortcut satisfied; no further screening required.");
    }

    const reusableFact = findReusableFreshStepFact(
      context.snapshot,
      context.storage,
      this.stepKey,
      "ofac_dataset_precheck"
    );
    if (reusableFact) {
      const reusedValue = parseJson<Record<string, unknown>>(
        reusableFact.fact.valueJson,
        {}
      );
      const reuseArtifact = await context.artifactStore.saveArtifact({
        caseId: context.snapshot.caseRecord.id,
        stepKey: this.stepKey,
        title: "OFAC Precheck Reuse Summary",
        sourceId: "ofac_dataset",
        sourceUrl: readObjectString(reusedValue, "sourceUrl"),
        fileName: "ofac-precheck-reuse.md",
        contentType: "text/markdown",
        body: [
          "# OFAC Precheck Reuse",
          "",
          `- Prior case: ${reusableFact.priorSnapshot.caseRecord.id}`,
          `- Reused fact summary: ${reusableFact.fact.summary}`,
          `- Fresh until: ${reusableFact.fact.freshnessExpiresAt ?? "None"}`,
        ].join("\n"),
        category: "evidence",
        metadata: {
          priorCaseId: reusableFact.priorSnapshot.caseRecord.id,
          reusedFactId: reusableFact.fact.id,
          freshnessExpiresAt: reusableFact.fact.freshnessExpiresAt,
        },
      });

      return {
        status: "passed",
        note: `Reused fresh OFAC dataset precheck from prior case ${reusableFact.priorSnapshot.caseRecord.id}.`,
        facts: [
          {
            stepKey: this.stepKey,
            factKey: "ofac_dataset_precheck",
            summary: `Reused fresh OFAC dataset precheck from prior case ${reusableFact.priorSnapshot.caseRecord.id}.`,
            value: {
              ...reusedValue,
              reusedFromCaseId: reusableFact.priorSnapshot.caseRecord.id,
            },
            verificationStatus: "verified",
            sourceId: "ofac_dataset",
            evidenceIds: [reuseArtifact.id],
            freshnessExpiresAt: reusableFact.fact.freshnessExpiresAt,
          },
        ],
        issues: [],
        reviewTasks: [],
      };
    }

    const name = normalizeName(context.snapshot.caseRecord.displayName);
    let dataset:
      | {
          names: string[];
          sourceUrl: string;
          fetchedAt: string;
        }
      | null = null;

    try {
      dataset = await this.datasetClient.loadCurrentDataset();
    } catch (error) {
      return {
        status: "skipped",
        note: "Automated OFAC precheck dataset was unavailable; workflow continued to the official OFAC search.",
        facts: [],
        issues: [
          {
            stepKey: this.stepKey,
            severity: "low",
            title: "OFAC dataset precheck unavailable",
            detail:
              error instanceof Error
                ? error.message
                : "OFAC dataset precheck was unavailable.",
            evidenceIds: [],
          },
        ],
        reviewTasks: [],
      };
    }

    const artifact = await context.artifactStore.saveArtifact({
      caseId: context.snapshot.caseRecord.id,
      stepKey: this.stepKey,
      title: "OFAC Precheck Summary",
      sourceId: "ofac_dataset",
      sourceUrl: dataset.sourceUrl,
      fileName: "ofac-precheck.json",
      contentType: "application/json",
      body: JSON.stringify(
        {
          sourceUrl: dataset.sourceUrl,
          fetchedAt: dataset.fetchedAt,
          normalizedName: name,
        },
        null,
        2
      ),
      category: "evidence",
      metadata: {
        sourceUrl: dataset.sourceUrl,
      },
    });

    if (dataset.names.includes(name)) {
      const issue: NewIssueInput = {
        stepKey: this.stepKey,
        severity: "critical",
        title: "Potential exact OFAC name match",
        detail:
          "The automated precheck found an exact normalized name match in the current official dataset export. Manual resolution is required.",
        evidenceIds: [artifact.id],
      };
      const reviewTask: NewReviewTaskInput = {
        stepKey: this.stepKey,
        title: "Resolve potential OFAC name match",
        instructions:
          "Review the OFAC match manually, determine whether this is a true match or a false positive, and record the resolution.",
      };

      return {
        status: "manual_review_required",
        note: "Potential exact normalized match found in official OFAC dataset export.",
        facts: [],
        issues: [issue],
        reviewTasks: [reviewTask],
      };
    }

    return {
      status: "passed",
      note: "No exact normalized match found in current official OFAC dataset export.",
      facts: [
        {
          stepKey: this.stepKey,
          factKey: "ofac_dataset_precheck",
          summary:
            "No exact normalized match was found in the current official OFAC dataset export.",
          value: {
            sourceUrl: dataset.sourceUrl,
            fetchedAt: dataset.fetchedAt,
          },
          verificationStatus: "verified",
          sourceId: "ofac_dataset",
          evidenceIds: [artifact.id],
          freshnessExpiresAt: addDays(new Date().toISOString(), 1),
        },
      ],
      issues: [],
      reviewTasks: [],
    };
  }
}

export class OfacSearchConnector implements StepConnector {
  public readonly stepKey = "ofac_search" as const;

  public async execute(context: ConnectorContext): Promise<StepExecutionResult> {
    if (isPublicShortcutPassed(context.snapshot)) {
      return skipped("Public-market shortcut satisfied; no further screening required.");
    }

    const reusableFact = findReusableFreshStepFact(
      context.snapshot,
      context.storage,
      this.stepKey,
      "ofac_search_result"
    );
    if (reusableFact) {
      const reusedValue = parseJson<Record<string, unknown>>(
        reusableFact.fact.valueJson,
        {}
      );
      const reuseArtifact = await context.artifactStore.saveArtifact({
        caseId: context.snapshot.caseRecord.id,
        stepKey: this.stepKey,
        title: "OFAC Search Reuse Summary",
        sourceId: "ofac_search",
        sourceUrl: "https://sanctionssearch.ofac.treas.gov/",
        fileName: "ofac-search-reuse.md",
        contentType: "text/markdown",
        body: [
          "# OFAC Search Reuse",
          "",
          `- Prior case: ${reusableFact.priorSnapshot.caseRecord.id}`,
          `- Reused fact summary: ${reusableFact.fact.summary}`,
          `- Fresh until: ${reusableFact.fact.freshnessExpiresAt ?? "None"}`,
        ].join("\n"),
        category: "evidence",
        metadata: {
          priorCaseId: reusableFact.priorSnapshot.caseRecord.id,
          reusedFactId: reusableFact.fact.id,
          freshnessExpiresAt: reusableFact.fact.freshnessExpiresAt,
        },
      });

      return {
        status: "passed",
        note: `Reused fresh official OFAC search result from prior case ${reusableFact.priorSnapshot.caseRecord.id}.`,
        facts: [
          {
            stepKey: this.stepKey,
            factKey: "ofac_search_result",
            summary: `Reused fresh official OFAC search result from prior case ${reusableFact.priorSnapshot.caseRecord.id}.`,
            value: {
              ...reusedValue,
              reusedFromCaseId: reusableFact.priorSnapshot.caseRecord.id,
            },
            verificationStatus: "verified",
            sourceId: "ofac_search",
            evidenceIds: [reuseArtifact.id],
            freshnessExpiresAt: reusableFact.fact.freshnessExpiresAt,
          },
        ],
        issues: [],
        reviewTasks: [],
      };
    }

    try {
      const result = await runOfacSearch(
        context.snapshot.caseRecord.id,
        context.snapshot.caseRecord.displayName,
        context.artifactStore
      );

      if (result.resultCount === 0) {
        return {
          status: "passed",
          note: "Official OFAC search returned no matching rows at minimum score 90.",
          facts: [
            {
              stepKey: this.stepKey,
              factKey: "ofac_search_result",
              summary:
                "Official OFAC Sanctions List Search returned no matching rows at minimum score 90.",
              value: {
                query: context.snapshot.caseRecord.displayName,
                minimumNameScore: 90,
                resultCount: result.resultCount,
              },
              verificationStatus: "verified",
              sourceId: "ofac_search",
              evidenceIds: result.artifactIds,
              freshnessExpiresAt: addDays(new Date().toISOString(), 1),
            },
          ],
          issues: [],
          reviewTasks: [],
        };
      }

      return {
        status: "manual_review_required",
        note: `Official OFAC search returned ${result.resultCount} potential row(s).`,
        facts: [
          {
            stepKey: this.stepKey,
            factKey: "ofac_search_result",
            summary: `Official OFAC search returned ${result.resultCount} potential row(s) at minimum score 90.`,
            value: {
              query: context.snapshot.caseRecord.displayName,
              minimumNameScore: 90,
              resultCount: result.resultCount,
            },
            verificationStatus: "verified",
            sourceId: "ofac_search",
            evidenceIds: result.artifactIds,
            freshnessExpiresAt: addDays(new Date().toISOString(), 1),
          },
        ],
        issues: [
          {
            stepKey: this.stepKey,
            severity: "critical",
            title: "Potential OFAC search hit",
            detail:
              "The official OFAC search returned one or more rows. A reviewer must determine whether any result is a true match.",
            evidenceIds: result.artifactIds,
          },
        ],
        reviewTasks: [
          {
            stepKey: this.stepKey,
            title: "Resolve OFAC search results",
            instructions:
              "Review the captured official OFAC search results, determine whether any returned row is a true match, and resolve this task with notes.",
          },
        ],
      };
    } catch (error) {
      return {
        status: "manual_review_required",
        note: "Official OFAC search automation failed and requires manual fallback.",
        facts: [],
        issues: [
          {
            stepKey: this.stepKey,
            severity: "medium",
            title: "OFAC search automation failed",
            detail:
              error instanceof Error
                ? error.message
                : "OFAC search automation failed.",
            evidenceIds: [],
          },
        ],
        reviewTasks: [
          {
            stepKey: this.stepKey,
            title: "Run official OFAC search manually",
            instructions:
              "Use the OFAC Sanctions List Search page, search the counterparty name with minimum name score 90, capture the result page, and resolve this task as clear or concern.",
          },
        ],
      };
    }
  }
}

const DEFAULT_OFAC_DATASET_URLS = [
  "https://www.treasury.gov/ofac/downloads/sdn.xml",
  "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML",
  "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML",
];

export class RemoteOfacDatasetClient implements OfacDatasetClient {
  private readonly candidateUrls: string[];
  private readonly cacheTtlMs = 24 * 60 * 60 * 1000;
  private cachedDataset: OfacDatasetSnapshot | null = null;

  public constructor(
    private readonly cachePath: string | null = null,
    candidateUrls?: string[]
  ) {
    this.candidateUrls = candidateUrls && candidateUrls.length > 0
      ? candidateUrls
      : DEFAULT_OFAC_DATASET_URLS;
  }

  public async loadCurrentDataset(): Promise<OfacDatasetSnapshot> {
    if (this.cachedDataset && !isExpired(this.cachedDataset.fetchedAt, this.cacheTtlMs)) {
      return this.cachedDataset;
    }

    const diskCache = await this.readDiskCache();
    if (diskCache && !isExpired(diskCache.fetchedAt, this.cacheTtlMs)) {
      this.cachedDataset = diskCache;
      return diskCache;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const sourceUrl of this.candidateUrls) {
        try {
          const response = await fetch(sourceUrl, {
            headers: { "User-Agent": defaultUserAgent() },
            signal: AbortSignal.timeout(45_000),
          });
          if (!response.ok) {
            continue;
          }

          const body = await response.text();
          if (body.trim() === "") {
            continue;
          }
          const names = uniqueStrings(
            extractCandidateNames(body).map((candidate) => normalizeName(candidate))
          ).filter(Boolean);
          if (names.length > 0) {
            this.cachedDataset = {
              names,
              sourceUrl: response.url,
              fetchedAt: new Date().toISOString(),
            };
            await this.writeDiskCache(this.cachedDataset);
            return this.cachedDataset;
          }
        } catch {
          continue;
        }
      }
    }

    if (diskCache) {
      this.cachedDataset = diskCache;
      return diskCache;
    }

    throw new Error(
      "Unable to load a usable official OFAC dataset export from the configured candidate URLs."
    );
  }

  private async readDiskCache(): Promise<OfacDatasetSnapshot | null> {
    if (!this.cachePath) {
      return null;
    }

    try {
      const body = await readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(body) as Partial<OfacDatasetSnapshot>;
      if (
        typeof parsed.sourceUrl === "string" &&
        typeof parsed.fetchedAt === "string" &&
        Array.isArray(parsed.names)
      ) {
        const names = parsed.names.filter(
          (value): value is string => typeof value === "string"
        );
        if (names.length > 0) {
          return {
            sourceUrl: parsed.sourceUrl,
            fetchedAt: parsed.fetchedAt,
            names,
          };
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  private async writeDiskCache(snapshot: OfacDatasetSnapshot): Promise<void> {
    if (!this.cachePath) {
      return;
    }

    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(snapshot, null, 2), "utf8");
  }
}

async function buildEntityResolutionBlocker(
  context: ConnectorContext,
  caseRecord: CaseSnapshot["caseRecord"]
): Promise<EntityResolutionOutcome> {
  const suggestions = getOfficialRegistrySuggestionsForCase(caseRecord);
  const blockerArtifact = await context.artifactStore.saveArtifact({
    caseId: caseRecord.id,
    stepKey: "entity_resolution",
    title: "Entity Resolution Blocker Summary",
    sourceId: "official_registry",
    sourceUrl: null,
    fileName: "entity-resolution-blocker.md",
    contentType: "text/markdown",
    body: renderRegistryBlockerMarkdown(caseRecord, suggestions),
    category: "evidence",
    metadata: {
      suggestions,
    },
  });

  const blockerParts = [
    "No official registry result URL was supplied.",
    describeJurisdictionGap(caseRecord.incorporationCountry, caseRecord.incorporationState),
  ];
  if (suggestions.length > 0) {
    blockerParts.push(
      `Suggested official search surfaces: ${suggestions
        .map((suggestion) => formatRegistrySuggestionSummary(suggestion))
        .join("; ")}.`
    );
  }

  return {
    status: "blocked",
    registryUrl: null,
    facts: [],
    issues: [
      {
        stepKey: "entity_resolution",
        severity: "high",
        title: "Entity resolution is blocked",
        detail: blockerParts.join(" "),
        evidenceIds: [blockerArtifact.id],
      },
    ],
    reviewTasks: [],
    evidenceIds: [blockerArtifact.id],
    note: "Entity resolution is blocked pending official registry pathing.",
    casePatch: {},
  };
}

async function buildEntityResolutionRouting(
  context: ConnectorContext,
  caseRecord: CaseSnapshot["caseRecord"]
): Promise<EntityResolutionOutcome | null> {
  if (!caseRecord.legalName) {
    return null;
  }

  const suggestions = getOfficialRegistrySuggestionsForCase(caseRecord);
  if (suggestions.length === 0) {
    return null;
  }

  const primarySuggestion = suggestions[0] ?? null;
  if (!primarySuggestion) {
    return null;
  }
  const routingMode = determineRegistryRoutingMode(
    caseRecord.incorporationCountry,
    caseRecord.incorporationState
  );

  const routingArtifact = await context.artifactStore.saveArtifact({
    caseId: caseRecord.id,
    stepKey: "entity_resolution",
    title: "Entity Resolution Routing Summary",
    sourceId: "official_registry",
    sourceUrl: primarySuggestion.url,
    fileName: "entity-resolution-routing.md",
    contentType: "text/markdown",
    body: [
      "# Entity Resolution Routing",
      "",
      `- Counterparty: ${caseRecord.displayName}`,
      `- Legal Name: ${caseRecord.legalName}`,
      `- Incorporation Country: ${caseRecord.incorporationCountry ?? "None"}`,
      `- Incorporation State: ${caseRecord.incorporationState ?? "None"}`,
      `- Primary official search surface: ${formatRegistrySuggestionSummary(primarySuggestion)}`,
      "",
      "Entity resolution established the legal entity and the correct official registry path, but an entity-specific registry result page or certificate may still require manual navigation.",
      "",
      "Recommended official sequence:",
      ...buildRegistryRoutingSequence(caseRecord, suggestions),
      "",
      ...suggestions.flatMap((suggestion) => [
        `- ${formatRegistrySuggestionSummary(suggestion)}`,
        `- Note: ${suggestion.notes}`,
      ]),
      ...buildRegistryReferenceLines(suggestions),
    ].join("\n"),
    category: "evidence",
    metadata: {
      legalName: caseRecord.legalName,
      incorporationCountry: caseRecord.incorporationCountry,
      incorporationState: caseRecord.incorporationState,
      suggestions,
      routingMode,
    },
  });

  return {
    status: "passed",
    registryUrl: primarySuggestion.url,
    facts: [
      {
        stepKey: "entity_resolution",
        factKey: "official_registry_path_established",
        summary:
          "Resolved the legal entity and established the correct official registry search surface for manual good-standing verification.",
        value: {
          legalName: caseRecord.legalName,
          incorporationCountry: caseRecord.incorporationCountry,
          incorporationState: caseRecord.incorporationState,
          registrySearchUrl: primarySuggestion.url,
          routingMode,
          suggestions,
        },
        verificationStatus: "inferred",
        sourceId: "official_registry",
        evidenceIds: [routingArtifact.id],
        freshnessExpiresAt: addDays(new Date().toISOString(), 30),
      },
    ],
    issues: [],
    reviewTasks: [],
    evidenceIds: [routingArtifact.id],
    note: "Entity resolution established the official registry routing path.",
    casePatch: {
      registrySearchUrl: caseRecord.registrySearchUrl ?? primarySuggestion.url,
    },
  };
}

async function buildKnownEntityStructureOutputs(
  context: ConnectorContext,
  caseRecord: CaseSnapshot["caseRecord"]
): Promise<Pick<EntityResolutionOutcome, "facts" | "issues" | "reviewTasks" | "evidenceIds">> {
  const entityStructure = getKnownEntitySourceHint(caseRecord)?.entityStructure;
  if (!entityStructure || entityStructure.entities.length === 0) {
    return {
      facts: [],
      issues: [],
      reviewTasks: [],
      evidenceIds: [],
    };
  }

  const artifact = await context.artifactStore.saveArtifact({
    caseId: caseRecord.id,
    stepKey: "entity_resolution",
    title: "Known Entity Structure Summary",
    sourceId: "known_entity_research",
    sourceUrl: entityStructure.entities.find((entity) => entity.sourceUrls?.[0])?.sourceUrls?.[0] ?? null,
    fileName: "known-entity-structure.md",
    contentType: "text/markdown",
    body: renderKnownEntityStructureMarkdown(caseRecord, entityStructure),
    category: "evidence",
    metadata: {
      entityStructure,
    },
  });

  const fact: NewFactInput = {
    stepKey: "entity_resolution",
    factKey: "known_entity_structure",
    summary:
      entityStructure.entities.length > 1
        ? "Known research indicates the counterparty brand maps to multiple legal entities that require scope confirmation."
        : "Known research indicates the counterparty brand maps to a specific legal entity routing profile.",
    value: entityStructure,
    verificationStatus: "inferred",
    sourceId: "known_entity_research",
    evidenceIds: [artifact.id],
    freshnessExpiresAt: addDays(new Date().toISOString(), 30),
  };

  if (entityStructure.entities.length <= 1) {
    return {
      facts: [fact],
      issues: [],
      reviewTasks: [],
      evidenceIds: [artifact.id],
    };
  }

  return {
    facts: [fact],
    issues: [
      {
        stepKey: "entity_resolution",
        severity: "medium",
        title: "Multiple known legal entities require scope confirmation",
        detail:
          "Official and curated evidence indicate this brand maps to multiple legal entities. Confirm which entity is signing and whether affiliate screening is also required before final approval.",
        evidenceIds: [artifact.id],
      },
    ],
    reviewTasks: [
      {
        stepKey: "entity_resolution",
        title: "Confirm in-scope legal entity or affiliate coverage",
        instructions: [
          "Review the linked known-entity-structure summary.",
          "Confirm which legal entity is the contracting party and whether affiliated entities are also in scope for this review.",
          "Do not treat the brand as cleared until the in-scope legal entity is explicitly identified in reviewer notes.",
        ].join(" "),
      },
    ],
    evidenceIds: [artifact.id],
  };
}

function renderKnownEntityStructureMarkdown(
  caseRecord: CaseSnapshot["caseRecord"],
  entityStructure: KnownEntityStructure
): string {
  return [
    "# Known Entity Structure",
    "",
    `- Counterparty display name: ${caseRecord.displayName}`,
    `- Brand: ${entityStructure.brand}`,
    `- Scope note: ${entityStructure.scopeNote}`,
    "",
    ...entityStructure.entities.flatMap((entity, index) => [
      `## Entity ${index + 1}`,
      `- Legal Name: ${entity.legalName}`,
      `- Jurisdiction: ${entity.jurisdiction}`,
      `- Role: ${entity.role}`,
      entity.registrySearchUrl ? `- Registry Route: ${entity.registrySearchUrl}` : null,
      entity.exactEntityName ? `- Exact Registry Target: ${entity.exactEntityName}` : null,
      entity.fileNumber ? `- File Number: ${entity.fileNumber}` : null,
      ...(entity.sourceUrls?.map((url) => `- Supporting Source: ${url}`) ?? []),
      ...(entity.notes?.map((note) => `- Note: ${note}`) ?? []),
      "",
    ]),
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

async function inferEntityDetailsFromWebsite(
  context: ConnectorContext,
  caseRecord: CaseSnapshot["caseRecord"],
  entityEvidenceLoader: EntityEvidenceLoader
): Promise<{
  casePatch: UpdateCaseScreeningInput;
  facts: NewFactInput[];
  issues: NewIssueInput[];
}> {
  if (!caseRecord.website) {
    const knownCandidates = getKnownEntityEvidenceCandidates(caseRecord);
    if (knownCandidates.length === 0) {
      return {
        casePatch: {},
        facts: [],
        issues: [],
      };
    }
  }

  const candidates = buildEntityEvidenceCandidates(caseRecord);
  let accumulatedPatch: UpdateCaseScreeningInput = {};
  const facts: NewFactInput[] = [];
  const issues: NewIssueInput[] = [];

  for (const candidate of candidates) {
    const page = await entityEvidenceLoader.load(candidate.url);
    if (!page) {
      if (candidate.curatedPatch && Object.keys(candidate.curatedPatch).length > 0) {
        const boundedCuratedPatch = limitPatchToMissingEntityFields(
          caseRecord,
          candidate.curatedPatch
        );
        if (Object.keys(boundedCuratedPatch).length > 0) {
          const fallbackArtifact = await context.artifactStore.saveArtifact({
            caseId: caseRecord.id,
            stepKey: "entity_resolution",
            title: `${candidate.title} Curated Routing Fallback`,
            sourceId: candidate.sourceId,
            sourceUrl: candidate.url,
            fileName: `${buildWebsiteArtifactName(candidate.url).replace(/\.html$/i, "")}-fallback.md`,
            contentType: "text/markdown",
            body: [
              "# Curated Entity Routing Fallback",
              "",
              `- Counterparty: ${caseRecord.displayName}`,
              `- Source URL: ${candidate.url}`,
              `- Applied fallback patch: ${JSON.stringify(boundedCuratedPatch)}`,
              "",
              "The live first-party page did not load within the configured bounds, so the bot reused a curated routing patch for this known entity and marked the result as inferred.",
              "",
              ...(candidate.curatedRationale ?? []).map((entry) => `- ${entry}`),
            ].join("\n"),
            category: "evidence",
            metadata: {
              sourceUrl: candidate.url,
              inferred: boundedCuratedPatch,
              fallback: true,
            },
          });
          accumulatedPatch = mergeUpdateCasePatch(
            accumulatedPatch,
            boundedCuratedPatch
          );
          facts.push({
            stepKey: "entity_resolution",
            factKey: `website_entity_inference_${facts.length + 1}`,
            summary:
              `Used curated entity-routing fallback for ${candidate.url} after the live page did not load in time.`,
            value: {
              sourceUrl: candidate.url,
              inferred: boundedCuratedPatch,
              rationale: candidate.curatedRationale ?? [],
              fallback: true,
            },
            verificationStatus: "inferred",
            sourceId: candidate.sourceId,
            evidenceIds: [fallbackArtifact.id],
            freshnessExpiresAt: addDays(new Date().toISOString(), 30),
          });
          issues.push({
            stepKey: "entity_resolution",
            severity: "low",
            title: "Entity hint page fallback used",
            detail:
              `The live page ${candidate.url} did not load within the configured bounds, so the bot used a curated routing fallback for this known entity.`,
            evidenceIds: [fallbackArtifact.id],
          });
        }
      }
      continue;
    }

    const inference = inferEntityPatchFromText(stripHtmlToText(page.html));
    const candidatePatch = applyCuratedEntityPatch(
      inference.casePatch,
      candidate.curatedPatch ?? {}
    );
    if (
      candidatePatch.legalName &&
      !isPlausibleLegalNameForCounterparty(
        caseRecord.displayName,
        candidatePatch.legalName,
        candidate.curatedPatch?.legalName ?? null
      )
    ) {
      delete candidatePatch.legalName;
      if (
        candidate.curatedPatch?.legalName &&
        isPlausibleLegalNameForCounterparty(
          caseRecord.displayName,
          candidate.curatedPatch.legalName,
          candidate.curatedPatch.legalName
        )
      ) {
        candidatePatch.legalName = candidate.curatedPatch.legalName;
      }
    }

    const boundedPatch = limitPatchToMissingEntityFields(
      caseRecord,
      candidatePatch
    );
    if (Object.keys(boundedPatch).length === 0) {
      continue;
    }

    const artifact = await context.artifactStore.saveArtifact({
      caseId: caseRecord.id,
      stepKey: "entity_resolution",
      title: candidate.title,
      sourceId: candidate.sourceId,
      sourceUrl: page.finalUrl,
      fileName: buildWebsiteArtifactName(page.finalUrl),
      contentType: "text/html",
      body: page.html,
      category: "evidence",
      metadata: {
        sourceUrl: page.finalUrl,
        inference: boundedPatch,
        loadMode: page.loadMode,
      },
    });
    const capture = await captureOptional(
      context,
      page.finalUrl,
      candidate.title,
      candidate.sourceId ?? "company_website",
      "entity_resolution"
    );
    const evidenceIds = [artifact.id, ...capture.artifactIds];

    accumulatedPatch = mergeUpdateCasePatch(accumulatedPatch, boundedPatch);
    facts.push({
      stepKey: "entity_resolution",
      factKey: `website_entity_inference_${facts.length + 1}`,
      summary: `Authoritative source text suggests entity details from ${page.finalUrl}.`,
      value: {
        sourceUrl: page.finalUrl,
        inferred: boundedPatch,
        rationale: [
          ...inference.rationale,
          ...(candidate.curatedRationale ?? []),
        ],
      },
      verificationStatus: "inferred",
      sourceId: candidate.sourceId,
      evidenceIds,
      freshnessExpiresAt: addDays(new Date().toISOString(), 30),
    });
  }

  if (facts.length > 1 && hasConflictingJurisdictionFacts(facts)) {
    issues.push({
      stepKey: "entity_resolution",
      severity: "medium",
      title: "Website jurisdiction signals conflict",
      detail:
        "First-party website pages suggested different jurisdiction details. Manual confirmation is recommended before relying on the inferred routing.",
      evidenceIds: facts.flatMap((fact) => fact.evidenceIds),
    });
  }

  return {
    casePatch: accumulatedPatch,
    facts,
    issues,
  };
}

function applyCasePatch(
  caseRecord: CaseSnapshot["caseRecord"],
  patch: UpdateCaseScreeningInput
): CaseSnapshot["caseRecord"] {
  return {
    ...caseRecord,
    legalName: patch.legalName === undefined ? caseRecord.legalName : patch.legalName,
    incorporationCountry:
      patch.incorporationCountry === undefined
        ? caseRecord.incorporationCountry
        : patch.incorporationCountry,
    incorporationState:
      patch.incorporationState === undefined
        ? caseRecord.incorporationState
        : patch.incorporationState,
    website: patch.website === undefined ? caseRecord.website : patch.website,
    registrySearchUrl:
      patch.registrySearchUrl === undefined
        ? caseRecord.registrySearchUrl
        : patch.registrySearchUrl,
    publicListingUrl:
      patch.publicListingUrl === undefined
        ? caseRecord.publicListingUrl
        : patch.publicListingUrl,
    exchangeName:
      patch.exchangeName === undefined ? caseRecord.exchangeName : patch.exchangeName,
    stockSymbol:
      patch.stockSymbol === undefined ? caseRecord.stockSymbol : patch.stockSymbol,
    notes: patch.notes === undefined ? caseRecord.notes : patch.notes,
  };
}

function mergeUpdateCasePatch(
  base: UpdateCaseScreeningInput,
  next: UpdateCaseScreeningInput
): UpdateCaseScreeningInput {
  const merged: UpdateCaseScreeningInput = { ...base };
  for (const [key, value] of Object.entries(next) as Array<
    [keyof UpdateCaseScreeningInput, string | null | undefined]
  >) {
    if (value !== undefined && merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function applyCuratedEntityPatch(
  inferred: UpdateCaseScreeningInput,
  curated: UpdateCaseScreeningInput
): UpdateCaseScreeningInput {
  const merged: UpdateCaseScreeningInput = { ...inferred };
  for (const [key, value] of Object.entries(curated) as Array<
    [keyof UpdateCaseScreeningInput, string | null | undefined]
  >) {
    if (value === undefined) {
      continue;
    }

    const current = merged[key];
    if (current === undefined || current === null || current.trim() === "") {
      merged[key] = value;
      continue;
    }

    if (
      typeof current === "string" &&
      typeof value === "string" &&
      normalizeName(current) === normalizeName(value)
    ) {
      merged[key] = value;
    }
  }

  return merged;
}

function limitPatchToMissingEntityFields(
  caseRecord: CaseSnapshot["caseRecord"],
  patch: UpdateCaseScreeningInput
): UpdateCaseScreeningInput {
  const limited: UpdateCaseScreeningInput = {};
  if (patch.legalName !== undefined && !caseRecord.legalName) {
    limited.legalName = patch.legalName;
  }
  if (patch.incorporationCountry !== undefined && !caseRecord.incorporationCountry) {
    limited.incorporationCountry = patch.incorporationCountry;
  }
  if (patch.incorporationState !== undefined && !caseRecord.incorporationState) {
    limited.incorporationState = patch.incorporationState;
  }
  if (patch.website !== undefined && !caseRecord.website) {
    limited.website = patch.website;
  }
  if (patch.registrySearchUrl !== undefined && !caseRecord.registrySearchUrl) {
    limited.registrySearchUrl = patch.registrySearchUrl;
  }
  return limited;
}

function buildEntityEvidenceCandidates(
  caseRecord: CaseSnapshot["caseRecord"]
): EntityEvidenceCandidate[] {
  const candidates: EntityEvidenceCandidate[] = [];
  if (caseRecord.website) {
    const baseUrl = new URL(caseRecord.website);
    const paths = [
      "",
      "/",
      "/terms",
      "/terms-of-service",
      "/legal",
      "/privacy",
      "/privacy-policy",
    ];
    for (const value of uniqueStrings(
      [caseRecord.website, ...paths.map((path) => new URL(path, `${baseUrl.origin}/`).toString())]
        .map((item) => item.trim())
        .filter(Boolean)
    )) {
      candidates.push({
        url: value,
        title: `Company Website Evidence ${value}`,
        sourceId: "company_website",
      });
    }
  }

  for (const candidate of getKnownEntityEvidenceCandidates(caseRecord)) {
    if (
      !candidates.some(
        (existing) =>
          normalizeName(existing.url) === normalizeName(candidate.url)
      )
    ) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function getKnownEntityEvidenceCandidates(
  caseRecord: CaseSnapshot["caseRecord"]
): EntityEvidenceCandidate[] {
  const match = getKnownEntitySourceHint(caseRecord);
  return match?.evidenceCandidates ?? [];
}

function getKnownEntitySourceHint(
  caseRecord: CaseSnapshot["caseRecord"]
): KnownEntitySourceHint | null {
  const normalizedDisplayName = normalizeName(caseRecord.displayName);
  const websiteHost = caseRecord.website
    ? new URL(caseRecord.website).hostname.toLowerCase()
    : null;

  return (
    KNOWN_ENTITY_SOURCE_HINTS.find((candidate) => {
      const matchesName = candidate.names.some(
        (name) => normalizeName(name) === normalizedDisplayName
      );
      const matchesHost =
        websiteHost != null &&
      (candidate.websiteHosts ?? []).some(
        (host) =>
          websiteHost === host || websiteHost.endsWith(`.${host}`)
      );
      return matchesName || matchesHost;
    }) ?? null
  );
}

async function loadEntityEvidencePageLive(
  url: string,
  browserAttempts: number,
  browserWaitMs: number
): Promise<{
  html: string;
  finalUrl: string;
  loadMode: "http_fetch" | "browser";
} | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": defaultUserAgent() },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) {
      const contentType = response.headers.get("content-type") ?? "text/html";
      if (/html|text/i.test(contentType)) {
        const html = await response.text();
        const title = extractHtmlTitle(html);
        if (html.trim() && !isLikelyChallengePage(title, html)) {
          return {
            html,
            finalUrl: response.url || url,
            loadMode: "http_fetch",
          };
        }
      }
    }
  } catch {
    // fall through to browser navigation
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-http2", "--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: defaultUserAgent(),
    locale: "en-US",
  });
  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    for (let attempt = 0; attempt < browserAttempts; attempt += 1) {
      await page.waitForTimeout(browserWaitMs);
      const html = await page.content();
      const title = await page.title().catch(() => "");
      if (html.trim() && !isLikelyChallengePage(title, html)) {
        return {
          html,
          finalUrl: page.url(),
          loadMode: "browser",
        };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await context.close();
    await browser.close();
  }
}

function buildWebsiteArtifactName(url: string): string {
  const parsed = new URL(url);
  const slug = `${parsed.hostname}${parsed.pathname}`
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug || "website-evidence"}.html`;
}

function inferEntityPatchFromText(text: string): {
  casePatch: UpdateCaseScreeningInput;
  rationale: string[];
} {
  const normalized = text.replace(/\s+/g, " ").trim();
  const lowercase = normalized.toLowerCase();
  const casePatch: UpdateCaseScreeningInput = {};
  const rationale: string[] = [];

  const corporateSuffix =
    "(?:Inc\\.?|LLC|Ltd\\.?|Limited|Corporation|Corp\\.?|Foundation|Company|Co\\.?|LLP|LP|PBC|P\\.B\\.C\\.)";
  const legalNamePatterns = [
    new RegExp(
      `(?:provided by|operated by|between you and|agreement between you and|made available by|renamed to)\\s+([A-Z][A-Za-z0-9&.,'()\\-/ ]{2,120}?\\b${corporateSuffix})\\b`,
      "i"
    ),
    new RegExp(
      `([A-Z][A-Za-z0-9&.,'()\\-/ ]{2,120}?\\b${corporateSuffix})\\b(?:\\s+d\\/?b\\/?a\\s+[A-Z][A-Za-z0-9&.,'()\\-/ ]{2,120})?\\s+is a\\s+`,
      "i"
    ),
    new RegExp(
      `([A-Z][A-Za-z0-9&.,'()\\-/ ]{2,120}?\\b${corporateSuffix})\\b(?:\\s+d\\/?b\\/?a\\s+[A-Z][A-Za-z0-9&.,'()\\-/ ]{2,120})?,\\s+a\\s+delaware`,
      "i"
    ),
  ];
  const legalName =
    legalNamePatterns
      .map((pattern) => pattern.exec(normalized)?.[1]?.trim() ?? null)
      .find((value) => value != null) ?? null;
  if (legalName && isMeaningfulLegalName(legalName)) {
    casePatch.legalName = legalName;
    rationale.push(`legal name: ${legalName}`);
  }

  if (
    lowercase.includes("organized under the laws of the state of delaware") ||
    lowercase.includes("delaware corporation") ||
    lowercase.includes("delaware limited liability company") ||
    lowercase.includes("delaware public benefit corporation")
  ) {
    casePatch.incorporationCountry = "US";
    casePatch.incorporationState = "DE";
    rationale.push("jurisdiction: Delaware, US");
  } else if (
    lowercase.includes("new york corporation") ||
    lowercase.includes("organized under the laws of the state of new york")
  ) {
    casePatch.incorporationCountry = "US";
    casePatch.incorporationState = "NY";
    rationale.push("jurisdiction: New York, US");
  } else if (
    lowercase.includes("california corporation") ||
    lowercase.includes("organized under the laws of the state of california")
  ) {
    casePatch.incorporationCountry = "US";
    casePatch.incorporationState = "CA";
    rationale.push("jurisdiction: California, US");
  } else if (
    lowercase.includes("new jersey corporation") ||
    lowercase.includes("organized under the laws of the state of new jersey")
  ) {
    casePatch.incorporationCountry = "US";
    casePatch.incorporationState = "NJ";
    rationale.push("jurisdiction: New Jersey, US");
  } else if (
    lowercase.includes("cayman islands exempted company") ||
    lowercase.includes("company organized under the laws of the cayman islands") ||
    lowercase.includes("company incorporated in the cayman islands")
  ) {
    casePatch.incorporationCountry = "Cayman Islands";
    rationale.push("jurisdiction: Cayman Islands");
  } else if (
    lowercase.includes("incorporated in england and wales") ||
    lowercase.includes("laws of england and wales")
  ) {
    casePatch.incorporationCountry = "United Kingdom";
    rationale.push("jurisdiction: United Kingdom");
  }

  return {
    casePatch,
    rationale,
  };
}

function isMeaningfulLegalName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "foundation" ||
    normalized === "the foundation" ||
    normalized === "company" ||
    normalized === "the company" ||
    normalized === "us" ||
    normalized === "our company"
  ) {
    return false;
  }

  return normalized.length >= 8;
}

function isPlausibleLegalNameForCounterparty(
  displayName: string,
  legalName: string,
  curatedLegalName: string | null
): boolean {
  if (
    curatedLegalName &&
    normalizeName(curatedLegalName) === normalizeName(legalName)
  ) {
    return true;
  }

  const displayTokens = tokenizeName(displayName);
  const legalTokens = tokenizeName(legalName);
  if (displayTokens.length === 0 || legalTokens.length === 0) {
    return false;
  }

  return displayTokens.some((token) => legalTokens.includes(token));
}

function tokenizeName(value: string): string[] {
  return normalizeName(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function hasConflictingJurisdictionFacts(facts: NewFactInput[]): boolean {
  const values = facts
    .map((fact) => fact.value as { inferred?: UpdateCaseScreeningInput })
    .map((value) => {
      const country = value.inferred?.incorporationCountry ?? "";
      const state = value.inferred?.incorporationState ?? "";
      return `${country}::${state}`;
    })
    .filter(Boolean);
  return uniqueStrings(values).length > 1;
}

export function createDefaultConnectors(
  datasetClient: OfacDatasetClient,
  entityEvidenceConfig: EntityEvidenceLoaderConfig = {}
): Map<WorkflowStepKey, StepConnector> {
  return new Map<WorkflowStepKey, StepConnector>([
    ["public_market_shortcut", new PublicMarketShortcutConnector()],
    [
      "entity_resolution",
      new EntityResolutionConnector(new EntityEvidenceLoader(entityEvidenceConfig)),
    ],
    ["good_standing", new GoodStandingConnector()],
    ["reputation_search", new ReputationSearchConnector()],
    ["bbb_review", new BetterBusinessBureauConnector()],
    ["ofac_precheck", new OfacPrecheckConnector(datasetClient)],
    ["ofac_search", new OfacSearchConnector()],
  ]);
}

function skipped(note: string): StepExecutionResult {
  return {
    status: "skipped",
    note,
    facts: [],
    issues: [],
    reviewTasks: [],
  };
}

function isPublicShortcutPassed(snapshot: CaseSnapshot): boolean {
  return snapshot.steps.some(
    (step) => step.stepKey === "public_market_shortcut" && step.status === "passed"
  );
}

async function captureOptional(
  context: ConnectorContext,
  url: string,
  title: string,
  sourceId: string,
  stepKeyOverride?: WorkflowStepKey
): Promise<{
  artifacts: ArtifactRecord[];
  artifactIds: string[];
  captureMode: CaptureResult["captureMode"] | null;
  error: string | null;
}> {
  if (!context.captureService) {
    return {
      artifacts: [],
      artifactIds: [],
      captureMode: null,
      error: "Capture service is disabled.",
    };
  }

  try {
    const artifacts = await context.captureService.capture({
      caseId: context.snapshot.caseRecord.id,
      stepKey: stepKeyOverride ?? inferStepKeyFromSource(sourceId),
      url,
      title,
      sourceId,
    });
    return {
      artifacts: artifacts.artifacts,
      artifactIds: artifacts.artifacts.map((artifact) => artifact.id),
      captureMode: artifacts.captureMode,
      error: null,
    };
  } catch (error) {
    return {
      artifacts: [],
      artifactIds: [],
      captureMode: null,
      error: error instanceof Error ? error.message : "Capture failed.",
    };
  }
}

function inferStepKeyFromSource(sourceId: string): WorkflowStepKey {
  switch (sourceId) {
    case "public_market_listing":
      return "public_market_shortcut";
    case "company_website":
      return "entity_resolution";
    case "official_registry":
      return "good_standing";
    case "google_search":
      return "reputation_search";
    case "bbb_search":
      return "bbb_review";
    case "ofac_dataset":
      return "ofac_precheck";
    default:
      return "ofac_search";
  }
}

function extractCandidateNames(body: string): string[] {
  const names: string[] = [];
  const patterns = [
    /<name>([^<]+)<\/name>/gi,
    /<akaName>([^<]+)<\/akaName>/gi,
    /<fixedRefName>([^<]+)<\/fixedRefName>/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null = pattern.exec(body);
    while (match) {
      const value = match[1]?.trim();
      if (value) {
        names.push(value);
      }
      match = pattern.exec(body);
    }
  }

  const entryPattern = /<sdnEntry>([\s\S]*?)<\/sdnEntry>/gi;
  let entryMatch = entryPattern.exec(body);
  while (entryMatch) {
    const block = entryMatch[1] ?? "";
    const first = /<firstName>([^<]+)<\/firstName>/i.exec(block)?.[1]?.trim();
    const last = /<lastName>([^<]+)<\/lastName>/i.exec(block)?.[1]?.trim();
    if (first && last) {
      names.push(`${first} ${last}`);
    }
    if (last) {
      names.push(last);
    }
    entryMatch = entryPattern.exec(body);
  }

  return names;
}

function findGoodStandingIndicator(html: string): {
  positiveMatch: string | null;
  negativeMatch: string | null;
} {
  const text = stripHtmlToText(html).toLowerCase().replace(/\s+/g, " ");
  const negativePatterns = [
    /\bnot in good standing\b/,
    /\bnot found\b/,
    /\binactive\b/,
    /\bdissolved\b/,
    /\brevoked\b/,
    /\bterminated\b/,
    /\bcancelled\b/,
    /\bforfeited\b/,
  ];
  for (const pattern of negativePatterns) {
    const match = pattern.exec(text);
    if (match?.[0]) {
      return { positiveMatch: null, negativeMatch: match[0] };
    }
  }

  const positivePatterns = [
    /\bcompany status\s*:?\s*active\b/,
    /\bentity status\s*:?\s*active\b/,
    /\bstatus\s*:?\s*active\b/,
    /\bin good standing\b/,
    /\bgood standing\b/,
  ];
  for (const pattern of positivePatterns) {
    const match = pattern.exec(text);
    if (match?.[0]) {
      return { positiveMatch: match[0], negativeMatch: null };
    }
  }

  return { positiveMatch: null, negativeMatch: null };
}

async function tryResolveCompaniesHouseRegistryUrl(
  context: ConnectorContext,
  caseRecord: CaseSnapshot["caseRecord"]
): Promise<EntityResolutionOutcome | null> {
  if (!isUkCountry(caseRecord.incorporationCountry)) {
    return null;
  }

  const query = caseRecord.legalName ?? caseRecord.displayName;
  if (!query) {
    return null;
  }

  const searchUrl = `https://find-and-update.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(
    query
  )}`;

  let body: string;
  try {
    const response = await fetch(searchUrl, {
      headers: { "User-Agent": defaultUserAgent() },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return null;
    }
    body = await response.text();
  } catch {
    return null;
  }

  const htmlArtifact = await context.artifactStore.saveArtifact({
    caseId: caseRecord.id,
    stepKey: "entity_resolution",
    title: "Companies House Search HTML",
    sourceId: "official_registry",
    sourceUrl: searchUrl,
    fileName: "companies-house-search.html",
    contentType: "text/html",
    body,
    category: "evidence",
    metadata: {
      sourceUrl: searchUrl,
      entityName: query,
      searchType: "companies_house_search",
    },
  });
  const capture = await captureOptional(
    context,
    searchUrl,
    "Companies House Search",
    "official_registry",
    "entity_resolution"
  );
  const evidenceIds = [htmlArtifact.id, ...capture.artifactIds];
  const detailMatch = resolveCompaniesHouseDetailMatch(body, query);
  if (!detailMatch) {
    return null;
  }

  return {
    status: "passed",
    registryUrl: detailMatch.detailUrl,
    facts: [
      {
        stepKey: "entity_resolution",
        factKey: "official_registry_url_resolved",
        summary:
          "Resolved an official Companies House detail page from an exact search-result match.",
        value: {
          query,
          searchUrl,
          legalName: detailMatch.matchedName,
          registrySearchUrl: detailMatch.detailUrl,
          captureMode: capture.captureMode,
        },
        verificationStatus: "verified",
        sourceId: "official_registry",
        evidenceIds,
        freshnessExpiresAt: addDays(new Date().toISOString(), 30),
      },
    ],
    issues: [],
    reviewTasks: [],
    evidenceIds,
    note: "Resolved registry search URL from Companies House search results.",
    casePatch: {
      legalName: caseRecord.legalName ?? detailMatch.matchedName,
      registrySearchUrl: detailMatch.detailUrl,
    },
  };
}

function resolveCompaniesHouseDetailMatch(
  html: string,
  entityName: string
): { detailUrl: string; matchedName: string } | null {
  const normalizedTarget = normalizeName(entityName);
  const itemPattern =
    /<li class="type-company">[\s\S]*?<a class="govuk-link" href="([^"]+)"[\s\S]*?>([\s\S]*?)<\/a>[\s\S]*?<\/li>/gi;
  let match = itemPattern.exec(html);
  while (match) {
    const href = match[1]?.trim();
    const rawLabel = stripHtmlToText(match[2] ?? "").trim();
    if (!href || !rawLabel) {
      match = itemPattern.exec(html);
      continue;
    }

    if (normalizeName(rawLabel) === normalizedTarget) {
      return {
        detailUrl: new URL(
          href,
          "https://find-and-update.company-information.service.gov.uk"
        ).toString(),
        matchedName: rawLabel,
      };
    }

    match = itemPattern.exec(html);
  }

  return null;
}

function renderRegistryBlockerMarkdown(
  caseRecord: CaseSnapshot["caseRecord"],
  suggestions: OfficialRegistrySuggestion[]
): string {
  const lines = [
    "# Entity Resolution Blocker",
    "",
    `- Counterparty: ${caseRecord.displayName}`,
    `- Legal Name: ${caseRecord.legalName ?? "None"}`,
    `- Incorporation Country: ${caseRecord.incorporationCountry ?? "None"}`,
    `- Incorporation State: ${caseRecord.incorporationState ?? "None"}`,
    `- Website: ${caseRecord.website ?? "None"}`,
    "",
    "The workflow could not continue because no official registry result URL was supplied.",
    describeJurisdictionGap(caseRecord.incorporationCountry, caseRecord.incorporationState),
  ];

  if (suggestions.length > 0) {
    lines.push("", "Suggested official registry starting points:");
    for (const suggestion of suggestions) {
      lines.push(`- ${formatRegistrySuggestionSummary(suggestion)}`);
      lines.push(`- Note: ${suggestion.notes}`);
    }
    lines.push("", "Recommended official sequence:");
    lines.push(...buildRegistryRoutingSequence(caseRecord, suggestions));
    lines.push(...buildRegistryReferenceLines(suggestions));
  }

  return lines.join("\n");
}

interface ManualRegistryRouting {
  registryUrl: string;
  routingMode: string;
  jurisdiction: string;
  note: string;
  summary: string;
  issueDetail: string;
  instructions: string;
  evidenceIds: string[];
}

function buildOfficialRegistrySuggestions(
  incorporationCountry: string | null,
  incorporationState: string | null
): OfficialRegistrySuggestion[] {
  if (isUkCountry(incorporationCountry)) {
    return [
      {
        label: "Companies House company search",
        url: "https://find-and-update.company-information.service.gov.uk/search/companies",
        notes: "Use the legal name to reach the company detail page, then verify the company status line.",
      },
    ];
  }

  if (isCaymanCountry(incorporationCountry)) {
    return [
      {
        label: "Cayman company search",
        url: "https://online.ciregistry.gov.ky/",
        notes:
          "Use the official Search Company Info surface for the exact entity name. The Cayman online tools guidance says registered users can obtain Basic Information, a List of Directors, and a Detailed Search Report online.",
        purpose: "locate_entity",
        authorityUrl: "https://www.ciregistry.ky/online-tools/",
        requiresRegistration: true,
      },
      {
        label: "Cayman online tools",
        url: "https://www.ciregistry.ky/online-tools/",
        notes:
          "Use the official Cayman online tools page to register or confirm access requirements before opening Search Company Info.",
        purpose: "access_support",
        authorityUrl: "https://www.ciregistry.ky/online-tools/",
        requiresRegistration: true,
      },
    ];
  }

  if (!isUsCountry(incorporationCountry)) {
    return [];
  }

  switch (normalizeStateToken(incorporationState)) {
    case "DE":
      return [
        {
          label: "Delaware entity name search",
          url: "https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx",
          notes:
            "Use the legal name or file number to reach the entity record. Delaware's official guidance says this free search returns general entity details and is not itself the current status determination.",
          purpose: "locate_entity",
          authorityUrl: "https://corp.delaware.gov/directweb/",
        },
        {
          label: "Delaware corporate status online",
          url: "https://corp.delaware.gov/directweb/",
          notes:
            "Use the official Delaware online status service to confirm current status. Delaware states this web status check is paid and does not generate an official certificate.",
          purpose: "verify_status",
          authorityUrl: "https://corp.delaware.gov/directweb/",
          requiresPayment: true,
        },
        {
          label: "Delaware certificate request guidance",
          url: "https://corp.delaware.gov/directweb/",
          notes:
            "If a formal certificate is required, use Delaware's official certificate request guidance for a Certificate of Status or Certificate of Good Standing.",
          purpose: "obtain_certificate",
          authorityUrl: "https://corp.delaware.gov/directweb/",
          requiresPayment: true,
        },
      ];
    case "NY":
      return [
        {
          label: "New York corporation and business entity database",
          url: "https://apps.dos.ny.gov/publicInquiry/",
          notes: "Use the official New York DOS inquiry portal to locate the business and review the status and filing data.",
        },
      ];
    case "CA":
      return [
        {
          label: "California Secretary of State business search",
          url: "https://bizfileonline.sos.ca.gov/search/business",
          notes: "Use the legal name to search the California SOS business database and open the detail record.",
        },
      ];
    case "NJ":
      return [
        {
          label: "New Jersey business records service",
          url: "https://www.njportal.com/DOR/BusinessNameSearch",
          notes: "Use the legal name in the official New Jersey business record search.",
        },
      ];
    default:
      return [];
  }
}

function getOfficialRegistrySuggestionsForCase(
  caseRecord: CaseSnapshot["caseRecord"]
): OfficialRegistrySuggestion[] {
  const knownSuggestions = getKnownEntitySourceHint(caseRecord)?.registrySuggestions ?? [];
  const genericSuggestions = buildOfficialRegistrySuggestions(
    caseRecord.incorporationCountry,
    caseRecord.incorporationState
  );

  const merged: OfficialRegistrySuggestion[] = [];
  for (const suggestion of [...knownSuggestions, ...genericSuggestions]) {
    const existing = merged.find(
      (candidate) =>
        normalizeName(candidate.url) === normalizeName(suggestion.url) &&
        normalizeName(candidate.label) === normalizeName(suggestion.label)
    );
    if (existing) {
      if (!existing.exactEntityName && suggestion.exactEntityName) {
        existing.exactEntityName = suggestion.exactEntityName;
      }
      if (!existing.fileNumber && suggestion.fileNumber) {
        existing.fileNumber = suggestion.fileNumber;
      }
      if (
        suggestion.notes.trim() !== "" &&
        !existing.notes.toLowerCase().includes(suggestion.notes.trim().toLowerCase())
      ) {
        existing.notes = `${existing.notes} ${suggestion.notes}`.trim();
      }
      continue;
    }
    merged.push(suggestion);
  }

  return merged;
}

function getManualRegistryRouting(
  snapshot: CaseSnapshot
): ManualRegistryRouting | null {
  const registryUrl = snapshot.caseRecord.registrySearchUrl?.trim() ?? "";
  if (!registryUrl) {
    return null;
  }

  const routingFact = snapshot.facts.find(
    (fact) => fact.stepKey === "entity_resolution" && fact.factKey === "official_registry_path_established"
  );
  const routingValue = routingFact
    ? parseJson<{
        routingMode?: string;
        suggestions?: OfficialRegistrySuggestion[];
      }>(routingFact.valueJson, {})
    : null;
  const suggestions =
    routingValue?.suggestions ??
    getOfficialRegistrySuggestionsForCase(snapshot.caseRecord);

  const matchesSearchSurface = suggestions.some(
    (suggestion) => normalizeName(suggestion.url) === normalizeName(registryUrl)
  );
  if (!matchesSearchSurface && routingValue?.routingMode !== "search_surface_only") {
    return null;
  }

  const jurisdiction = describeRegistryJurisdiction(
    snapshot.caseRecord.incorporationCountry,
    snapshot.caseRecord.incorporationState
  );
  return {
    registryUrl,
    routingMode:
      routingValue?.routingMode ??
      determineRegistryRoutingMode(
        snapshot.caseRecord.incorporationCountry,
        snapshot.caseRecord.incorporationState
      ),
    jurisdiction,
    note: buildManualRegistryNote(snapshot.caseRecord),
    summary: buildManualRegistrySummary(snapshot.caseRecord),
    issueDetail: buildManualRegistryIssueDetail(snapshot.caseRecord, jurisdiction, suggestions),
    instructions: buildManualRegistryInstructions(snapshot.caseRecord, suggestions),
    evidenceIds: routingFact?.evidenceIds ?? [],
  };
}

function describeJurisdictionGap(
  incorporationCountry: string | null,
  incorporationState: string | null
): string {
  if (!incorporationCountry) {
    return "The incorporation country is missing, so the bot cannot determine which official registry should be used.";
  }

  if (isUsCountry(incorporationCountry) && !incorporationState) {
    return "The incorporation state is missing, so the bot cannot choose the correct U.S. state registry.";
  }

  return "The official registry must still be opened and the entity-specific result page captured before the hard gate can pass.";
}

function describeRegistryJurisdiction(
  incorporationCountry: string | null,
  incorporationState: string | null
): string {
  if (isUsCountry(incorporationCountry)) {
    return incorporationState
      ? `${normalizeStateToken(incorporationState) ?? incorporationState}, US`
      : "US";
  }

  return incorporationCountry ?? "unknown jurisdiction";
}

function buildManualRegistryNote(caseRecord: CaseSnapshot["caseRecord"]): string {
  if (isDelawareJurisdiction(caseRecord.incorporationCountry, caseRecord.incorporationState)) {
    return "Official Delaware routing is established, but status still requires the official status or certificate path.";
  }

  if (isCaymanCountry(caseRecord.incorporationCountry)) {
    return "Official Cayman routing is established, but registered company search or report access still requires manual completion.";
  }

  return "Official registry routing is established, but the good-standing check still requires manual completion on the official registry.";
}

function buildManualRegistrySummary(caseRecord: CaseSnapshot["caseRecord"]): string {
  if (isDelawareJurisdiction(caseRecord.incorporationCountry, caseRecord.incorporationState)) {
    return "Official Delaware routing is known, but the free search surface is not itself a current status determination.";
  }

  if (isCaymanCountry(caseRecord.incorporationCountry)) {
    return "Official Cayman routing is known, but the registered company search or search-report path still requires manual completion.";
  }

  return "Official registry routing is known, but the captured source is a search surface or manual portal rather than an entity-specific good-standing result.";
}

function buildManualRegistryIssueDetail(
  caseRecord: CaseSnapshot["caseRecord"],
  jurisdiction: string,
  suggestions: OfficialRegistrySuggestion[]
): string {
  const suggestion = suggestions[0];
  if (isDelawareJurisdiction(caseRecord.incorporationCountry, caseRecord.incorporationState)) {
    return `The official registry path for ${jurisdiction} is established, but Delaware requires a separate official status or certificate path beyond the free entity search before the hard gate can pass.`;
  }

  if (isCaymanCountry(caseRecord.incorporationCountry)) {
    return `The official registry path for ${jurisdiction} is established, but Cayman company information still requires registered access and an entity-specific search result, report, or documented access limitation before the hard gate can pass.`;
  }

  if (!suggestion) {
    return `The official registry path for ${jurisdiction} is known, but the entity-specific active or good-standing result still requires manual completion.`;
  }

  return `The official registry path for ${jurisdiction} is established via ${formatRegistrySuggestionSummary(suggestion)}, but the entity-specific active or good-standing result still requires manual completion.`;
}

function buildManualRegistryInstructions(
  caseRecord: CaseSnapshot["caseRecord"],
  suggestions: OfficialRegistrySuggestion[]
): string {
  const legalName = caseRecord.legalName ?? caseRecord.displayName;
  if (isDelawareJurisdiction(caseRecord.incorporationCountry, caseRecord.incorporationState)) {
    const searchSuggestion =
      suggestions.find((suggestion) => suggestion.purpose === "locate_entity") ?? suggestions[0];
    const statusSuggestion =
      suggestions.find((suggestion) => suggestion.purpose === "verify_status") ?? null;
    const certificateSuggestion =
      suggestions.find((suggestion) => suggestion.purpose === "obtain_certificate") ?? null;
    const exactTarget = searchSuggestion?.exactEntityName ?? legalName;
    const fileNumber = searchSuggestion?.fileNumber ?? null;
    return [
      `Use the official Delaware path for ${legalName}.`,
      searchSuggestion
        ? `Start with ${formatRegistrySuggestionSummary(searchSuggestion)} and confirm the exact entity record.`
        : null,
      `Search the exact legal name ${exactTarget}${fileNumber ? ` or file number ${fileNumber}` : ""}.`,
      "Delaware's official guidance states the free entity search returns general entity details and is not itself a current status determination.",
      statusSuggestion
        ? `${formatRegistrySuggestionSummary(statusSuggestion)}. ${statusSuggestion.notes}`
        : null,
      certificateSuggestion
        ? `${formatRegistrySuggestionSummary(certificateSuggestion)}. ${certificateSuggestion.notes}`
        : null,
      "Capture the status output or the certificate-request limitation you encounter, record the exact status phrase shown by Delaware, and resolve the review task with that phrase and any filing or access details.",
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ");
  }

  if (isCaymanCountry(caseRecord.incorporationCountry)) {
    const searchSuggestion =
      suggestions.find((suggestion) => suggestion.purpose === "locate_entity") ?? suggestions[0];
    const accessSuggestion =
      suggestions.find((suggestion) => suggestion.purpose === "access_support") ?? null;
    const relatedSuggestions = suggestions.filter(
      (suggestion) => suggestion !== searchSuggestion && suggestion !== accessSuggestion
    );
    const exactTarget = searchSuggestion?.exactEntityName ?? legalName;
    return [
      `Use the official Cayman path for ${legalName}.`,
      accessSuggestion
        ? `${formatRegistrySuggestionSummary(accessSuggestion)}. ${accessSuggestion.notes}`
        : null,
      searchSuggestion
        ? `Then open ${formatRegistrySuggestionSummary(searchSuggestion)} and search the exact entity name ${exactTarget}.`
        : null,
      "The Cayman online tools guidance states registered users can obtain Basic Information, a List of Directors, and a Detailed Search Report online.",
      ...relatedSuggestions.map(
        (suggestion) =>
          `If scope confirmation shows a related affiliate is also in scope, use ${formatRegistrySuggestionSummary(suggestion)}. ${suggestion.notes}`
      ),
      "Capture the company search result, the strongest available official report, or the access limitation you encounter, and resolve the review task with the exact status wording or limitation.",
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ");
  }

  if (suggestions.length === 0) {
    return [
      `Use the official registry for ${legalName}.`,
      "Search the exact legal name or file number.",
      "Open the entity-specific result page or status surface, not just the registry landing page.",
      "Record the exact status phrase shown by the official registry.",
      "Capture the page to PDF or screenshot and resolve the review task with the status phrase and any filing date shown.",
    ].join(" ");
  }

  return [
    `Use the official registry for ${legalName} and complete the search manually.`,
    ...suggestions.map(
      (suggestion) =>
        `${formatRegistrySuggestionSummary(suggestion)}. ${suggestion.notes}`
    ),
    "Search the exact legal name or file number that is listed in the routing details when available.",
    "Open the entity-specific result page or certificate surface, not just the registry landing page.",
    "Record the exact status phrase shown by the official registry.",
    "Capture the resulting page or certificate and resolve the review task with the status phrase, any filing date shown, and any access limitation encountered.",
  ].join(" ");
}

function formatRegistrySuggestionSummary(suggestion: OfficialRegistrySuggestion): string {
  const details = [
    suggestion.exactEntityName ? `exact entity: ${suggestion.exactEntityName}` : null,
    suggestion.fileNumber ? `file number: ${suggestion.fileNumber}` : null,
    suggestion.requiresRegistration ? "registration required" : null,
    suggestion.requiresPayment ? "payment required" : null,
  ].filter((value): value is string => Boolean(value));

  return details.length === 0
    ? `${suggestion.label} (${suggestion.url})`
    : `${suggestion.label} (${suggestion.url}; ${details.join("; ")})`;
}

function buildRegistryRoutingSequence(
  caseRecord: CaseSnapshot["caseRecord"],
  suggestions: OfficialRegistrySuggestion[]
): string[] {
  if (isDelawareJurisdiction(caseRecord.incorporationCountry, caseRecord.incorporationState)) {
    const searchSuggestion =
      suggestions.find((suggestion) => suggestion.purpose === "locate_entity") ?? suggestions[0];
    const statusSuggestion =
      suggestions.find((suggestion) => suggestion.purpose === "verify_status") ?? null;
    const certificateSuggestion =
      suggestions.find((suggestion) => suggestion.purpose === "obtain_certificate") ?? null;
    return [
      `1. Open ${formatRegistrySuggestionSummary(searchSuggestion ?? suggestions[0]!)} and confirm the exact entity record.`,
      searchSuggestion?.fileNumber
        ? `2. Reuse file number ${searchSuggestion.fileNumber} when the Delaware status or certificate flow asks for it.`
        : "2. Record the entity file number from the Delaware search result.",
      statusSuggestion
        ? `3. Use ${formatRegistrySuggestionSummary(statusSuggestion)} to confirm current status.`
        : "3. Use the official Delaware status surface to confirm current status.",
      certificateSuggestion
        ? `4. If a formal certificate is required, continue with ${formatRegistrySuggestionSummary(certificateSuggestion)}.`
        : "4. If a formal certificate is required, use the official Delaware certificate request path.",
    ];
  }

  if (isCaymanCountry(caseRecord.incorporationCountry)) {
    const accessSuggestion =
      suggestions.find((suggestion) => suggestion.purpose === "access_support") ?? null;
    const searchSuggestion =
      suggestions.find((suggestion) => suggestion.purpose === "locate_entity") ?? suggestions[0];
    return [
      accessSuggestion
        ? `1. Open ${formatRegistrySuggestionSummary(accessSuggestion)} and register or confirm login requirements.`
        : "1. Register or confirm login requirements on the official Cayman tools surface.",
      `2. Open ${formatRegistrySuggestionSummary(searchSuggestion ?? suggestions[0]!)} and search the exact entity name.`,
      "3. Capture the strongest available official company output, such as Basic Information or a Detailed Search Report.",
      "4. If access is limited or no status output is publicly visible, capture that limitation and record it in the review resolution.",
    ];
  }

  const fallbackSuggestion = suggestions[0];
  return [
    fallbackSuggestion
      ? `1. Open ${formatRegistrySuggestionSummary(fallbackSuggestion)}.`
      : "1. Open the official registry.",
    "2. Search the exact legal name or file number.",
    "3. Open the entity-specific result or status surface.",
    "4. Capture the status phrase or any access limitation encountered.",
  ];
}

function buildRegistryReferenceLines(suggestions: OfficialRegistrySuggestion[]): string[] {
  const referenceUrls = uniqueStrings(
    suggestions.map((suggestion) => suggestion.authorityUrl ?? suggestion.url).filter(Boolean)
  );
  if (referenceUrls.length === 0) {
    return [];
  }

  return ["", "Official reference pages:", ...referenceUrls.map((url) => `- ${url}`)];
}

function determineRegistryRoutingMode(
  incorporationCountry: string | null,
  incorporationState: string | null
): string {
  if (isDelawareJurisdiction(incorporationCountry, incorporationState)) {
    return "delaware_status_path";
  }

  if (isCaymanCountry(incorporationCountry)) {
    return "cayman_registered_search";
  }

  return "search_surface_only";
}

function findReusableFreshStepFact(
  snapshot: CaseSnapshot,
  storage: PolicyBotStorage,
  stepKey: WorkflowStepKey,
  factKey: string
): ReusableFreshStepFact | null {
  for (const priorCase of snapshot.priorCases) {
    const priorSnapshot = storage.buildCaseSnapshot(priorCase.id);
    const step = priorSnapshot.steps.find((candidate) => candidate.stepKey === stepKey);
    if (!step || step.status !== "passed") {
      continue;
    }

    const fact = priorSnapshot.facts.find(
      (candidate) =>
        candidate.stepKey === stepKey &&
        candidate.factKey === factKey &&
        candidate.verificationStatus === "verified" &&
        isFreshFact(candidate.freshnessExpiresAt)
    );
    if (fact) {
      return {
        priorSnapshot,
        fact,
      };
    }
  }

  return null;
}

function isFreshFact(freshnessExpiresAt: string | null): boolean {
  if (!freshnessExpiresAt) {
    return false;
  }

  const expiresAt = Date.parse(freshnessExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function readObjectString(
  value: Record<string, unknown>,
  key: string
): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

async function summarizeGoogleSearchPage(
  url: string,
  captureArtifacts: ArtifactRecord[],
  artifactStore: ArtifactStore,
  ignoredKeywords: string[]
): Promise<{
  results: SearchHitSummary[];
  fetchError: string | null;
  extractionSource: "captured_html" | "live_fetch" | "none";
  structureStatus: "ok" | "challenge" | "layout_changed" | "thin_content";
  structureSignals: string[];
}> {
  const capturedHtml = await readCapturedHtml(captureArtifacts, artifactStore);
  if (capturedHtml) {
    const diagnostics = inspectGoogleSearchHtml(capturedHtml);
    return {
      results: extractSearchHitsFromHtml(capturedHtml, ignoredKeywords),
      fetchError: null,
      extractionSource: "captured_html",
      structureStatus: diagnostics.structureStatus,
      structureSignals: diagnostics.structureSignals,
    };
  }

  try {
    const html = await fetchHtmlForSummary(url);
    if (!html) {
      return {
        results: [],
        fetchError: "No HTML body returned for search summary extraction.",
        extractionSource: "none",
        structureStatus: "thin_content",
        structureSignals: ["no_html_body"],
      };
    }

    const diagnostics = inspectGoogleSearchHtml(html);
    return {
      results: extractSearchHitsFromHtml(html, ignoredKeywords),
      fetchError: null,
      extractionSource: "live_fetch",
      structureStatus: diagnostics.structureStatus,
      structureSignals: diagnostics.structureSignals,
    };
  } catch (error) {
    return {
      results: [],
      fetchError: error instanceof Error ? error.message : "Search summary extraction failed.",
      extractionSource: "none",
      structureStatus: "thin_content",
      structureSignals: ["summary_fetch_failed"],
    };
  }
}

function renderReputationSearchSummary(
  displayName: string,
  pages: ReputationSearchPageSummary[]
): string {
  const totalExtracted = pages.reduce(
    (sum, page) => sum + page.extractedResultCount,
    0
  );
  const totalLikelyAdverse = pages.reduce(
    (sum, page) => sum + page.likelyAdverseCount,
    0
  );

  return [
    "# Reputation Search Summary",
    "",
    `- Counterparty: ${displayName}`,
    `- Query pages reviewed: ${pages.length}`,
    `- Extracted result candidates: ${totalExtracted}`,
    `- Likely adverse hits flagged: ${totalLikelyAdverse}`,
    "",
    ...pages.flatMap((page) => [
      `## ${page.query} (page ${page.pageNumber})`,
      `- Search URL: ${page.url}`,
      `- Extracted results: ${page.extractedResultCount}`,
      `- Likely adverse hits: ${page.likelyAdverseCount}`,
      `- Summary source: ${page.extractionSource}`,
      `- Structure status: ${page.structureStatus}`,
      `- Structure signals: ${page.structureSignals.length > 0 ? page.structureSignals.join(", ") : "None"}`,
      `- HTML extraction: ${page.fetchError ?? "ok"}`,
      `- Capture status: ${page.captureError ?? "ok"}`,
      page.results.length === 0
        ? "- Candidate results: none extracted automatically"
        : "- Candidate results:",
      ...page.results.map((result) =>
        [
          `  - ${result.title}`,
          `    - URL: ${result.url}`,
          result.domain ? `    - Domain: ${result.domain}` : null,
          result.snippet ? `    - Snippet: ${result.snippet}` : null,
          result.adverseKeywords.length > 0
            ? `    - Adverse keywords: ${result.adverseKeywords.join(", ")}`
            : `    - Adverse keywords: none flagged`,
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join("\n")
      ),
      "",
    ]),
  ].join("\n");
}

function buildReputationReviewInstructions(
  likelyAdverseCount: number,
  extractedResultCount: number,
  degradedPageCount: number
): string {
  const priorityNote =
    likelyAdverseCount > 0
      ? `Prioritize the ${likelyAdverseCount} extracted result(s) that were flagged with adverse keywords before clearing the stage.`
      : "Start with the extracted summary, then confirm the raw captures do not contain materially adverse hits that were missed by the heuristic.";
  return [
    "Review the first two Google result pages for each required query.",
    `The bot extracted ${extractedResultCount} candidate result(s) into the stage summary.`,
    degradedPageCount > 0
      ? `${degradedPageCount} page(s) showed layout drift, challenge behavior, or thin content, so rely on the raw captures for those pages instead of the automatic extraction alone.`
      : null,
    priorityNote,
    "Document any tarnished public-image evidence and resolve this task as clear or concern.",
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

async function summarizeBbbSearchPage(
  url: string,
  captureArtifacts: ArtifactRecord[],
  artifactStore: ArtifactStore
): Promise<BbbSearchSummary> {
  const capturedHtml = await readCapturedHtml(captureArtifacts, artifactStore);
  if (capturedHtml) {
    const diagnostics = inspectBbbHtml(capturedHtml);
    return {
      ...extractBbbSummary(capturedHtml),
      extractionSource: "captured_html",
      structureStatus: diagnostics.structureStatus,
      structureSignals: diagnostics.structureSignals,
    };
  }

  try {
    const html = await fetchHtmlForSummary(url);
    if (!html) {
      return {
        rating: null,
        reviewCount: null,
        complaintCount: null,
        flaggedKeywords: [],
        fetchError: "No HTML body returned for BBB summary extraction.",
        extractionSource: "none",
        structureStatus: "thin_content",
        structureSignals: ["no_html_body"],
      };
    }

    const diagnostics = inspectBbbHtml(html);
    return {
      ...extractBbbSummary(html),
      extractionSource: "live_fetch",
      structureStatus: diagnostics.structureStatus,
      structureSignals: diagnostics.structureSignals,
    };
  } catch (error) {
    return {
      rating: null,
      reviewCount: null,
      complaintCount: null,
      flaggedKeywords: [],
      fetchError: error instanceof Error ? error.message : "BBB summary extraction failed.",
      extractionSource: "none",
      structureStatus: "thin_content",
      structureSignals: ["summary_fetch_failed"],
    };
  }
}

function renderBbbSummary(
  displayName: string,
  url: string,
  summary: BbbSearchSummary
): string {
  return [
    "# BBB Summary",
    "",
    `- Counterparty: ${displayName}`,
    `- Search URL: ${url}`,
    `- Rating: ${summary.rating ?? "Not extracted"}`,
    `- Review count mention: ${summary.reviewCount ?? "Not extracted"}`,
    `- Complaint count mention: ${summary.complaintCount ?? "Not extracted"}`,
    `- Flagged keywords: ${summary.flaggedKeywords.length > 0 ? summary.flaggedKeywords.join(", ") : "None"}`,
    `- Summary source: ${summary.extractionSource}`,
    `- Structure status: ${summary.structureStatus}`,
    `- Structure signals: ${summary.structureSignals.length > 0 ? summary.structureSignals.join(", ") : "None"}`,
    `- HTML extraction: ${summary.fetchError ?? "ok"}`,
  ].join("\n");
}

function buildBbbSummarySentence(summary: BbbSearchSummary): string {
  const parts = [
    summary.rating ? `BBB rating mention ${summary.rating}` : null,
    summary.reviewCount != null ? `${summary.reviewCount} review mention(s)` : null,
    summary.complaintCount != null
      ? `${summary.complaintCount} complaint mention(s)`
      : null,
    summary.flaggedKeywords.length > 0
      ? `flagged keywords: ${summary.flaggedKeywords.join(", ")}`
      : null,
  ].filter((entry): entry is string => Boolean(entry));

  return parts.length === 0
    ? "BBB search summary was prepared, but no structured rating or complaint markers were extracted automatically."
    : `BBB search summary extracted: ${parts.join("; ")}.`;
}

function buildBbbReviewInstructions(summary: BbbSearchSummary): string {
  const priorityNotes = [
    summary.rating ? `Check whether the rating mention (${summary.rating}) is current and belongs to the correct entity.` : null,
    summary.complaintCount != null
      ? `Confirm whether the complaint count mention (${summary.complaintCount}) reflects negative complaints for this entity.`
      : null,
    summary.flaggedKeywords.length > 0
      ? `Review the flagged BBB keywords first: ${summary.flaggedKeywords.join(", ")}.`
      : null,
  ].filter((entry): entry is string => Boolean(entry));

  return [
    "Review the BBB search results and any negative reviews or ratings evidence.",
    summary.structureStatus !== "ok"
      ? `Automatic BBB extraction looked ${summary.structureStatus}; rely on the raw capture first and treat the extracted fields as incomplete until verified.`
      : null,
    ...priorityNotes,
    "Resolve this task with notes describing whether the results are clear, concerning, or incomplete.",
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

async function fetchHtmlForSummary(url: string): Promise<string | null> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": defaultUserAgent(),
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Fetch failed with HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "text/html";
  if (!/html|text/i.test(contentType)) {
    return null;
  }

  return response.text();
}

async function readCapturedHtml(
  captureArtifacts: ArtifactRecord[],
  artifactStore: ArtifactStore
): Promise<string | null> {
  const htmlArtifact =
    captureArtifacts.find(
      (artifact) =>
        artifact.contentType.toLowerCase().includes("html") ||
        artifact.relativePath.toLowerCase().endsWith(".html")
    ) ?? null;
  if (!htmlArtifact) {
    return null;
  }

  try {
    return await readFile(artifactStore.resolveAbsolutePath(htmlArtifact), "utf8");
  } catch {
    return null;
  }
}

function extractSearchHitsFromHtml(
  html: string,
  ignoredKeywords: string[] = []
): SearchHitSummary[] {
  const decodedHtml = decodeEscapedSearchHtml(html);
  const hits: SearchHitSummary[] = [];
  const seenUrls = new Set<string>();
  const anchorPattern = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match = anchorPattern.exec(decodedHtml);

  while (match) {
    const normalizedUrl = normalizeSearchResultUrl(match[1] ?? "");
    const title = stripHtmlToText(match[2] ?? "").replace(/\s+/g, " ").trim();
    if (!normalizedUrl || !title || title.length < 4) {
      match = anchorPattern.exec(decodedHtml);
      continue;
    }

    const domain = readDomain(normalizedUrl);
    if (!domain || isSearchProviderDomain(domain) || seenUrls.has(normalizedUrl)) {
      match = anchorPattern.exec(decodedHtml);
      continue;
    }

    const windowStart = Math.max(0, match.index - 120);
    const windowEnd = Math.min(decodedHtml.length, match.index + 500);
    const contextSnippet = stripHtmlToText(decodedHtml.slice(windowStart, windowEnd))
      .replace(/\s+/g, " ")
      .trim();
    const snippet = contextSnippet.length === 0 ? null : contextSnippet.slice(0, 240);
    const adverseKeywords = extractAdverseKeywords(
      `${title} ${snippet ?? ""}`,
      ignoredKeywords
    );

    hits.push({
      title,
      url: normalizedUrl,
      domain,
      snippet,
      adverseKeywords,
    });
    seenUrls.add(normalizedUrl);
    if (hits.length >= 12) {
      break;
    }

    match = anchorPattern.exec(decodedHtml);
  }

  return hits;
}

function normalizeSearchResultUrl(rawHref: string): string | null {
  if (!rawHref) {
    return null;
  }

  const normalizedHref = rawHref.replace(/&amp;/gi, "&");

  if (normalizedHref.startsWith("/url?")) {
    try {
      const searchUrl = new URL(`https://www.google.com${normalizedHref}`);
      const resolved =
        searchUrl.searchParams.get("q") ?? searchUrl.searchParams.get("url");
      return resolved ? resolved : null;
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(normalizedHref)) {
    return normalizedHref;
  }

  return null;
}

function decodeEscapedSearchHtml(html: string): string {
  return html
    .replace(/\\x3c/gi, "<")
    .replace(/\\x3e/gi, ">")
    .replace(/\\x3d/gi, "=")
    .replace(/\\x26/gi, "&")
    .replace(/\\"/g, "\"")
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u0026/gi, "&");
}

function readDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isSearchProviderDomain(domain: string): boolean {
  return (
    domain === "google.com" ||
    domain.endsWith(".google.com") ||
    domain === "www.google.com"
  );
}

function deriveIgnoredAdverseKeywords(query: string, displayName: string): string[] {
  const queryKeywords = extractAdverseKeywords(query);
  const displayKeywords = new Set(extractAdverseKeywords(displayName));
  return queryKeywords.filter((keyword) => !displayKeywords.has(keyword));
}

function extractAdverseKeywords(text: string, ignoredKeywords: string[] = []): string[] {
  const lowered = normalizeName(text);
  const ignored = new Set(ignoredKeywords.map((keyword) => normalizeName(keyword)));
  return uniqueStrings(
    ADVERSE_KEYWORDS.filter(
      (keyword) =>
        lowered.includes(keyword) && !ignored.has(normalizeName(keyword))
    )
  );
}

function extractBbbSummary(html: string): BbbSearchSummary {
  const text = stripHtmlToText(html).replace(/\s+/g, " ").trim();
  const ratingMatch =
    /\b(?:bbb\s+rating|rating)\s*:?\s*([A-F][+-]?)/i.exec(text) ??
    /\b([A-F][+-]?)\s+rating\b/i.exec(text);
  const reviewCountMatch = /(\d+)\s+customer reviews?/i.exec(text);
  const complaintCountMatch = /(\d+)\s+complaints?/i.exec(text);

  return {
    rating: ratingMatch?.[1] ?? null,
    reviewCount: reviewCountMatch?.[1] ? Number(reviewCountMatch[1]) : null,
    complaintCount: complaintCountMatch?.[1]
      ? Number(complaintCountMatch[1])
      : null,
    flaggedKeywords: extractAdverseKeywords(text),
    fetchError: null,
    extractionSource: "live_fetch",
    structureStatus: "ok",
    structureSignals: [],
  };
}

function inspectGoogleSearchHtml(html: string): ExternalPageDiagnostics {
  const title = extractHtmlTitle(html);
  if (isLikelyChallengePage(title, html)) {
    return {
      structureStatus: "challenge",
      structureSignals: ["challenge_text_detected"],
    };
  }

  const text = stripHtmlToText(html).replace(/\s+/g, " ").trim();
  if (text.length < 200) {
    return {
      structureStatus: "thin_content",
      structureSignals: ["low_text_content"],
    };
  }

  const signals: string[] = [];
  const hasSearchForm =
    /name="q"/i.test(html) ||
    /aria-label="search"/i.test(html) ||
    /\bsearch\b/i.test(text);
  const hasResultLinks =
    /href="\/url\?/i.test(html) ||
    /<a[^>]+href="https?:\/\//i.test(html) ||
    /\\x3ca[^>]+href=\\?"\/url\?/i.test(html);
  const hasNoResults =
    /did not match any documents/i.test(text) ||
    /no results found/i.test(text) ||
    /try different keywords/i.test(text);

  if (hasSearchForm) {
    signals.push("search_form_detected");
  }
  if (hasResultLinks) {
    signals.push("result_links_detected");
  }
  if (hasNoResults) {
    signals.push("no_results_text_detected");
  }

  if (hasNoResults || hasResultLinks) {
    return {
      structureStatus: "ok",
      structureSignals: signals,
    };
  }

  if (hasSearchForm) {
    return {
      structureStatus: "layout_changed",
      structureSignals: [...signals, "no_expected_result_markup"],
    };
  }

  return {
    structureStatus: "thin_content",
    structureSignals: [...signals, "no_result_signals_detected"],
  };
}

function inspectBbbHtml(html: string): ExternalPageDiagnostics {
  const title = extractHtmlTitle(html);
  if (isLikelyChallengePage(title, html)) {
    return {
      structureStatus: "challenge",
      structureSignals: ["challenge_text_detected"],
    };
  }

  const text = stripHtmlToText(html).replace(/\s+/g, " ").trim();
  if (text.length < 150) {
    return {
      structureStatus: "thin_content",
      structureSignals: ["low_text_content"],
    };
  }

  const hasBbbBrand = /bbb\.org/i.test(html) || /\bbetter business bureau\b/i.test(text);
  const hasBusinessResultSignals =
    /\b(accredited business|customer reviews?|complaints?|bbb rating|business profile)\b/i.test(
      text
    );
  const hasSearchSignals =
    /\bfind\b/i.test(text) && /\bbusiness\b/i.test(text) ||
    /search/i.test(title ?? "");

  const signals: string[] = [];
  if (hasBbbBrand) {
    signals.push("bbb_brand_detected");
  }
  if (hasBusinessResultSignals) {
    signals.push("business_result_signals_detected");
  }
  if (hasSearchSignals) {
    signals.push("search_signals_detected");
  }

  if (hasBusinessResultSignals) {
    return {
      structureStatus: "ok",
      structureSignals: signals,
    };
  }

  if (hasBbbBrand || hasSearchSignals) {
    return {
      structureStatus: "layout_changed",
      structureSignals: [...signals, "no_expected_bbb_result_markup"],
    };
  }

  return {
    structureStatus: "thin_content",
    structureSignals: [...signals, "no_bbb_result_signals_detected"],
  };
}

function isUkCountry(value: string | null): boolean {
  const normalized = normalizeName(value ?? "");
  return (
    normalized === "uk" ||
    normalized === "united kingdom" ||
    normalized === "great britain"
  );
}

function isUsCountry(value: string | null): boolean {
  const normalized = normalizeName(value ?? "");
  return normalized === "us" || normalized === "usa" || normalized === "united states";
}

function isCaymanCountry(value: string | null): boolean {
  const normalized = normalizeName(value ?? "");
  return normalized === "cayman islands" || normalized === "cayman";
}

function isDelawareJurisdiction(
  incorporationCountry: string | null,
  incorporationState: string | null
): boolean {
  return isUsCountry(incorporationCountry) && normalizeStateToken(incorporationState) === "DE";
}

function normalizeStateToken(value: string | null): string | null {
  const normalized = normalizeName(value ?? "");
  switch (normalized) {
    case "de":
    case "delaware":
      return "DE";
    case "ny":
    case "new york":
      return "NY";
    case "ca":
    case "california":
      return "CA";
    case "nj":
    case "new jersey":
      return "NJ";
    default:
      return null;
  }
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ");
}

function extractHtmlTitle(html: string): string | null {
  return /<title>(.*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
}

function isLikelyChallengePage(title: string | null, html: string): boolean {
  const haystack = `${title ?? ""}\n${html}`.toLowerCase();
  return (
    haystack.includes("just a moment") ||
    haystack.includes("verify you are human") ||
    haystack.includes("enable javascript and cookies to continue") ||
    haystack.includes("your request originates from an undeclared automated tool") ||
    haystack.includes("attention required") ||
    haystack.includes("access denied")
  );
}

const KNOWN_ENTITY_SOURCE_HINTS: KnownEntitySourceHint[] = [
  {
    names: ["Offchain Labs"],
    websiteHosts: ["offchainlabs.com", "arbitrum.io"],
    evidenceCandidates: [
      {
        url: "https://arbitrum.io/tos",
        title: "Arbitrum Terms of Service",
        sourceId: "company_website",
        curatedPatch: {
          legalName: "Offchain Labs, Inc.",
          incorporationCountry: "US",
          incorporationState: "DE",
        },
        curatedRationale: [
          "curated mapping: official Arbitrum terms identify Offchain Labs, Inc.",
          "curated mapping: known entity routing for Offchain Labs uses Delaware official registry search",
        ],
      },
    ],
    registrySuggestions: [
      {
        label: "Delaware entity name search",
        url: "https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx",
        notes:
          "Search the exact entity name or file number to reach the Delaware detail record before moving to the official status path.",
        exactEntityName: "OFFCHAIN LABS, INC.",
        fileNumber: "7029386",
        purpose: "locate_entity",
        authorityUrl: "https://corp.delaware.gov/directweb/",
      },
    ],
  },
  {
    names: ["Uniswap Labs", "Uniswap"],
    websiteHosts: ["uniswap.org", "support.uniswap.org"],
    evidenceCandidates: [
      {
        url: "https://support.uniswap.org/hc/en-us/articles/43018872248589-API-Terms-of-Use",
        title: "Uniswap API Terms of Use",
        sourceId: "company_website",
        curatedPatch: {
          legalName: "Universal Navigation, Inc.",
        },
        curatedRationale: [
          "curated mapping: official Uniswap API terms identify Universal Navigation, Inc. dba Uniswap Labs",
        ],
      },
    ],
    registrySuggestions: [
      {
        label: "Delaware entity name search",
        url: "https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx",
        notes:
          "Search the exact entity name or file number to reach the Delaware detail record before moving to the official status path.",
        exactEntityName: "UNIVERSAL NAVIGATION INC.",
        fileNumber: "7053324",
        purpose: "locate_entity",
        authorityUrl: "https://corp.delaware.gov/directweb/",
      },
    ],
  },
  {
    names: ["OP Labs", "Optimism"],
    websiteHosts: ["optimism.io", "www.optimism.io"],
    evidenceCandidates: [
      {
        url: "https://www.optimism.io/blog/introducing-the-optimism-collective",
        title: "Optimism Collective Introduction",
        sourceId: "company_website",
        curatedPatch: {
          legalName: "OP Labs PBC",
          incorporationCountry: "US",
          incorporationState: "DE",
        },
        curatedRationale: [
          "curated mapping: official Optimism blog states the entity formerly known as Optimism PBC was renamed to OP Labs PBC",
          "curated mapping: official Delaware registry research identifies OP Labs PBC as a Delaware entity",
        ],
      },
    ],
    registrySuggestions: [
      {
        label: "Delaware entity name search",
        url: "https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx",
        notes:
          "Search the exact entity name or file number to reach the Delaware detail record before moving to the official status path.",
        exactEntityName: "OP LABS PBC",
        fileNumber: "7730305",
        purpose: "locate_entity",
        authorityUrl: "https://corp.delaware.gov/directweb/",
      },
    ],
  },
  {
    names: ["Flashbots"],
    websiteHosts: ["flashbots.net", "docs.flashbots.net", "collective.flashbots.net"],
    evidenceCandidates: [
      {
        url: "https://docs.flashbots.net/policies/terms-of-service",
        title: "Flashbots Terms of Service",
        sourceId: "company_website",
        curatedPatch: {
          legalName: "Flashbots Ltd.",
          incorporationCountry: "Cayman Islands",
        },
        curatedRationale: [
          "curated mapping: official Flashbots terms identify Flashbots Ltd.",
          "curated mapping: prior government filing research identifies Flashbots Ltd. as a Cayman Islands entity",
        ],
      },
    ],
    registrySuggestions: [
      {
        label: "Cayman company search",
        url: "https://online.ciregistry.gov.ky/",
        notes:
          "Search the exact Cayman entity name and capture the strongest available official output or access limitation encountered.",
        exactEntityName: "Flashbots Ltd.",
        purpose: "locate_entity",
        authorityUrl: "https://www.ciregistry.ky/online-tools/",
        requiresRegistration: true,
      },
      {
        label: "Delaware entity name search",
        url: "https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx",
        notes:
          "This related Delaware affiliate appears in official Delaware records. Confirm whether the counterparty contract or screening scope includes this affiliate before clearance.",
        exactEntityName: "FLASHBOTS US, LLC",
        fileNumber: "4174953",
        purpose: "locate_entity",
        authorityUrl: "https://corp.delaware.gov/directweb/",
      },
    ],
    entityStructure: {
      brand: "Flashbots",
      scopeNote:
        "The Flashbots brand appears to map to both a Cayman contracting entity and a Delaware affiliate. Reviewer confirmation is required to identify which legal entity is actually in scope for the transaction.",
      entities: [
        {
          legalName: "Flashbots Ltd.",
          jurisdiction: "Cayman Islands",
          role: "Official terms and government filing entity",
          registrySearchUrl: "https://online.ciregistry.gov.ky/",
          exactEntityName: "Flashbots Ltd.",
          sourceUrls: [
            "https://docs.flashbots.net/policies/terms-of-service",
            "https://www.ciregistry.ky/online-tools/",
            "https://www.sec.gov/Archives/edgar/data/1879282/000187928223000003/xslFormDX01/primary_doc.xml",
          ],
          notes: [
            "Official Flashbots terms identify Flashbots Ltd.",
            "An SEC filing also identifies Flashbots Ltd. in Cayman Islands context.",
          ],
        },
        {
          legalName: "FLASHBOTS US, LLC",
          jurisdiction: "DE, US",
          role: "Related Delaware affiliate appearing in official state registry",
          registrySearchUrl: "https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx",
          exactEntityName: "FLASHBOTS US, LLC",
          fileNumber: "4174953",
          sourceUrls: [
            "https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx",
            "https://corp.delaware.gov/directweb/",
          ],
          notes: [
            "Official Delaware search results show FLASHBOTS US, LLC with file number 4174953.",
          ],
        },
      ],
    },
  },
];

async function runOfacSearch(
  caseId: string,
  name: string,
  artifactStore: ArtifactStore
): Promise<{
  artifactIds: string[];
  resultCount: number;
}> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-http2", "--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: defaultUserAgent(),
    locale: "en-US",
  });
  const page = await context.newPage();

  try {
    await page.goto("https://sanctionssearch.ofac.treas.gov/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.fill("#ctl00_MainContent_txtLastName", name);
    await page.fill("#ctl00_MainContent_Slider1_Boundcontrol", "90");
    await page.click("#ctl00_MainContent_btnSearch");
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(
      () => undefined
    );
    await page.waitForTimeout(2_000);

    const html = await page.content();
    const screenshot = await page.screenshot({ fullPage: true }).catch(
      () => null
    );
    const pdf = await page.pdf({ format: "A4", printBackground: true }).catch(
      () => null
    );
    const rowCount = await page
      .locator("#ctl00_MainContent_gvSearchResults tr")
      .count()
      .catch(() => 0);

    const metadata = {
      query: name,
      minimumNameScore: 90,
      resultCount: rowCount,
      finalUrl: page.url(),
      title: await page.title().catch(() => null),
    };

    const artifacts: ArtifactRecord[] = [];
    artifacts.push(
      await artifactStore.saveArtifact({
        caseId,
        stepKey: "ofac_search",
        title: "OFAC Search HTML",
        sourceId: "ofac_search",
        sourceUrl: page.url(),
        fileName: "ofac-search.html",
        contentType: "text/html",
        body: html,
        category: "evidence",
        metadata: {
          ...metadata,
          captureType: "html",
        },
      })
    );

    if (screenshot) {
      artifacts.push(
        await artifactStore.saveArtifact({
          caseId,
          stepKey: "ofac_search",
          title: "OFAC Search Screenshot",
          sourceId: "ofac_search",
          sourceUrl: page.url(),
          fileName: "ofac-search.png",
          contentType: "image/png",
          body: screenshot,
          category: "evidence",
          metadata: {
            ...metadata,
            captureType: "screenshot",
          },
        })
      );
    }

    if (pdf) {
      artifacts.push(
        await artifactStore.saveArtifact({
          caseId,
          stepKey: "ofac_search",
          title: "OFAC Search PDF",
          sourceId: "ofac_search",
          sourceUrl: page.url(),
          fileName: "ofac-search.pdf",
          contentType: "application/pdf",
          body: pdf,
          category: "evidence",
          metadata: {
            ...metadata,
            captureType: "pdf",
          },
        })
      );
    }

    return {
      artifactIds: artifacts.map((artifact) => artifact.id),
      resultCount: rowCount,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

function defaultUserAgent(): string {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
}

async function tryWebApiSearch(
  context: ConnectorContext,
  query: string,
  offset: number,
  url: string,
  counterpartyName: string,
  evidenceIds: string[],
  pageSummaries: ReputationSearchPageSummary[],
  pageNumber: number
): Promise<boolean> {
  if (!context.webSearchClient) {
    return false;
  }

  try {
    const apiResults = await context.webSearchClient.search(query, offset);
    const ignoredKeywords = deriveIgnoredAdverseKeywords(query, counterpartyName);
    const hits: SearchHitSummary[] = apiResults.map((result) => {
      let domain: string | null = null;
      try {
        domain = new URL(result.link).hostname;
      } catch { /* ignore */ }
      return {
        title: result.title,
        url: result.link,
        domain,
        snippet: result.snippet || null,
        adverseKeywords: extractAdverseKeywords(
          `${result.title} ${result.snippet}`,
          ignoredKeywords
        ),
      };
    });

    const summaryArtifact = await context.artifactStore.saveArtifact({
      caseId: context.snapshot.caseRecord.id,
      stepKey: "reputation_search",
      title: `Web Search: ${query} page ${pageNumber}`,
      sourceId: "google_search",
      sourceUrl: url,
      fileName: `web-search-${slugify(query)}-page${pageNumber}.json`,
      contentType: "application/json",
      body: JSON.stringify({ query, pageNumber, offset, results: apiResults }, null, 2),
      category: "evidence",
      metadata: { searchMode: "web_api", query, pageNumber },
    });

    evidenceIds.push(summaryArtifact.id);
    pageSummaries.push({
      query,
      pageNumber,
      url,
      extractedResultCount: hits.length,
      likelyAdverseCount: hits.filter((hit) => hit.adverseKeywords.length > 0).length,
      extractionSource: "captured_html",
      fetchError: null,
      captureError: null,
      structureStatus: "ok",
      structureSignals: ["google_api"],
      results: hits.slice(0, 8),
    });

    return true;
  } catch (error) {
    console.error(`Google API search failed for "${query}" page ${pageNumber}`, error);
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function isExpired(isoTimestamp: string, ttlMs: number): boolean {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) {
    return true;
  }

  return Date.now() - parsed > ttlMs;
}
