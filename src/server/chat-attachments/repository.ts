import { ApiError, notFound } from "@/server/api/errors";
import { sqlClient } from "@/server/db";

import type {
  ChatAttachmentRepository,
  ChatAttachmentTarget,
  ChatAttachmentView
} from "./service";

export interface ChatAttachmentSql {
  unsafe(
    query: string,
    parameters?: unknown[]
  ): Promise<Array<Record<string, unknown>>>;
  begin<T>(handler: (transaction: ChatAttachmentSql) => Promise<T>): Promise<T>;
}

export class PostgresChatAttachmentRepository implements ChatAttachmentRepository {
  constructor(
    private readonly sql: ChatAttachmentSql = sqlClient as unknown as ChatAttachmentSql
  ) {}

  async initiate(
    input: Parameters<ChatAttachmentRepository["initiate"]>[0]
  ): Promise<ChatAttachmentView> {
    return this.sql.begin(async (transaction) => {
      const [account] = await transaction.unsafe(
        `
          SELECT id FROM "user"
          WHERE id = $1 AND deletion_requested_at IS NULL
          FOR KEY SHARE
        `,
        [input.userId]
      );
      if (!account) throw notFound("会话");
      const [scope] = await transaction.unsafe(
        `
          SELECT id FROM conversation
          WHERE id = $1 AND user_id = $2
            AND status <> 'deleted' AND deleted_at IS NULL
          FOR SHARE
        `,
        [input.conversationId, input.userId]
      );
      if (!scope) throw notFound("会话");

      await transaction.unsafe(
        `
          INSERT INTO chat_storage_account (user_id)
          VALUES ($1)
          ON CONFLICT (user_id) DO NOTHING
        `,
        [input.userId]
      );
      const [quota] = await transaction.unsafe(
        `
          SELECT used_bytes, reserved_bytes, limit_bytes
          FROM chat_storage_account
          WHERE user_id = $1
          FOR UPDATE
        `,
        [input.userId]
      );
      const usedBytes = safeInteger(quota?.used_bytes);
      const reservedBytes = safeInteger(quota?.reserved_bytes);
      const limitBytes = safeInteger(quota?.limit_bytes);
      if (usedBytes === null || reservedBytes === null || limitBytes === null) {
        throw new Error("Chat storage quota row is malformed.");
      }
      if (usedBytes + reservedBytes + input.declaredSizeBytes > limitBytes) {
        throw new ApiError(
          413,
          "CHAT_STORAGE_QUOTA_EXCEEDED",
          "附件与产物的账号存储空间已达 500 MiB 上限。",
          { usedBytes, reservedBytes, limitBytes }
        );
      }

      const [row] = await transaction.unsafe(
        `
          INSERT INTO chat_attachment (
            id, user_id, conversation_id, kind, status, parse_status,
            quota_state, deletion_status, original_filename, mime_type,
            declared_size_bytes, sha256, object_key, upload_expires_at,
            orphan_expires_at, parse_run_at, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4::chat_attachment_kind, 'initiated',
            $5::chat_attachment_parse_status, 'reserved', 'active', $6, $7,
            $8, $9, $10, $11, $12, NOW(), NOW(), NOW()
          )
          RETURNING ${ATTACHMENT_RETURNING}
        `,
        [
          input.id,
          input.userId,
          input.conversationId,
          input.kind,
          input.kind === "image" ? "not_required" : "queued",
          input.filename,
          input.mimeType,
          input.declaredSizeBytes,
          input.sha256,
          input.objectKey,
          input.uploadExpiresAt.toISOString(),
          input.orphanExpiresAt.toISOString()
        ]
      );
      await transaction.unsafe(
        `
          UPDATE chat_storage_account
          SET reserved_bytes = reserved_bytes + $2, updated_at = NOW()
          WHERE user_id = $1
        `,
        [input.userId, input.declaredSizeBytes]
      );
      return parseView(row);
    });
  }

