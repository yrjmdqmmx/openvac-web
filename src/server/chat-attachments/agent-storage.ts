import { createHash } from "node:crypto";

import type {
  AttachmentAccessScope,
  AttachmentStorage,
  AttachmentTextChunk,
  StoredAttachment
} from "@/server/agent/attachment-tools";
import {
  CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENT_BYTES
} from "@/server/chat-v3/contracts";
import { sqlClient } from "@/server/db";
import { getObjectStorage } from "@/server/providers";
import type { ObjectStorage } from "@/server/providers";
import type { AttachmentKind } from "@/types/chat-v3";

const MAX_AGENT_CHUNKS = 256;
const MAX_CHUNK_CHARACTERS = 8_000;
const ALLOWED_MIME_TYPES = new Set<string>(CHAT_ATTACHMENT_MIME_TYPES);
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const SAFE_OBJECT_KEY =
  /^private\/chat-attachments\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

export interface AgentAttachmentSql {
  unsafe(
    query: string,
    parameters?: unknown[]
  ): Promise<Array<Record<string, unknown>>>;
}

export type AgentAttachmentStorageErrorCode =
  | "ATTACHMENT_STORAGE_INVALID"
  | "ATTACHMENT_INTEGRITY_MISMATCH"
  | "ATTACHMENT_STORAGE_READ_ONLY";

export class AgentAttachmentStorageError extends Error {
  constructor(
    readonly code: AgentAttachmentStorageErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AgentAttachmentStorageError";
  }
}

/**
 * Read-only Agent adapter for attachments already verified and committed by the
 * upload service. Document parsing belongs exclusively to the background
 * worker; this adapter never writes chunks or downloads document objects.
 */
export class PostgresAgentAttachmentStorage implements AttachmentStorage {
  constructor(
    private readonly sql: AgentAttachmentSql = sqlClient as unknown as AgentAttachmentSql,
    private readonly objectStorage: ObjectStorage = getObjectStorage()
  ) {}

  async getAuthorizedAttachment(
    scope: AttachmentAccessScope
  ): Promise<StoredAttachment | null> {
    const [row] = await this.sql.unsafe(
      AUTHORIZED_ATTACHMENT_SQL,
      scopeValues(scope)
    );
    if (!row) return null;

    const attachment = parseAuthorizedAttachment(row, scope);
    if (attachment.kind === "document") {
      // The worker has already parsed and integrity-checked this object. Avoid
      // allocating or downloading as much as 25 MiB on a web request.
      return storedAttachment(attachment);
    }

    const bytes = await this.objectStorage.getPrivate(attachment.objectKey);
    assertImageIntegrity(bytes, attachment);
    return { ...storedAttachment(attachment), bytes: new Uint8Array(bytes) };
  }

  async getParsedChunks(
    scope: AttachmentAccessScope
  ): Promise<AttachmentTextChunk[] | null> {
    const rows = await this.sql.unsafe(
      AUTHORIZED_CHUNKS_SQL,
      scopeValues(scope)
    );
    if (rows.length === 0) return null;

    // LEFT JOIN deliberately produces one authorized row when no chunks exist.
    // [] is a present-but-invalid cache to the tool service, so it fails closed
    // instead of submitting a second production parse from the web process.
    if (rows.length === 1 && rows[0]?.chunk_id == null) return [];
    if (rows.length > MAX_AGENT_CHUNKS) {
      throw invalidStorage("Attachment chunk count exceeds the Agent limit.");
    }

    return rows.map((row) => parseChunk(row, scope));
  }

  async putParsedChunks(
    _scope: AttachmentAccessScope,
    _chunks: readonly AttachmentTextChunk[]
  ): Promise<never> {
    void _scope;
    void _chunks;
    throw new AgentAttachmentStorageError(
      "ATTACHMENT_STORAGE_READ_ONLY",
      "Attachment chunks are written only by the background parser worker."
    );
  }
}

type AuthorizedAttachment = Omit<StoredAttachment, "bytes" | "status"> & {
  kind: AttachmentKind;
  objectKey: string;
  sha256: string;
};

