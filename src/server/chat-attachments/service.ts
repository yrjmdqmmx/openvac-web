import { createHash } from "node:crypto";

import { z } from "zod";

import { ApiError, notFound } from "@/server/api/errors";
import {
  CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE
} from "@/server/chat-v3/contracts";
import {
  ProviderError,
  type ObjectStorage,
  type PrivateObjectStat,
  type PrivateUploadUrl
} from "@/server/providers";
import type { AttachmentKind, AttachmentStatus } from "@/types/chat-v3";

const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const ORPHAN_UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;
const ACCESS_URL_TTL_SECONDS = 5 * 60;

const MIME_BY_EXTENSION = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png"
} as const;

const initiateSchema = z
  .object({
    conversationId: z.string().uuid(),
    filename: z.string().trim().min(1).max(255),
    mimeType: z.enum(CHAT_ATTACHMENT_MIME_TYPES),
    sizeBytes: z.number().int().positive().max(MAX_CHAT_ATTACHMENT_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u)
  })
  .superRefine((input, context) => {
    const extension = fileExtension(input.filename);
    if (!extension || MIME_BY_EXTENSION[extension] !== input.mimeType) {
      context.addIssue({
        code: "custom",
        path: ["mimeType"],
        message: "文件扩展名与内容类型不匹配。"
      });
    }
  });

export type ChatAttachmentParseStatus =
  "not_required" | "queued" | "processing" | "ready" | "failed";

export type ChatAttachmentView = {
  id: string;
  conversationId: string;
  messageId: string | null;
  kind: AttachmentKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: AttachmentStatus;
  parseStatus: ChatAttachmentParseStatus;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
};

export type ChatAttachmentTarget = ChatAttachmentView & {
  userId: string;
  objectKey: string;
  declaredSizeBytes: number;
  sha256: string;
  quotaState: "reserved" | "committed" | "released";
  deletionStatus: "active" | "queued" | "deleting" | "deleted" | "failed";
};

export type InitiateChatAttachmentInput = {
  conversationId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  userId: string;
};

export interface ChatAttachmentRepository {
  initiate(input: {
    id: string;
    userId: string;
    conversationId: string;
    kind: AttachmentKind;
    filename: string;
    mimeType: string;
    declaredSizeBytes: number;
    sha256: string;
    objectKey: string;
    uploadExpiresAt: Date;
    orphanExpiresAt: Date;
  }): Promise<ChatAttachmentView>;
  beginCompletion(
    attachmentId: string,
    userId: string
  ): Promise<ChatAttachmentTarget & { alreadyComplete: boolean }>;
  completeVerified(input: {
    attachmentId: string;
    userId: string;
    sizeBytes: number;
    etag?: string;
  }): Promise<ChatAttachmentView>;
  resetCompletion(attachmentId: string, userId: string): Promise<void>;
  rejectCompletion(
    attachmentId: string,
    userId: string,
    code: string,
    message: string
  ): Promise<void>;
  findOwned(
    attachmentId: string,
    userId: string
  ): Promise<ChatAttachmentView | null>;
  findOwnedObject(
    attachmentId: string,
    userId: string
  ): Promise<ChatAttachmentTarget | null>;
  bindToMessage(input: {
    attachmentIds: string[];
    conversationId: string;
    messageId: string;
    userId: string;
  }): Promise<ChatAttachmentView[]>;
}

type UuidSource = { randomUUID(): string };
type Clock = () => Date;

export class ChatAttachmentService {
  constructor(
    private readonly repository: ChatAttachmentRepository,
    private readonly storage: ObjectStorage,
    private readonly uuidSource: UuidSource = crypto,
    private readonly now: Clock = () => new Date()
  ) {}

  async initiate(
    input: InitiateChatAttachmentInput
  ): Promise<ChatAttachmentView & { upload: PrivateUploadUrl }> {
    this.assertUploadCapabilities();
    const parsed = parseInitiateInput(input);
    const id = this.uuidSource.randomUUID();
    const filename = displayFilename(parsed.filename);
    const kind: AttachmentKind = parsed.mimeType.startsWith("image/")
      ? "image"
      : "document";
    const objectKey = attachmentObjectKey({
      attachmentId: id,
      conversationId: parsed.conversationId,
      filename,
      userId: parsed.userId
    });
    const startedAt = this.now();
    const upload = await this.storage.createPrivateUploadUrl!({
      key: objectKey,
      contentType: parsed.mimeType,
      contentLength: parsed.sizeBytes,
      checksumSha256: parsed.sha256,
      metadata: {
        "attachment-id": id,
        sha256: parsed.sha256,
        "size-bytes": String(parsed.sizeBytes)
      },
      expiresSeconds: UPLOAD_URL_TTL_SECONDS
    });
    assertHeaderBoundUpload(upload, {
      attachmentId: id,
      objectKey,
      mimeType: parsed.mimeType,
      sizeBytes: parsed.sizeBytes,
      sha256: parsed.sha256
    });

    const attachment = await this.repository.initiate({
      id,
      userId: parsed.userId,
      conversationId: parsed.conversationId,
      kind,
      filename,
      mimeType: parsed.mimeType,
      declaredSizeBytes: parsed.sizeBytes,
      sha256: parsed.sha256,
      objectKey,
      uploadExpiresAt: new Date(
        startedAt.getTime() + UPLOAD_URL_TTL_SECONDS * 1_000
      ),
      orphanExpiresAt: new Date(startedAt.getTime() + ORPHAN_UPLOAD_TTL_MS)
    });
    return { ...attachment, upload };
  }