  async beginCompletion(
    attachmentId: string,
    userId: string
  ): Promise<ChatAttachmentTarget & { alreadyComplete: boolean }> {
    return this.sql.begin(async (transaction) => {
      const [row] = await transaction.unsafe(
        `
          SELECT ${ATTACHMENT_TARGET_SELECT}
          FROM chat_attachment a
          JOIN conversation c ON c.id = a.conversation_id
          WHERE a.id = $1
            AND a.user_id = $2
            AND c.user_id = $2
            AND c.status <> 'deleted'
            AND c.deleted_at IS NULL
          FOR UPDATE OF a
        `,
        [attachmentId, userId]
      );
      const target = parseTarget(row);
      if (!target) throw notFound("附件");
      if (target.quotaState === "committed") {
        return { ...target, alreadyComplete: true };
      }
      if (
        target.quotaState !== "reserved" ||
        target.deletionStatus !== "active" ||
        !["initiated", "uploading"].includes(target.status)
      ) {
        throw new ApiError(
          409,
          "ATTACHMENT_STATE_CONFLICT",
          target.status === "scanning"
            ? "附件正在校验，请勿重复提交。"
            : "附件当前状态不能完成上传。"
        );
      }
      await transaction.unsafe(
        `
          UPDATE chat_attachment
          SET status = 'scanning', failure_code = NULL,
              failure_message = NULL, updated_at = NOW()
          WHERE id = $1 AND user_id = $2
        `,
        [attachmentId, userId]
      );
      return { ...target, status: "scanning", alreadyComplete: false };
    });
  }

  async completeVerified(
    input: Parameters<ChatAttachmentRepository["completeVerified"]>[0]
  ): Promise<ChatAttachmentView> {
    return this.sql.begin(async (transaction) => {
      const [target] = await transaction.unsafe(
        `
          SELECT kind, declared_size_bytes
          FROM chat_attachment
          WHERE id = $1 AND user_id = $2
            AND status = 'scanning'
            AND quota_state = 'reserved'
            AND deletion_status = 'active'
          FOR UPDATE
        `,
        [input.attachmentId, input.userId]
      );
      const declaredSizeBytes = safeInteger(target?.declared_size_bytes);
      const kind = stringValue(target?.kind);
      if (!kind || declaredSizeBytes === null) {
        throw new ApiError(
          409,
          "ATTACHMENT_STATE_CONFLICT",
          "附件状态已变化，请刷新后重试。"
        );
      }
      if (declaredSizeBytes !== input.sizeBytes) {
        throw new ApiError(
          409,
          "ATTACHMENT_UPLOAD_MISMATCH",
          "已上传附件的真实大小与登记信息不一致。"
        );
      }
      await transaction.unsafe(
        `
          UPDATE chat_storage_account
          SET reserved_bytes = reserved_bytes - $2,
              used_bytes = used_bytes + $3,
              updated_at = NOW()
          WHERE user_id = $1
        `,
        [input.userId, declaredSizeBytes, input.sizeBytes]
      );
      const image = kind === "image";
      const [row] = await transaction.unsafe(
        `
          UPDATE chat_attachment
          SET size_bytes = $3,
              object_etag = $4,
              quota_state = 'committed',
              status = $5::chat_attachment_status,
              parse_status = $6::chat_attachment_parse_status,
              ready_at = CASE WHEN $5 = 'ready' THEN NOW() ELSE NULL END,
              parse_run_at = NOW(),
              updated_at = NOW()
          WHERE id = $1 AND user_id = $2
          RETURNING ${ATTACHMENT_RETURNING}
        `,
        [
          input.attachmentId,
          input.userId,
          input.sizeBytes,
          input.etag ?? null,
          image ? "ready" : "processing",
          image ? "not_required" : "queued"
        ]
      );
      return parseView(row);
    });
  }

