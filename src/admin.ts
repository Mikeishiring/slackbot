import { copyFile, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ArtifactStore } from "./artifacts.js";
import type {
  ArtifactRecord,
  AuditEventRecord,
  CaseExportResult,
  CaseSnapshot,
  HealthSnapshot,
  RetentionPruneResult,
} from "./types.js";
import { ensureDirectory, formatJson, parseJson, slugify } from "./utils.js";

export class LocalCaseExporter {
  public constructor(
    private readonly artifactStore: ArtifactStore,
    private readonly exportRoot: string
  ) {}

  public async exportCase(
    snapshot: CaseSnapshot,
    auditEvents: AuditEventRecord[]
  ): Promise<CaseExportResult> {
    const bundleDirectory = join(
      this.exportRoot,
      `${snapshot.caseRecord.id}-${slugify(snapshot.caseRecord.displayName)}`
    );
    const artifactsDirectory = join(bundleDirectory, "artifacts");
    const reportsDirectory = join(bundleDirectory, "reports");

    await ensureDirectory(bundleDirectory);
    await ensureDirectory(artifactsDirectory);
    await ensureDirectory(reportsDirectory);

    const artifactEntries = await Promise.all(
      snapshot.artifacts.map(async (artifact) => {
        const sourcePath = this.artifactStore.resolveAbsolutePath(artifact);
        const targetDirectory =
          artifact.storageBackend === "local-report" ? reportsDirectory : artifactsDirectory;
        const targetPath = join(targetDirectory, basename(sourcePath));
        await copyFile(sourcePath, targetPath);

        return buildArtifactManifestEntry(artifact, targetPath);
      })
    );

    const snapshotPath = join(bundleDirectory, "snapshot.json");
    const manifestPath = join(bundleDirectory, "manifest.json");
    const readmePath = join(bundleDirectory, "README.md");

    await writeFile(
      snapshotPath,
      formatJson({
        snapshot,
        auditEvents,
      }),
      "utf8"
    );
    await writeFile(
      manifestPath,
      formatJson({
        caseId: snapshot.caseRecord.id,
        displayName: snapshot.caseRecord.displayName,
        generatedAt: new Date().toISOString(),
        artifacts: artifactEntries,
      }),
      "utf8"
    );
    await writeFile(
      readmePath,
      renderBundleReadme(snapshot, artifactEntries),
      "utf8"
    );

    return {
      caseId: snapshot.caseRecord.id,
      bundleDirectory,
      manifestPath,
    };
  }

  public async pruneExportsBefore(cutoff: string): Promise<number> {
    try {
      const entries = await readdir(this.exportRoot, { withFileTypes: true });
      let deleted = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const bundleDirectory = join(this.exportRoot, entry.name);
        const manifestPath = join(bundleDirectory, "manifest.json");
        let generatedAt: string | null = null;

        try {
          const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
            generatedAt?: unknown;
          };
          generatedAt =
            typeof manifest.generatedAt === "string" ? manifest.generatedAt : null;
        } catch {
          const stats = await stat(bundleDirectory);
          generatedAt = stats.mtime.toISOString();
        }

        if (generatedAt != null && generatedAt < cutoff) {
          await rm(bundleDirectory, { recursive: true, force: true });
          deleted += 1;
        }
      }

      return deleted;
    } catch (error) {
      if (isMissingDirectoryError(error)) {
        return 0;
      }
      throw error;
    }
  }
}

export function formatHealthSnapshot(snapshot: HealthSnapshot): string {
  return [
    `Generated: ${snapshot.generatedAt}`,
    `Cases: ${formatCountMap(snapshot.caseCounts)}`,
    `Open issues: ${formatCountMap(snapshot.openIssueCounts)}`,
    `Open review tasks: ${snapshot.openReviewTaskCount}`,
    `Jobs: ${formatCountMap(snapshot.jobCounts)}`,
    `Latest case update: ${snapshot.latestCaseUpdateAt ?? "none"}`,
  ].join("\n");
}

export function formatRetentionPruneResult(result: RetentionPruneResult): string {
  return [
    `Retention prune completed.`,
    `Generated: ${result.generatedAt}`,
    `Retention days: ${result.retentionDays}`,
    `Cutoff: ${result.cutoff}`,
    `Deleted messages: ${result.deletedMessages}`,
    `Deleted audit events: ${result.deletedAuditEvents}`,
    `Deleted artifacts: ${result.deletedArtifacts}`,
    `Deleted reports: ${result.deletedReports}`,
    `Deleted exports: ${result.deletedExports}`,
  ].join("\n");
}

type ArtifactManifestEntry = {
  id: string;
  stepKey: ArtifactRecord["stepKey"];
  title: string;
  contentType: string;
  sourceId: string | null;
  sourceUrl: string | null;
  bundlePath: string;
  metadata: Record<string, unknown>;
};

function buildArtifactManifestEntry(
  artifact: ArtifactRecord,
  bundlePath: string
): ArtifactManifestEntry {
  return {
    id: artifact.id,
    stepKey: artifact.stepKey,
    title: artifact.title,
    contentType: artifact.contentType,
    sourceId: artifact.sourceId,
    sourceUrl: artifact.sourceUrl,
    bundlePath,
    metadata: parseJson<Record<string, unknown>>(artifact.metadataJson, {}),
  };
}

function renderBundleReadme(
  snapshot: CaseSnapshot,
  artifacts: ArtifactManifestEntry[]
): string {
  return [
    `# Case Export`,
    ``,
    `- Case ID: ${snapshot.caseRecord.id}`,
    `- Counterparty: ${snapshot.caseRecord.displayName}`,
    `- Status: ${snapshot.caseRecord.caseStatus}`,
    `- Recommendation: ${snapshot.caseRecord.recommendation}`,
    `- Exported At: ${new Date().toISOString()}`,
    ``,
    `## Contents`,
    `- \`snapshot.json\`: canonical case snapshot plus audit events`,
    `- \`manifest.json\`: artifact manifest with metadata`,
    `- \`artifacts/\`: copied evidence artifacts`,
    `- \`reports/\`: copied generated reports including the reviewer packet and stage reports`,
    ``,
    `## Artifact Summary`,
    artifacts.length === 0
      ? `- None`
      : artifacts.map((artifact) => `- ${artifact.id}: ${artifact.title} [${artifact.stepKey}]`).join("\n"),
  ].join("\n");
}

function formatCountMap(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function isMissingDirectoryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