  async complete(input: {
    attachmentId: string;
    userId: string;
  }): Promise<ChatAttachmentView> {
    this.assertUploadCapabilities();
    const target = await this.repository.beginCompletion(
      input.attachmentId,
      input.userId
    );
    if (target.alreadyComplete) {
      return publicView(target);
    }

    try {
      const stat = await this.storage.statPrivate!(target.objectKey);
      assertStoredObjectMetadata(target, stat);
      const bytes = await this.storage.getPrivate(target.objectKey);
      assertStoredObjectMatches(target, stat, bytes);
      return await this.repository.completeVerified({
        attachmentId: target.id,
        userId: input.userId,
        sizeBytes: bytes.byteLength,
        ...(stat.etag ? { etag: stat.etag } : {})
      });
    } catch (error) {
      if (error instanceof ApiError) {
        await this.repository.rejectCompletion(
          target.id,
          input.userId,
          error.code,
          error.message
        );
        throw error;
      }
      await this.repository.resetCompletion(target.id, input.userId);
      if (error instanceof ProviderError) {
        throw new ApiError(
          error.status === 404 ? 409 : 503,
          error.status === 404
            ? "ATTACHMENT_UPLOAD_INCOMPLETE"
            : "ATTACHMENT_STORAGE_UNAVAILABLE",
          error.status === 404
            ? "附件尚未上传完成，请稍后重试。"
            : "附件存储服务暂时不可用。"
        );
      }
      throw error;
    }
  }

  async status(input: {
    attachmentId: string;
    userId: string;
  }): Promise<ChatAttachmentView> {
    const attachment = await this.repository.findOwned(
      input.attachmentId,
      input.userId
    );
    if (!attachment) throw notFound("附件");
    return attachment;
  }

  async createAccessUrl(input: {
    attachmentId: string;
    userId: string;
  }): Promise<string> {
    const attachment = await this.repository.findOwnedObject(
      input.attachmentId,
      input.userId
    );
    if (
      !attachment ||
      attachment.quotaState !== "committed" ||
      attachment.deletionStatus !== "active"
    ) {
      throw notFound("附件");
    }
    const signedUrl = await this.storage.createPrivateDownloadUrl(
      attachment.objectKey,
      ACCESS_URL_TTL_SECONDS
    );
    assertShortLivedHttpsUrl(signedUrl);
    return signedUrl;
  }

  async bindToMessage(input: {
    attachmentIds: string[];
    conversationId: string;
    messageId: string;
    userId: string;
  }): Promise<ChatAttachmentView[]> {
    const ids = [...new Set(input.attachmentIds)];
    if (
      ids.length !== input.attachmentIds.length ||
      ids.length < 1 ||
      ids.length > MAX_CHAT_ATTACHMENTS_PER_MESSAGE
    ) {
      throw new ApiError(
        422,
        "ATTACHMENT_BIND_INVALID",
        `每条消息只能绑定 1 至 ${MAX_CHAT_ATTACHMENTS_PER_MESSAGE} 个不重复附件。`
      );
    }
    return this.repository.bindToMessage({ ...input, attachmentIds: ids });
  }

  private assertUploadCapabilities(): void {
    if (
      typeof this.storage.createPrivateUploadUrl !== "function" ||
      typeof this.storage.statPrivate !== "function"
    ) {
      throw new ApiError(
        503,
        "ATTACHMENT_STORAGE_UNAVAILABLE",
        "附件存储服务暂时不可用。"
      );
    }
  }
}

export function sanitizeChatAttachmentFilename(filename: string): string {
  const base = displayFilename(filename).normalize("NFKD");
  const extension = fileExtension(base) ?? "bin";
  const stem = base.slice(0, -(extension.length + 1));
  const safeStem = stem
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  return `${safeStem || "attachment"}.${extension}`;
}

function parseInitiateInput(input: InitiateChatAttachmentInput) {
  const result = initiateSchema.safeParse(input);
  if (!result.success) {
    throw new ApiError(
      422,
      "ATTACHMENT_INVALID",
      "附件不符合上传要求。",
      result.error.issues
    );
  }
  return { ...result.data, userId: input.userId };
}