  async resetCompletion(attachmentId: string, userId: string): Promise<void> {
    await this.sql.unsafe(
      `
        UPDATE chat_attachment
        SET status = 'initiated', updated_at = NOW()
        WHERE id = $1 AND user_id = $2
          AND status = 'scanning' AND quota_state = 'reserved'
          AND deletion_status = 'active'
      `,
      [attachmentId, userId]
    );
  }

  async rejectCompletion(
    attachmentId: string,
    userId: string,
    code: string,
    message: string
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const [target] = await transaction.unsafe(
        `
          SELECT declared_size_bytes, object_key
          FROM chat_attachment
          WHERE id = $1 AND user_id = $2
            AND status = 'scanning' AND quota_state = 'reserved'
          FOR UPDATE
        `,
        [attachmentId, userId]
      );
      const declaredSizeBytes = safeInteger(target?.declared_size_bytes);
      const objectKey = stringValue(target?.object_key);
      if (declaredSizeBytes === null || !objectKey) return;
      await transaction.unsafe(
        `
          UPDATE chat_storage_account
          SET reserved_bytes = reserved_bytes - $2, updated_at = NOW()
          WHERE user_id = $1
        `,
        [userId, declaredSizeBytes]
      );
      await transaction.unsafe(
        `
          UPDATE chat_attachment
          SET status = 'failed', parse_status = 'failed',
              quota_state = 'released', deletion_status = 'queued',
              failure_code = $3, failure_message = $4, updated_at = NOW()
          WHERE id = $1 AND user_id = $2
        `,
        [attachmentId, userId, code, message]
      );
      await transaction.unsafe(
        `
          INSERT INTO chat_storage_deletion_job (
            user_id, object_type, source_id, object_key
          ) VALUES ($1, 'attachment', $2, $3)
          ON CONFLICT (object_key) DO NOTHING
        `,
        [userId, attachmentId, objectKey]
      );
    });
  }

  async findOwned(
    attachmentId: string,
    userId: string
  ): Promise<ChatAttachmentView | null> {
    const [row] = await this.sql.unsafe(
      `
        SELECT ${ATTACHMENT_TARGET_SELECT}
        FROM chat_attachment a
        JOIN conversation c ON c.id = a.conversation_id
        WHERE a.id = $1 AND a.user_id = $2 AND c.user_id = $2
          AND c.status <> 'deleted' AND c.deleted_at IS NULL
        LIMIT 1
      `,
      [attachmentId, userId]
    );
    return row ? parseView(row) : null;
  }

  async findOwnedObject(
    attachmentId: string,
    userId: string
  ): Promise<ChatAttachmentTarget | null> {
    const [row] = await this.sql.unsafe(
      `
        SELECT ${ATTACHMENT_TARGET_SELECT}
        FROM chat_attachment a
        JOIN conversation c ON c.id = a.conversation_id
        WHERE a.id = $1 AND a.user_id = $2 AND c.user_id = $2
          AND c.status <> 'deleted' AND c.deleted_at IS NULL
        LIMIT 1
      `,
      [attachmentId, userId]
    );
    return row ? parseTarget(row) : null;
  }

  async bindToMessage(
    input: Parameters<ChatAttachmentRepository["bindToMessage"]>[0]
  ): Promise<ChatAttachmentView[]> {
    return this.sql.begin(async (transaction) => {
      const [ownedMessage] = await transaction.unsafe(
        `
          SELECT m.id
          FROM message m
          JOIN conversation c ON c.id = m.conversation_id
          WHERE m.id = $1 AND m.conversation_id = $2 AND m.user_id = $3
            AND m.role = 'user' AND c.user_id = $3
            AND c.status <> 'deleted' AND c.deleted_at IS NULL
          FOR UPDATE OF m
          FOR SHARE OF c
        `,
        [input.messageId, input.conversationId, input.userId]
      );
      if (!ownedMessage) throw notFound("消息");
      const alreadyBound = await transaction.unsafe(
        `
          SELECT id
          FROM chat_attachment
          WHERE user_id = $1 AND conversation_id = $2 AND message_id = $3
          FOR UPDATE
        `,
        [input.userId, input.conversationId, input.messageId]
      );
      const combinedIds = new Set([
        ...alreadyBound.map((row) => String(row.id)),
        ...input.attachmentIds
      ]);
      if (combinedIds.size > 5) {
        throw new ApiError(
          422,
          "ATTACHMENT_BIND_INVALID",
          "每条消息最多绑定 5 个附件。"
        );
      }
      const locked = await transaction.unsafe(
        `
          SELECT id
          FROM chat_attachment
          WHERE id = ANY($1::uuid[])
            AND user_id = $2 AND conversation_id = $3
            AND quota_state = 'committed' AND deletion_status = 'active'
            AND status = 'ready'
            AND parse_status IN ('ready', 'not_required')
            AND (message_id IS NULL OR message_id = $4)
          FOR UPDATE
        `,
        [
          input.attachmentIds,
          input.userId,
          input.conversationId,
          input.messageId
        ]
      );
      if (locked.length !== input.attachmentIds.length) {
        throw new ApiError(
          409,
          "ATTACHMENT_BIND_CONFLICT",
          "附件尚未解析就绪、已绑定其他消息或不属于当前会话。"
        );
      }
      const rows = await transaction.unsafe(
        `
          UPDATE chat_attachment
          SET message_id = $4, bound_at = COALESCE(bound_at, NOW()),
              updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND user_id = $2 AND conversation_id = $3
          RETURNING ${ATTACHMENT_RETURNING}
        `,
        [
          input.attachmentIds,
          input.userId,
          input.conversationId,
          input.messageId
        ]
      );
      return rows.map(parseView);
    });
  }

  async deleteUnbound(attachmentId: string, userId: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const [row] = await transaction.unsafe(
        `
          SELECT ${ATTACHMENT_TARGET_SELECT}, a.upload_expires_at
          FROM chat_attachment a
          JOIN conversation c ON c.id = a.conversation_id
          WHERE a.id = $1 AND a.user_id = $2 AND c.user_id = $2
            AND a.message_id IS NULL
            AND a.deletion_status = 'active'
            AND c.status <> 'deleted' AND c.deleted_at IS NULL
          FOR UPDATE OF a
        `,
        [attachmentId, userId]
      );
      const target = parseTarget(row);
      const uploadExpiresAt = timestampValue(row?.upload_expires_at);
      if (!target || !uploadExpiresAt) throw notFound("附件");

      await transaction.unsafe(
        `
          INSERT INTO chat_storage_deletion_job (
            user_id, object_type, source_id, object_key, run_at
          ) VALUES ($1, 'attachment', $2, $3, $4)
          ON CONFLICT (object_key) DO NOTHING
        `,
        [
          userId,
          target.id,
          target.objectKey,
          target.quotaState === "reserved"
            ? new Date(
                new Date(uploadExpiresAt).getTime() + 60_000
              ).toISOString()
            : new Date().toISOString()
        ]
      );

      await transaction.unsafe(
        `
          UPDATE chat_storage_account
          SET used_bytes = GREATEST(used_bytes - $2, 0),
              reserved_bytes = GREATEST(reserved_bytes - $3, 0),
              updated_at = NOW()
          WHERE user_id = $1
        `,
        [
          userId,
          target.quotaState === "committed" ? target.sizeBytes : 0,
          target.quotaState === "reserved" ? target.declaredSizeBytes : 0
        ]
      );
      await transaction.unsafe(
        "DELETE FROM chat_attachment WHERE id = $1 AND user_id = $2",
        [attachmentId, userId]
      );
    });
  }
}

