import { createHash } from "node:crypto";

import { ApiError, notFound } from "@/server/api/errors";
import {
  artifactSpecSchema,
  MAX_CHAT_STORAGE_BYTES_PER_USER
} from "@/server/chat-v3/contracts";
import { sqlClient } from "@/server/db";
import type { ObjectStorage, PrivateObjectStat } from "@/server/providers";
import type {
  ArtifactFormat,
  ArtifactKind,
  ArtifactSpec,
  ArtifactStatus
} from "@/types/chat-v3";

const ARTIFACT_MIME_BY_FORMAT: Record<ArtifactFormat, string> = {
  md: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  csv: "text/csv"
};

export type ChatArtifactView = {
  id: string;
  conversationId: string;
  sourceTurnId: string;
  kind: ArtifactKind;
  title: string;
  formats: ArtifactFormat[];
  status: ArtifactStatus;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
};

export type ChatArtifactFileView = {
  id: string;
  artifactId: string;
  format: ArtifactFormat;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

export interface ChatArtifactStorageRepository {
  createArtifact(input: {
    artifactId: string;
    userId: string;
    conversationId: string;
    spec: ArtifactSpec;
  }): Promise<ChatArtifactView>;
  reserveFile(input: {
    fileId: string;
    artifactId: string;
    userId: string;
    conversationId: string;
    format: ArtifactFormat;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    objectKey: string;
  }): Promise<void>;
  commitFile(input: {
    fileId: string;
    artifactId: string;
    userId: string;
  }): Promise<ChatArtifactFileView>;
  abortFile(input: {
    fileId: string;
    artifactId: string;
    userId: string;
    message: string;
  }): Promise<void>;
}

export interface ChatArtifactSql {
  unsafe(
    query: string,
    parameters?: unknown[]
  ): Promise<Array<Record<string, unknown>>>;
  begin<T>(handler: (transaction: ChatArtifactSql) => Promise<T>): Promise<T>;
}

export class PostgresChatArtifactStorageRepository implements ChatArtifactStorageRepository {
  constructor(
    private readonly sql: ChatArtifactSql = sqlClient as unknown as ChatArtifactSql
  ) {}

  async createArtifact(
    input: Parameters<ChatArtifactStorageRepository["createArtifact"]>[0]
  ): Promise<ChatArtifactView> {
    return this.sql.begin(async (transaction) => {
      const [account] = await transaction.unsafe(
        `
          SELECT id FROM "user"
          WHERE id = $1 AND deletion_requested_at IS NULL
          FOR KEY SHARE
        `,
        [input.userId]
      );
      if (!account) throw notFound("会话轮次");
      const [conversation] = await transaction.unsafe(
        `
          SELECT id FROM conversation
          WHERE id = $1 AND user_id = $2
            AND status <> 'deleted' AND deleted_at IS NULL
          FOR SHARE
        `,
        [input.conversationId, input.userId]
      );
      if (!conversation) throw notFound("会话轮次");
      const [scope] = await transaction.unsafe(
        `
          SELECT id FROM conversation_turn
          WHERE id = $1 AND conversation_id = $2
          FOR KEY SHARE
        `,
        [input.spec.sourceTurnId, input.conversationId]
      );
      if (!scope) throw notFound("会话轮次");
      const [row] = await transaction.unsafe(
        `
          INSERT INTO chat_artifact (
            id, user_id, conversation_id, source_turn_id, kind,
            title, status, spec, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5::chat_artifact_kind,
            $6, 'generating', $7::jsonb, NOW(), NOW()
          )
          RETURNING id, conversation_id, source_turn_id, kind, title,
            status, spec, created_at, updated_at, ready_at
        `,
        [
          input.artifactId,
          input.userId,
          input.conversationId,
          input.spec.sourceTurnId,
          input.spec.kind,
          input.spec.title,
          JSON.stringify(input.spec)
        ]
      );
      return parseArtifact(row);
    });
  }

  async reserveFile(
    input: Parameters<ChatArtifactStorageRepository["reserveFile"]>[0]
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const [account] = await transaction.unsafe(
        `
          SELECT id FROM "user"
          WHERE id = $1 AND deletion_requested_at IS NULL
          FOR KEY SHARE
        `,
        [input.userId]
      );
      if (!account) throw notFound("产物");
      const [conversation] = await transaction.unsafe(
        `
          SELECT id FROM conversation
          WHERE id = $1 AND user_id = $2
            AND status <> 'deleted' AND deleted_at IS NULL
          FOR SHARE
        `,
        [input.conversationId, input.userId]
      );
      if (!conversation) throw notFound("产物");
      const [artifact] = await transaction.unsafe(
        `
          SELECT artifact.id
          FROM chat_artifact artifact
          WHERE artifact.id = $1 AND artifact.user_id = $2
            AND artifact.conversation_id = $3
            AND artifact.status IN ('generating', 'failed')
          FOR UPDATE
        `,
        [input.artifactId, input.userId, input.conversationId]
      );
      if (!artifact) throw notFound("产物");
      await transaction.unsafe(
        `
          INSERT INTO chat_storage_account (user_id)
          VALUES ($1) ON CONFLICT (user_id) DO NOTHING
        `,
        [input.userId]
      );
      const [quota] = await transaction.unsafe(
        `
          SELECT used_bytes, reserved_bytes, limit_bytes
          FROM chat_storage_account WHERE user_id = $1 FOR UPDATE
        `,
        [input.userId]
      );
      const used = requiredInteger(quota?.used_bytes, "artifact used quota");
      const reserved = requiredInteger(
        quota?.reserved_bytes,
        "artifact reserved quota"
      );
      const limit = requiredInteger(quota?.limit_bytes, "artifact quota limit");
      if (used + reserved + input.sizeBytes > limit) {
        throw new ApiError(
          413,
          "CHAT_STORAGE_QUOTA_EXCEEDED",
          "附件与产物的账号存储空间已达 500 MiB 上限。",
          { usedBytes: used, reservedBytes: reserved, limitBytes: limit }
        );
      }
      const existing = await transaction.unsafe(
        `
          SELECT id FROM chat_artifact_file
          WHERE artifact_id = $1 AND format = $2::chat_artifact_format
          FOR UPDATE
        `,
        [input.artifactId, input.format]
      );
      if (existing.length > 0) {
        throw new ApiError(
          409,
          "ARTIFACT_FORMAT_EXISTS",
          "该产物格式已经生成。"
        );
      }
      await transaction.unsafe(
        `
          INSERT INTO chat_artifact_file (
            id, artifact_id, format, filename, mime_type, size_bytes,
            sha256, object_key, quota_state, deletion_status, created_at
          ) VALUES (
            $1, $2, $3::chat_artifact_format, $4, $5, $6,
            $7, $8, 'reserved', 'active', NOW()
          )
        `,
        [
          input.fileId,
          input.artifactId,
          input.format,
          input.filename,
          input.mimeType,
          input.sizeBytes,
          input.sha256,
          input.objectKey
        ]
      );
      await transaction.unsafe(
        `
          UPDATE chat_storage_account
          SET reserved_bytes = reserved_bytes + $2, updated_at = NOW()
          WHERE user_id = $1
        `,
        [input.userId, input.sizeBytes]
      );
      await transaction.unsafe(
        `
          UPDATE chat_artifact
          SET status = 'generating', updated_at = NOW()
          WHERE id = $1 AND user_id = $2
        `,
        [input.artifactId, input.userId]
      );
    });
  }

  async commitFile(
    input: Parameters<ChatArtifactStorageRepository["commitFile"]>[0]
  ): Promise<ChatArtifactFileView> {
    return this.sql.begin(async (transaction) => {
      const [file] = await transaction.unsafe(
        `
          SELECT file.id, file.artifact_id, file.format, file.filename,
                 file.mime_type, file.size_bytes, file.sha256, file.created_at
          FROM chat_artifact_file file
          JOIN chat_artifact artifact ON artifact.id = file.artifact_id
          WHERE file.id = $1 AND file.artifact_id = $2
            AND artifact.user_id = $3 AND file.quota_state = 'reserved'
            AND file.deletion_status = 'active'
          FOR UPDATE OF file, artifact
        `,
        [input.fileId, input.artifactId, input.userId]
      );
      if (!file) throw notFound("产物文件");
      const sizeBytes = requiredInteger(file.size_bytes, "artifact file size");
      await transaction.unsafe(
        `
          UPDATE chat_storage_account
          SET reserved_bytes = reserved_bytes - $2,
              used_bytes = used_bytes + $2, updated_at = NOW()
          WHERE user_id = $1
        `,
        [input.userId, sizeBytes]
      );
      await transaction.unsafe(
        `
          UPDATE chat_artifact_file SET quota_state = 'committed'
          WHERE id = $1 AND artifact_id = $2
        `,
        [input.fileId, input.artifactId]
      );
      await transaction.unsafe(
        `
          UPDATE chat_artifact artifact
          SET status = CASE
                WHEN (
                  SELECT COUNT(*)
                  FROM chat_artifact_file file
                  WHERE file.artifact_id = artifact.id
                    AND file.quota_state = 'committed'
                    AND file.deletion_status = 'active'
                ) >= jsonb_array_length(artifact.spec -> 'formats')
                  THEN 'ready'::chat_artifact_status
                ELSE 'generating'::chat_artifact_status
              END,
              ready_at = CASE
                WHEN (
                  SELECT COUNT(*)
                  FROM chat_artifact_file file
                  WHERE file.artifact_id = artifact.id
                    AND file.quota_state = 'committed'
                    AND file.deletion_status = 'active'
                ) >= jsonb_array_length(artifact.spec -> 'formats')
                  THEN NOW()
                ELSE NULL
              END,
              updated_at = NOW()
          WHERE artifact.id = $1 AND artifact.user_id = $2
        `,
        [input.artifactId, input.userId]
      );
      return parseArtifactFile(file);
    });
  }

  async abortFile(
    input: Parameters<ChatArtifactStorageRepository["abortFile"]>[0]
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const [file] = await transaction.unsafe(
        `
          SELECT file.size_bytes, file.object_key
          FROM chat_artifact_file file
          JOIN chat_artifact artifact ON artifact.id = file.artifact_id
          WHERE file.id = $1 AND file.artifact_id = $2
            AND artifact.user_id = $3 AND file.quota_state = 'reserved'
          FOR UPDATE OF file, artifact
        `,
        [input.fileId, input.artifactId, input.userId]
      );
      if (!file) return;
      const sizeBytes = requiredInteger(file.size_bytes, "artifact file size");
      const objectKey = requiredString(file.object_key, "artifact object key");
      await transaction.unsafe(
        `
          UPDATE chat_storage_account
          SET reserved_bytes = GREATEST(reserved_bytes - $2, 0),
              updated_at = NOW()
          WHERE user_id = $1
        `,
        [input.userId, sizeBytes]
      );
      await transaction.unsafe(
        `
          INSERT INTO chat_storage_deletion_job (
            user_id, object_type, source_id, object_key
          ) VALUES ($1, 'artifact', $2, $3)
          ON CONFLICT (object_key) DO NOTHING
        `,
        [input.userId, input.fileId, objectKey]
      );
      await transaction.unsafe(
        "DELETE FROM chat_artifact_file WHERE id = $1 AND artifact_id = $2",
        [input.fileId, input.artifactId]
      );
      await transaction.unsafe(
        `
          UPDATE chat_artifact
          SET status = 'failed', updated_at = NOW()
          WHERE id = $1 AND user_id = $2
        `,
        [input.artifactId, input.userId]
      );
    });
  }
}