function attachmentObjectKey(input: {
  attachmentId: string;
  conversationId: string;
  filename: string;
  userId: string;
}): string {
  const userPartition = createHash("sha256")
    .update(input.userId)
    .digest("hex")
    .slice(0, 24);
  return (
    `private/chat-attachments/${userPartition}/${input.conversationId}/` +
    `${input.attachmentId}/${sanitizeChatAttachmentFilename(input.filename)}`
  );
}

function assertHeaderBoundUpload(
  upload: PrivateUploadUrl,
  expected: {
    attachmentId: string;
    objectKey: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  }
): void {
  const headers = lowerCaseRecord(upload.requiredHeaders);
  if (
    upload.method !== "PUT" ||
    upload.key !== expected.objectKey ||
    headers["content-type"] !== expected.mimeType ||
    headers["x-oss-object-acl"] !== "private" ||
    headers["x-oss-forbid-overwrite"] !== "true" ||
    headers["x-oss-meta-attachment-id"] !== expected.attachmentId ||
    headers["x-oss-meta-size-bytes"] !== String(expected.sizeBytes) ||
    headers["x-oss-meta-sha256"] !== expected.sha256
  ) {
    throw new ApiError(
      503,
      "ATTACHMENT_STORAGE_UNAVAILABLE",
      "对象存储未返回受约束的私有上传地址。"
    );
  }
}

function assertStoredObjectMatches(
  target: ChatAttachmentTarget,
  stat: PrivateObjectStat,
  bytes: Uint8Array
): void {
  assertStoredObjectMetadata(target, stat);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.byteLength !== target.declaredSizeBytes ||
    actualSha256 !== target.sha256 ||
    !bytesMatchMime(bytes, target.mimeType)
  ) {
    throw new ApiError(
      409,
      "ATTACHMENT_UPLOAD_MISMATCH",
      "已上传附件与登记信息不一致，请重新发起上传。"
    );
  }
}

function assertStoredObjectMetadata(
  target: ChatAttachmentTarget,
  stat: PrivateObjectStat
): void {
  const metadata = lowerCaseRecord(stat.metadata);
  const contentType = stat.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    stat.key !== target.objectKey ||
    stat.sizeBytes !== target.declaredSizeBytes ||
    stat.sizeBytes > MAX_CHAT_ATTACHMENT_BYTES ||
    contentType !== target.mimeType.toLowerCase() ||
    metadata["attachment-id"] !== target.id ||
    metadata.sha256 !== target.sha256 ||
    metadata["size-bytes"] !== String(target.declaredSizeBytes)
  ) {
    throw new ApiError(
      409,
      "ATTACHMENT_UPLOAD_MISMATCH",
      "已上传附件与登记信息不一致，请重新发起上传。"
    );
  }
}

function bytesMatchMime(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "application/pdf") {
    return asciiPrefix(bytes, "%PDF-");
  }
  if (mimeType === "image/png") {
    return [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value
    );
  }
  if (mimeType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return false;
    const archiveIndex = new TextDecoder("latin1").decode(bytes);
    return mimeType.includes("wordprocessingml")
      ? archiveIndex.includes("word/")
      : archiveIndex.includes("xl/");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.length > 0 && !text.includes("\0");
  } catch {
    return false;
  }
}

function asciiPrefix(bytes: Uint8Array, prefix: string): boolean {
  return [...prefix].every(
    (character, index) => bytes[index] === character.charCodeAt(0)
  );
}

function assertShortLivedHttpsUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(
      503,
      "ATTACHMENT_STORAGE_UNAVAILABLE",
      "对象存储未返回有效的私有访问地址。"
    );
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ApiError(
      503,
      "ATTACHMENT_STORAGE_UNAVAILABLE",
      "对象存储未返回有效的私有访问地址。"
    );
  }
}

function displayFilename(filename: string): string {
  const segments = filename.replaceAll("\\", "/").split("/");
  return (
    segments.findLast((segment) => segment && segment !== "..") ?? "attachment"
  );
}

function fileExtension(
  filename: string
): keyof typeof MIME_BY_EXTENSION | null {
  const base = displayFilename(filename);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  const extension = base.slice(dot + 1).toLowerCase();
  return extension in MIME_BY_EXTENSION
    ? (extension as keyof typeof MIME_BY_EXTENSION)
    : null;
}

function lowerCaseRecord(
  input: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function publicView(target: ChatAttachmentTarget): ChatAttachmentView {
  const {
    id,
    conversationId,
    messageId,
    kind,
    filename,
    mimeType,
    sizeBytes,
    status,
    parseStatus,
    failureCode,
    failureMessage,
    createdAt,
    updatedAt,
    readyAt
  } = target;
  return {
    id,
    conversationId,
    messageId,
    kind,
    filename,
    mimeType,
    sizeBytes,
    status,
    parseStatus,
    failureCode,
    failureMessage,
    createdAt,
    updatedAt,
    readyAt
  };
}
