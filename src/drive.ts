import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { google } from "googleapis";
import type { drive_v3 } from "googleapis";

import type { ArtifactRecord, CaseSnapshot, ReportRecord } from "./types.js";
import type { ArtifactStore } from "./artifacts.js";

export interface DriveUploader {
  uploadReport(
    snapshot: CaseSnapshot,
    report: ReportRecord,
    artifact: ArtifactRecord,
    artifactStore: ArtifactStore
  ): Promise<{ fileId: string; webViewLink: string }>;
}

export class GoogleDriveUploader implements DriveUploader {
  private readonly drive: drive_v3.Drive;
  private readonly rootFolderId: string;
  private readonly folderCache = new Map<string, string>();

  public constructor(serviceAccountKeyPath: string, rootFolderId: string) {
    const keyFile = JSON.parse(readFileSync(serviceAccountKeyPath, "utf8")) as {
      client_email: string;
      private_key: string;
    };

    const auth = new google.auth.JWT({
      email: keyFile.client_email,
      key: keyFile.private_key,
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });

    this.drive = google.drive({ version: "v3", auth });
    this.rootFolderId = rootFolderId;
  }

  public async uploadReport(
    snapshot: CaseSnapshot,
    report: ReportRecord,
    artifact: ArtifactRecord,
    artifactStore: ArtifactStore
  ): Promise<{ fileId: string; webViewLink: string }> {
    const caseFolderId = await this.ensureCaseFolder(snapshot);

    const filePath = artifactStore.resolveAbsolutePath(artifact);
    const fileBuffer = readFileSync(filePath);

    const fileName = buildDriveFileName(snapshot, report, artifact);

    const response = await this.drive.files.create({
      requestBody: {
        name: fileName,
        parents: [caseFolderId],
        mimeType: artifact.contentType,
      },
      media: {
        mimeType: artifact.contentType,
        body: bufferToStream(fileBuffer),
      },
      fields: "id, webViewLink",
    });

    return {
      fileId: response.data.id ?? "",
      webViewLink: response.data.webViewLink ?? "",
    };
  }

  private async ensureCaseFolder(snapshot: CaseSnapshot): Promise<string> {
    const folderName = snapshot.caseRecord.displayName;
    const cached = this.folderCache.get(folderName);
    if (cached) {
      return cached;
    }

    // Check if folder exists
    const existing = await this.drive.files.list({
      q: `name='${escapeDriveQuery(folderName)}' and '${this.rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id)",
      spaces: "drive",
    });

    if (existing.data.files && existing.data.files.length > 0 && existing.data.files[0]?.id) {
      this.folderCache.set(folderName, existing.data.files[0].id);
      return existing.data.files[0].id;
    }

    // Create folder
    const folder = await this.drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [this.rootFolderId],
      },
      fields: "id",
    });

    const folderId = folder.data.id ?? "";
    this.folderCache.set(folderName, folderId);
    return folderId;
  }
}

function buildDriveFileName(
  snapshot: CaseSnapshot,
  report: ReportRecord,
  artifact: ArtifactRecord
): string {
  const date = new Date().toISOString().split("T")[0] ?? "unknown";
  const ext = artifact.contentType === "application/pdf" ? ".pdf"
    : artifact.contentType === "text/markdown" ? ".md"
    : artifact.contentType === "application/json" ? ".json"
    : "";

  const reportLabel = report.kind === "final" ? "Vetting Report"
    : report.kind === "review_packet" ? "Reviewer Packet"
    : report.kind === "working" ? "Working Report"
    : report.kind === "traceability" ? "Traceability"
    : report.kind;

  return `${date} ${reportLabel} v${report.versionNumber}${ext}`;
}

function escapeDriveQuery(value: string): string {
  return value.replace(/'/g, "\\'");
}

function bufferToStream(buffer: Buffer): Readable {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}