type UuidSource = { randomUUID(): string };

export class ChatArtifactStorageService {
  constructor(
    private readonly repository: ChatArtifactStorageRepository,
    private readonly storage: ObjectStorage,
    private readonly uuidSource: UuidSource = crypto
  ) {}

  async create(input: {
    userId: string;
    conversationId: string;
    spec: unknown;
  }): Promise<ChatArtifactView> {
    const parsed = artifactSpecSchema.safeParse(input.spec);
    if (!parsed.success) {
      throw new ApiError(
        422,
        "ARTIFACT_SPEC_INVALID",
        "产物规格不符合要求。",
        parsed.error.issues
      );
    }
    return this.repository.createArtifact({
      artifactId: this.uuidSource.randomUUID(),
      userId: input.userId,
      conversationId: input.conversationId,
      spec: parsed.data
    });
  }

  async persistFile(input: {
    artifactId: string;
    conversationId: string;
    userId: string;
    format: ArtifactFormat;
    filename: string;
    bytes: Uint8Array;
  }): Promise<ChatArtifactFileView> {
    if (
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > MAX_CHAT_STORAGE_BYTES_PER_USER
    ) {
      throw new ApiError(
        422,
        "ARTIFACT_FILE_INVALID",
        "产物文件大小不符合要求。"
      );
    }
    const mimeType = ARTIFACT_MIME_BY_FORMAT[input.format];
    if (!mimeType || !filenameMatchesFormat(input.filename, input.format)) {
      throw new ApiError(
        422,
        "ARTIFACT_FILE_INVALID",
        "产物文件扩展名与格式不匹配。"
      );
    }
    if (typeof this.storage.statPrivate !== "function") {
      throw new ApiError(
        503,
        "ARTIFACT_STORAGE_UNAVAILABLE",
        "产物存储服务暂时不可用。"
      );
    }
    const fileId = this.uuidSource.randomUUID();
    const filename = displayFilename(input.filename);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const objectKey = artifactObjectKey({ ...input, fileId, filename });
    await this.repository.reserveFile({
      fileId,
      artifactId: input.artifactId,
      userId: input.userId,
      conversationId: input.conversationId,
      format: input.format,
      filename,
      mimeType,
      sizeBytes: input.bytes.byteLength,
      sha256,
      objectKey
    });
    try {
      await this.storage.putPrivate({
        key: objectKey,
        body: input.bytes,
        contentType: mimeType,
        metadata: {
          "artifact-id": input.artifactId,
          sha256,
          "size-bytes": String(input.bytes.byteLength)
        },
        forbidOverwrite: true
      });
      const stat = await this.storage.statPrivate(objectKey);
      assertArtifactObject(stat, {
        artifactId: input.artifactId,
        objectKey,
        mimeType,
        sizeBytes: input.bytes.byteLength,
        sha256
      });
      return await this.repository.commitFile({
        fileId,
        artifactId: input.artifactId,
        userId: input.userId
      });
    } catch (cause) {
      await this.repository.abortFile({
        fileId,
        artifactId: input.artifactId,
        userId: input.userId,
        message:
          cause instanceof Error ? cause.message : "Artifact storage failed"
      });
      throw cause;
    }
  }
}

