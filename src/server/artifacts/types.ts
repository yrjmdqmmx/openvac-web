import type {
  ArtifactFormat,
  ArtifactKind,
  ArtifactPart,
  ArtifactSpec,
  ArtifactStatus
} from "@/types/chat-v3";

export const ARTIFACT_CONTENT_TYPES: Record<ArtifactFormat, string> = {
  md: "text/markdown; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  csv: "text/csv; charset=utf-8"
};

export type RenderedArtifactFile = {
  format: ArtifactFormat;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
};

export type ArtifactFileRecord = {
  format: ArtifactFormat;
  filename: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  objectKey: string;
  createdAt: Date;
};

export type ArtifactDownloadMetadata = Omit<
  ArtifactFileRecord,
  "objectKey" | "createdAt"
> & {
  artifactId: string;
  downloadPath: string;
  createdAt: string;
};

export type ArtifactDownloadTarget = {
  metadata: ArtifactDownloadMetadata;
  objectKey: string;
};

export type ArtifactFailureCode =
  | "VALIDATION_FAILED"
  | "RENDER_FAILED"
  | "STORAGE_FAILED"
  | "REPOSITORY_FAILED";

export type ArtifactRecord = {
  artifactId: string;
  ownerId: string;
  conversationId: string;
  sourceTurnId: string;
  kind: ArtifactKind;
  title: string;
  formats: ArtifactFormat[];
  status: ArtifactStatus;
  files: ArtifactFileRecord[];
  failureCode?: ArtifactFailureCode;
  createdAt: Date;
  updatedAt: Date;
};

export interface ArtifactRepository {
  createGenerating(
    record: Omit<ArtifactRecord, "status" | "files">
  ): Promise<void>;
  markReady(
    artifactId: string,
    files: ArtifactFileRecord[],
    updatedAt: Date
  ): Promise<void>;
  markFailed(
    artifactId: string,
    failureCode: ArtifactFailureCode,
    updatedAt: Date
  ): Promise<void>;
  findOwned(
    artifactId: string,
    ownerId: string
  ): Promise<ArtifactRecord | null>;
  findOwnedDownload(
    artifactId: string,
    ownerId: string,
    format: ArtifactFormat
  ): Promise<ArtifactDownloadTarget | null>;
  markDeleted(
    artifactId: string,
    ownerId: string,
    updatedAt: Date
  ): Promise<boolean>;
}

export interface ArtifactObjectStore {
  put(input: {
    objectKey: string;
    bytes: Uint8Array;
    contentType: string;
    checksumSha256: string;
  }): Promise<void>;
  delete(objectKey: string): Promise<void>;
}

export interface ArtifactRenderer {
  render(spec: ArtifactSpec): Promise<RenderedArtifactFile[]>;
}

export type ArtifactGenerationRequest = {
  artifactId: string;
  ownerId: string;
  conversationId: string;
  spec: unknown;
};

export type ArtifactGenerationResult = {
  artifact: ArtifactPart;
  downloads: ArtifactDownloadMetadata[];
  failureCode?: ArtifactFailureCode;
};