const AUTHORIZED_ATTACHMENT_SQL = `
SELECT
  attachment.id AS attachment_id,
  attachment.user_id,
  attachment.conversation_id,
  attachment.message_id,
  attachment.kind,
  attachment.original_filename,
  attachment.mime_type,
  attachment.size_bytes,
  attachment.sha256,
  attachment.object_key
FROM chat_attachment attachment
JOIN conversation
  ON conversation.id = attachment.conversation_id
JOIN message user_message
  ON user_message.id = attachment.message_id
 AND user_message.conversation_id = attachment.conversation_id
JOIN conversation_turn turn
  ON turn.user_message_id = user_message.id
 AND turn.conversation_id = attachment.conversation_id
WHERE attachment.id = $1
  AND attachment.user_id = $2
  AND attachment.conversation_id = $3
  AND attachment.message_id = $4
  AND attachment.status = 'ready'
  AND attachment.ready_at IS NOT NULL
  AND attachment.quota_state = 'committed'
  AND attachment.deletion_status = 'active'
  AND attachment.deleted_at IS NULL
  AND attachment.bound_at IS NOT NULL
  AND conversation.user_id = $2
  AND conversation.status = 'active'
  AND conversation.deleted_at IS NULL
  AND user_message.user_id = $2
  AND user_message.role = 'user'
  AND user_message.status = 'completed'
  AND EXISTS (
    SELECT 1
    FROM agent_run active_run
    WHERE active_run.turn_id = turn.id
      AND active_run.user_id = $2
      AND active_run.status IN ('pending', 'running')
  )
LIMIT 1
`.trim();

const AUTHORIZED_CHUNKS_SQL = `
SELECT
  attachment.id AS attachment_id,
  attachment.user_id,
  attachment.conversation_id,
  attachment.message_id,
  attachment.kind,
  chunk.id AS chunk_id,
  chunk.content,
  chunk.locator
FROM chat_attachment attachment
JOIN conversation
  ON conversation.id = attachment.conversation_id
JOIN message user_message
  ON user_message.id = attachment.message_id
 AND user_message.conversation_id = attachment.conversation_id
JOIN conversation_turn turn
  ON turn.user_message_id = user_message.id
 AND turn.conversation_id = attachment.conversation_id
LEFT JOIN chat_attachment_chunk chunk
  ON chunk.attachment_id = attachment.id
WHERE attachment.id = $1
  AND attachment.user_id = $2
  AND attachment.conversation_id = $3
  AND attachment.message_id = $4
  AND attachment.kind = 'document'
  AND attachment.status = 'ready'
  AND attachment.parse_status = 'ready'
  AND attachment.ready_at IS NOT NULL
  AND attachment.quota_state = 'committed'
  AND attachment.deletion_status = 'active'
  AND attachment.deleted_at IS NULL
  AND attachment.bound_at IS NOT NULL
  AND conversation.user_id = $2
  AND conversation.status = 'active'
  AND conversation.deleted_at IS NULL
  AND user_message.user_id = $2
  AND user_message.role = 'user'
  AND user_message.status = 'completed'
  AND EXISTS (
    SELECT 1
    FROM agent_run active_run
    WHERE active_run.turn_id = turn.id
      AND active_run.user_id = $2
      AND active_run.status IN ('pending', 'running')
  )
ORDER BY chunk.ordinal
LIMIT ${MAX_AGENT_CHUNKS + 1}
`.trim();

function scopeValues(scope: AttachmentAccessScope): string[] {
  return [
    requiredString(scope.attachmentId, "attachment scope"),
    requiredString(scope.userId, "attachment scope"),
    requiredString(scope.conversationId, "attachment scope"),
    requiredString(scope.messageId, "attachment scope")
  ];
}