export const chatArtifactStorageRepository =
  new PostgresChatArtifactStorageRepository();

function parseArtifact(
  row: Record<string, unknown> | undefined
): ChatArtifactView {
  if (!row) throw new Error("Artifact query returned no row.");
  const spec = recordValue(row.spec);
  const formats = Array.isArray(spec.formats)
    ? spec.formats.filter(isArtifactFormat)
    : [];
  const status = artifactStatus(row.status);
  if (!status || formats.length === 0)
    throw new Error("Artifact row is malformed.");
  return {
    id: requiredString(row.id, "artifact id"),
    conversationId: requiredString(
      row.conversation_id,
      "artifact conversation"
    ),
    sourceTurnId: requiredString(row.source_turn_id, "artifact source turn"),
    kind: requiredString(row.kind, "artifact kind") as ArtifactKind,
    title: requiredString(row.title, "artifact title"),
    formats,
    status,
    createdAt: requiredTimestamp(row.created_at, "artifact created time"),
    updatedAt: requiredTimestamp(row.updated_at, "artifact updated time"),
    readyAt: optionalTimestamp(row.ready_at)
  };
}

function parseArtifactFile(
  row: Record<string, unknown> | undefined
): ChatArtifactFileView {
  if (!row) throw new Error("Artifact file query returned no row.");
  const format = row.format;
  if (!isArtifactFormat(format))
    throw new Error("Artifact format is malformed.");
  return {
    id: requiredString(row.id, "artifact file id"),
    artifactId: requiredString(row.artifact_id, "artifact id"),
    format,
    filename: requiredString(row.filename, "artifact filename"),
    mimeType: requiredString(row.mime_type, "artifact MIME type"),
    sizeBytes: requiredInteger(row.size_bytes, "artifact size"),
    sha256: requiredString(row.sha256, "artifact SHA-256"),
    createdAt: requiredTimestamp(row.created_at, "artifact file created time")
  };
}

