import { createHash } from "node:crypto";

import { z } from "zod";

import { ApiError } from "@/server/api/errors";
import type {
  ObjectStorage,
  PrivateObjectStat,
  PrivateUploadUrl
} from "@/server/providers";

import {
  KNOWLEDGE_FILE_MIME_BY_EXTENSION,
  MAX_KNOWLEDGE_ORIGINAL_BYTES
} from "./review-policy";

const uploadInputSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(2_000).optional(),
    sourceUrl: z.url().max(2_048).optional(),
    filename: z.string().trim().min(1).max(255),
    contentType: z.enum(Object.values(KNOWLEDGE_FILE_MIME_BY_EXTENSION)),
    sizeBytes: z.number().int().positive().max(MAX_KNOWLEDGE_ORIGINAL_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    uploadedBy: z.string().trim().min(1).max(128)
  })
  .superRefine((input, context) => {
    const extension = fileExtension(input.filename);
    if (
      !extension ||
      !(extension in KNOWLEDGE_FILE_MIME_BY_EXTENSION) ||
      KNOWLEDGE_FILE_MIME_BY_EXTENSION[
        extension as keyof typeof KNOWLEDGE_FILE_MIME_BY_EXTENSION
      ] !== input.contentType
    ) {
      context.addIssue({
        code: "custom",
        path: ["contentType"],
        message: "文件扩展名与内容类型不匹配。"
      });
    }
  });

export type InitiateKnowledgeOriginalUploadInput = {
  title: string;
  description?: string;
  sourceUrl?: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: string;
};

export type KnowledgeOriginalUploadDraftInput = {
  documentId: string;
  versionId: string;
  title: string;
  description?: string;
  sourceUrl?: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  objectKey: string;
  uploadedBy: string;
  retentionPolicy: "retain_indefinitely";
};

export type KnowledgeOriginalUploadDraft = {
  documentId: string;
  versionId: string;
  objectKey: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  retentionPolicy: "retain_indefinitely";
  status: "processing";
};

export type CurrentKnowledgeOriginalUpload = Omit<
  KnowledgeOriginalUploadDraft,
  "retentionPolicy" | "status"
> & {
  uploadedBy: string;
};

export type KnowledgeIngestionQueueState = {
  taskId: string;
  taskStatus: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  documentId: string;
  versionId: string;
  stage: "ocr_pending";
};

export interface KnowledgeOriginalUploadRepository {
  initiate(
    input: KnowledgeOriginalUploadDraftInput
  ): Promise<KnowledgeOriginalUploadDraft>;
  complete(
    versionId: string,
    uploadedBy: string,
    verify: (target: CurrentKnowledgeOriginalUpload) => Promise<void>
  ): Promise<KnowledgeIngestionQueueState>;
}

type UuidSource = {
  randomUUID(): `${string}-${string}-${string}-${string}-${string}` | string;
};

export class KnowledgeOriginalUploadService {
  constructor(
    private readonly repository: KnowledgeOriginalUploadRepository,
    private readonly storage: ObjectStorage,
    private readonly uuidSource: UuidSource = crypto
  ) {}