function parseAuthorizedAttachment(
  row: Record<string, unknown>,
  scope: AttachmentAccessScope
): AuthorizedAttachment {
  assertScopeColumns(row, scope);
  const kind = attachmentKind(row.kind);
  const filename = requiredString(row.original_filename, "attachment filename");
  const mimeType = requiredString(row.mime_type, "attachment MIME type");
  const sizeBytes = positiveInteger(row.size_bytes, "attachment size");
  const sha256 = requiredString(row.sha256, "attachment SHA-256");
  const objectKey = requiredString(row.object_key, "attachment object key");

  if (
    filename.length > 240 ||
    /[/\\\p{Cc}]/u.test(filename) ||
    !ALLOWED_MIME_TYPES.has(mimeType) ||
    (kind === "image") !== IMAGE_MIME_TYPES.has(mimeType) ||
    sizeBytes > MAX_CHAT_ATTACHMENT_BYTES ||
    !/^[0-9a-f]{64}$/u.test(sha256) ||
    !SAFE_OBJECT_KEY.test(objectKey) ||
    objectKey.includes("//") ||
    objectKey.split("/").includes("..")
  ) {
    throw invalidStorage("Attachment metadata is invalid.");
  }

  return {
    userId: scope.userId,
    conversationId: scope.conversationId,
    messageId: scope.messageId,
    attachmentId: scope.attachmentId,
    kind,
    filename,
    mimeType,
    sizeBytes,
    objectKey,
    sha256
  };
}

function storedAttachment(attachment: AuthorizedAttachment): StoredAttachment {
  return {
    userId: attachment.userId,
    conversationId: attachment.conversationId,
    messageId: attachment.messageId,
    attachmentId: attachment.attachmentId,
    kind: attachment.kind,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    status: "ready"
  };
}

function parseChunk(
  row: Record<string, unknown>,
  scope: AttachmentAccessScope
): AttachmentTextChunk {
  assertScopeColumns(row, scope);
  if (row.kind !== "document") {
    throw invalidStorage("Attachment chunk is not bound to a document.");
  }
  const chunkId = requiredString(row.chunk_id, "attachment chunk id");
  const text = requiredString(row.content, "attachment chunk content");
  if (chunkId.length > 240 || text.length > MAX_CHUNK_CHARACTERS) {
    throw invalidStorage("Attachment chunk is invalid.");
  }
  const pageNumber = pageNumberFromLocator(row.locator);
  return {
    chunkId,
    attachmentId: scope.attachmentId,
    text,
    ...(pageNumber === undefined ? {} : { pageNumber })
  };
}

function assertScopeColumns(
  row: Record<string, unknown>,
  scope: AttachmentAccessScope
): void {
  if (
    row.attachment_id !== scope.attachmentId ||
    row.user_id !== scope.userId ||
    row.conversation_id !== scope.conversationId ||
    row.message_id !== scope.messageId
  ) {
    throw invalidStorage("Attachment authorization result is invalid.");
  }
}

function assertImageIntegrity(
  bytes: unknown,
  attachment: AuthorizedAttachment
): asserts bytes is Uint8Array {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > MAX_CHAT_ATTACHMENT_BYTES ||
    bytes.byteLength !== attachment.sizeBytes
  ) {
    throw new AgentAttachmentStorageError(
      "ATTACHMENT_INTEGRITY_MISMATCH",
      "Attachment image size does not match its verified metadata."
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== attachment.sha256) {
    throw new AgentAttachmentStorageError(
      "ATTACHMENT_INTEGRITY_MISMATCH",
      "Attachment image hash does not match its verified metadata."
    );
  }
}

function pageNumberFromLocator(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)) {
    throw invalidStorage("Attachment chunk locator is invalid.");
  }
  if (!("page" in value) || value.page == null) return undefined;
  const page = Number(value.page);
  if (!Number.isSafeInteger(page) || page < 1) {
    throw invalidStorage("Attachment chunk page number is invalid.");
  }
  return page;
}

function attachmentKind(value: unknown): AttachmentKind {
  if (value === "document" || value === "image") return value;
  throw invalidStorage("Attachment kind is invalid.");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.length > 1_024) {
    throw invalidStorage(`${field} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw invalidStorage(`${field} is invalid.`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidStorage(message: string): AgentAttachmentStorageError {
  return new AgentAttachmentStorageError("ATTACHMENT_STORAGE_INVALID", message);
}

export const agentAttachmentStorage = new PostgresAgentAttachmentStorage();