function artifactObjectKey(input: {
  userId: string;
  conversationId: string;
  artifactId: string;
  fileId: string;
  filename: string;
}): string {
  const partition = createHash("sha256")
    .update(input.userId)
    .digest("hex")
    .slice(0, 24);
  return (
    `private/chat-artifacts/${partition}/${input.conversationId}/` +
    `${input.artifactId}/${input.fileId}/${sanitizeFilename(input.filename)}`
  );
}

function assertArtifactObject(
  stat: PrivateObjectStat,
  expected: {
    artifactId: string;
    objectKey: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  }
): void {
  const metadata = Object.fromEntries(
    Object.entries(stat.metadata).map(([key, value]) => [
      key.toLowerCase(),
      value
    ])
  );
  if (
    stat.key !== expected.objectKey ||
    stat.sizeBytes !== expected.sizeBytes ||
    stat.contentType?.split(";", 1)[0]?.trim().toLowerCase() !==
      expected.mimeType ||
    metadata["artifact-id"] !== expected.artifactId ||
    metadata.sha256 !== expected.sha256 ||
    metadata["size-bytes"] !== String(expected.sizeBytes)
  ) {
    throw new ApiError(
      409,
      "ARTIFACT_STORAGE_MISMATCH",
      "产物对象与登记信息不一致。"
    );
  }
}