export const chatAttachmentRepository = new PostgresChatAttachmentRepository();

const ATTACHMENT_RETURNING = `
  id,
  conversation_id,
  message_id,
  kind,
  original_filename,
  mime_type,
  COALESCE(size_bytes, declared_size_bytes) AS public_size_bytes,
  status,
  parse_status,
  failure_code,
  failure_message,
  created_at,
  updated_at,
  ready_at
`.trim();

const ATTACHMENT_TARGET_SELECT = `
  a.id,
  a.user_id,
  a.conversation_id,
  a.message_id,
  a.kind,
  a.original_filename,
  a.mime_type,
  COALESCE(a.size_bytes, a.declared_size_bytes) AS public_size_bytes,
  a.declared_size_bytes,
  a.sha256,
  a.object_key,
  a.status,
  a.parse_status,
  a.quota_state,
  a.deletion_status,
  a.failure_code,
  a.failure_message,
  a.created_at,
  a.updated_at,
  a.ready_at
`.trim();

function parseView(
  row: Record<string, unknown> | undefined
): ChatAttachmentView {
  if (!row) throw new Error("Chat attachment query returned no row.");
  const id = stringValue(row.id);
  const conversationId = stringValue(row.conversation_id);
  const kind =
    row.kind === "document" || row.kind === "image" ? row.kind : null;
  const filename = stringValue(row.original_filename);
  const mimeType = stringValue(row.mime_type);
  const sizeBytes = safeInteger(row.public_size_bytes);
  const status = attachmentStatus(row.status);
  const parseStatus = attachmentParseStatus(row.parse_status);
  const createdAt = timestampValue(row.created_at);
  const updatedAt = timestampValue(row.updated_at);
  if (
    !id ||
    !conversationId ||
    !kind ||
    !filename ||
    !mimeType ||
    sizeBytes === null ||
    !status ||
    !parseStatus ||
    !createdAt ||
    !updatedAt
  ) {
    throw new Error("Chat attachment row is malformed.");
  }
  return {
    id,
    conversationId,
    messageId: stringValue(row.message_id),
    kind,
    filename,
    mimeType,
    sizeBytes,
    status,
    parseStatus,
    failureCode: stringValue(row.failure_code),
    failureMessage: stringValue(row.failure_message),
    createdAt,
    updatedAt,
    readyAt: timestampValue(row.ready_at)
  };
}