  async initiate(input: InitiateKnowledgeOriginalUploadInput): Promise<
    KnowledgeOriginalUploadDraft & { upload: PrivateUploadUrl }
  > {
    this.assertStorageCapabilities();
    const parsed = parseUploadInput(input);
    const documentId = this.uuidSource.randomUUID();
    const versionId = this.uuidSource.randomUUID();
    const originalFilename = displayFilename(parsed.filename);
    const sanitizedFilename = sanitizeKnowledgeOriginalFilename(
      originalFilename
    );
    const objectKey =
      `private/knowledge-originals/${documentId}/${versionId}/` +
      sanitizedFilename;

    const upload = await this.storage.createPrivateUploadUrl!({
      key: objectKey,
      contentType: parsed.contentType,
      contentLength: parsed.sizeBytes,
      checksumSha256: parsed.sha256,
      metadata: {
        sha256: parsed.sha256,
        "size-bytes": String(parsed.sizeBytes)
      },
      expiresSeconds: 900
    });
    assertHeaderBoundUpload(upload, {
      objectKey,
      contentType: parsed.contentType,
      sizeBytes: parsed.sizeBytes,
      sha256: parsed.sha256
    });

    const draft = await this.repository.initiate({
      documentId,
      versionId,
      title: parsed.title,
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parsed.sourceUrl ? { sourceUrl: parsed.sourceUrl } : {}),
      originalFilename,
      mimeType: parsed.contentType,
      sizeBytes: parsed.sizeBytes,
      sha256: parsed.sha256,
      objectKey,
      uploadedBy: parsed.uploadedBy,
      retentionPolicy: "retain_indefinitely"
    });
    return { ...draft, upload };
  }

  async complete(input: {
    versionId: string;
    uploadedBy: string;
  }): Promise<KnowledgeIngestionQueueState> {
    this.assertStorageCapabilities();
    return this.repository.complete(
      input.versionId,
      input.uploadedBy,
      async (target) => {
        const stat = await this.storage.statPrivate!(target.objectKey);
        const bytes = await this.storage.getPrivate(target.objectKey);
        assertStoredObjectMatches(target, stat, bytes);
      }
    );
  }

  private assertStorageCapabilities(): void {
    if (
      typeof this.storage.createPrivateUploadUrl !== "function" ||
      typeof this.storage.statPrivate !== "function"
    ) {
      throw new ApiError(
        503,
        "KNOWLEDGE_UPLOAD_UNAVAILABLE",
        "知识原件上传服务当前不可用。"
      );
    }
  }
}

export function sanitizeKnowledgeOriginalFilename(filename: string): string {
  const base = displayFilename(filename).normalize("NFKD");
  const extension = fileExtension(base)?.toLowerCase() ?? "bin";
  const stem = base.slice(0, -(extension.length + 1));
  const safeStem = stem
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 160);
  return `${safeStem || "upload"}.${extension}`;
}

function displayFilename(filename: string): string {
  const segments = filename.replaceAll("\\", "/").split("/");
  return segments.findLast((segment) => segment && segment !== "..") ?? "upload";
}

function fileExtension(filename: string): string | null {
  const base = displayFilename(filename);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

function parseUploadInput(
  input: InitiateKnowledgeOriginalUploadInput
): z.output<typeof uploadInputSchema> {
  const result = uploadInputSchema.safeParse(input);
  if (!result.success) {
    throw new ApiError(
      422,
      "KNOWLEDGE_UPLOAD_INVALID",
      "知识原件不符合上传要求。",
      result.error.issues
    );
  }
  return result.data;
}

function assertHeaderBoundUpload(
  upload: PrivateUploadUrl,
  expected: {
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }
): void {
  const headers = lowerCaseRecord(upload.requiredHeaders);
  if (
    upload.method !== "PUT" ||
    upload.key !== expected.objectKey ||
    headers["content-type"] !== expected.contentType ||
    headers["content-length"] !== String(expected.sizeBytes) ||
    headers["x-oss-forbid-overwrite"] !== "true" ||
    headers["x-oss-meta-sha256"] !== expected.sha256
  ) {
    throw new ApiError(
      503,
      "KNOWLEDGE_UPLOAD_UNAVAILABLE",
      "对象存储未返回受约束的私有上传地址。"
    );
  }
}

function assertStoredObjectMatches(
  target: CurrentKnowledgeOriginalUpload,
  stat: PrivateObjectStat,
  bytes: Uint8Array
): void {
  const metadata = lowerCaseRecord(stat.metadata);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    stat.key !== target.objectKey ||
    stat.sizeBytes !== target.sizeBytes ||
    stat.contentType?.toLowerCase() !== target.mimeType.toLowerCase() ||
    metadata.sha256 !== target.sha256 ||
    actualSha256 !== target.sha256
  ) {
    throw new ApiError(
      409,
      "KNOWLEDGE_UPLOAD_MISMATCH",
      "已上传原件与登记信息不一致，请重新发起上传。"
    );
  }
}

function lowerCaseRecord(
  input: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key.toLowerCase(), value])
  );
}