function filenameMatchesFormat(
  filename: string,
  format: ArtifactFormat
): boolean {
  return displayFilename(filename).toLowerCase().endsWith(`.${format}`);
}

function displayFilename(filename: string): string {
  return (
    filename
      .replaceAll("\\", "/")
      .split("/")
      .findLast((part) => part && part !== "..") ?? "artifact"
  );
}

function sanitizeFilename(filename: string): string {
  const display = displayFilename(filename);
  const dot = display.lastIndexOf(".");
  const extension = dot > 0 ? display.slice(dot + 1).toLowerCase() : "bin";
  const stem = dot > 0 ? display.slice(0, dot) : display;
  const safe = stem
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  return `${safe || "artifact"}.${extension}`;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isArtifactFormat(value: unknown): value is ArtifactFormat {
  return ["md", "docx", "pdf", "csv"].includes(String(value));
}

function artifactStatus(value: unknown): ArtifactStatus | null {
  return ["generating", "ready", "failed", "deleted"].includes(String(value))
    ? (value as ArtifactStatus)
    : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`Malformed ${label}.`);
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Malformed ${label}.`);
  }
  return parsed;
}

function requiredTimestamp(value: unknown, label: string): string {
  const result = optionalTimestamp(value);
  if (!result) throw new Error(`Malformed ${label}.`);
  return result;
}

function optionalTimestamp(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}