function parseTarget(
  row: Record<string, unknown> | undefined
): ChatAttachmentTarget | null {
  if (!row) return null;
  const view = parseView(row);
  const userId = stringValue(row.user_id);
  const objectKey = stringValue(row.object_key);
  const declaredSizeBytes = safeInteger(row.declared_size_bytes);
  const sha256 = stringValue(row.sha256);
  const quotaState = quotaStateValue(row.quota_state);
  const deletionStatus = deletionStatusValue(row.deletion_status);
  if (
    !userId ||
    !objectKey ||
    declaredSizeBytes === null ||
    !sha256 ||
    !quotaState ||
    !deletionStatus
  ) {
    throw new Error("Chat attachment target row is malformed.");
  }
  return {
    ...view,
    userId,
    objectKey,
    declaredSizeBytes,
    sha256,
    quotaState,
    deletionStatus
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function safeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function timestampValue(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function attachmentStatus(value: unknown): ChatAttachmentView["status"] | null {
  return [
    "initiated",
    "uploading",
    "scanning",
    "processing",
    "ready",
    "failed",
    "deleted"
  ].includes(String(value))
    ? (value as ChatAttachmentView["status"])
    : null;
}

function attachmentParseStatus(
  value: unknown
): ChatAttachmentView["parseStatus"] | null {
  return ["not_required", "queued", "processing", "ready", "failed"].includes(
    String(value)
  )
    ? (value as ChatAttachmentView["parseStatus"])
    : null;
}

function quotaStateValue(
  value: unknown
): ChatAttachmentTarget["quotaState"] | null {
  return ["reserved", "committed", "released"].includes(String(value))
    ? (value as ChatAttachmentTarget["quotaState"])
    : null;
}

function deletionStatusValue(
  value: unknown
): ChatAttachmentTarget["deletionStatus"] | null {
  return ["active", "queued", "deleting", "deleted", "failed"].includes(
    String(value)
  )
    ? (value as ChatAttachmentTarget["deletionStatus"])
    : null;
}
