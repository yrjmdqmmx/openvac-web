import { sqlClient } from "@/server/db";
import { ApiError } from "@/server/api/errors";

import type {
  CurrentKnowledgeOriginalUpload,
  KnowledgeIngestionQueueState,
  KnowledgeOriginalUploadDraft,
  KnowledgeOriginalUploadDraftInput,
  KnowledgeOriginalUploadRepository
} from "./original-upload-service";

export interface KnowledgeUploadSql {
  unsafe(
    query: string,
    parameters?: unknown[]
  ): Promise<Array<Record<string, unknown>>>;
  begin<T>(
    handler: (transaction: KnowledgeUploadSql) => Promise<T>
  ): Promise<T>;
}

export class PostgresKnowledgeOriginalUploadRepository implements KnowledgeOriginalUploadRepository {
  constructor(
    private readonly sql: KnowledgeUploadSql = sqlClient as unknown as KnowledgeUploadSql
  ) {}

  async initiate(
    input: KnowledgeOriginalUploadDraftInput
  ): Promise<KnowledgeOriginalUploadDraft> {
    await this.sql.begin(async (transaction) => {
      const sourceId = input.sourceUrl
        ? await findExactGovernedSourceId(transaction, input.sourceUrl)
        : null;
      await transaction.unsafe(
        `
          INSERT INTO knowledge_document (
            id, source_id, title, description, language, mime_type, status,
            current_version_id, metadata, created_by, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, 'zh-CN', $5, $6,
            NULL, $7::jsonb, $8, NOW(), NOW()
          )
        `,
        [
          input.documentId,
          sourceId,
          input.title,
          input.description ?? null,
          input.mimeType,
          "processing",
          JSON.stringify({
            uploadStatus: "awaiting_object",
            rightsStatus: "pending",
            rightsDecision: "needs_human",
            ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {})
          }),
          input.uploadedBy
        ]
      );
      await transaction.unsafe(
        `
          INSERT INTO knowledge_version (
            id, document_id, version, content_hash, content,
            citation_metadata, status, object_key, metadata,
            created_by, created_at, updated_at
          ) VALUES (
            $1, $2, 1, NULL, '', $3::jsonb, $4, $5, $6::jsonb,
            $7, NOW(), NOW()
          )
        `,
        [
          input.versionId,
          input.documentId,
          JSON.stringify({
            ingestionMode: "full_text",
            ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {})
          }),
          "processing",
          input.objectKey,
          JSON.stringify({
            reviewStatus: "required",
            embeddingStatus: "pending_review",
            uploadStatus: "awaiting_object",
            rightsStatus: "pending",
            rightsDecision: "needs_human"
          }),
          input.uploadedBy
        ]
      );
      await transaction.unsafe(
        `
          INSERT INTO knowledge_original (
            version_id, object_key, original_filename, mime_type,
            size_bytes, sha256, uploaded_by, retention_policy,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        `,
        [
          input.versionId,
          input.objectKey,
          input.originalFilename,
          input.mimeType,
          input.sizeBytes,
          input.sha256,
          input.uploadedBy,
          input.retentionPolicy
        ]
      );
      await transaction.unsafe(
        `
          UPDATE knowledge_document
          SET current_version_id = $2, updated_at = NOW()
          WHERE id = $1
        `,
        [input.documentId, input.versionId]
      );
    });

    return {
      documentId: input.documentId,
      versionId: input.versionId,
      objectKey: input.objectKey,
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      retentionPolicy: input.retentionPolicy,
      status: "processing"
    };
  }

  async complete(
    versionId: string,
    uploadedBy: string,
    verify: (target: CurrentKnowledgeOriginalUpload) => Promise<void>
  ): Promise<KnowledgeIngestionQueueState> {
    return this.sql.begin(async (transaction) => {
      const [row] = await transaction.unsafe(
        `
          SELECT
            kd.id AS document_id,
            kv.id AS version_id,
            ko.object_key,
            ko.original_filename,
            ko.mime_type,
            ko.size_bytes,
            ko.sha256,
            ko.uploaded_by,
            task.id AS task_id,
            task.status AS task_status
          FROM knowledge_original ko
          JOIN knowledge_version kv ON kv.id = ko.version_id
          JOIN knowledge_document kd
            ON kd.id = kv.document_id
            AND kd.current_version_id = kv.id
          LEFT JOIN background_task task
            ON task.idempotency_key = 'knowledge-ingestion:' || kv.id::text || ':' || ko.sha256
          WHERE ko.version_id = $1
            AND ko.uploaded_by = $2
          FOR UPDATE OF kd, kv, ko
        `,
        [versionId, uploadedBy]
      );
      const target = parseTarget(row);
      if (!target) {
        throw new ApiError(
          404,
          "KNOWLEDGE_UPLOAD_NOT_FOUND",
          "上传记录不存在、已变化或不属于当前管理员。"
        );
      }
      await verify(target);
      const existing = parseQueueState(row, target);
      if (existing) return existing;
      const payload = {
        stage: "ocr_pending",
        documentId: target.documentId,
        versionId: target.versionId,
        objectKey: target.objectKey,
        filename: target.originalFilename
      };
      const idempotencyKey = `knowledge-ingestion:${target.versionId}:${target.sha256}`;
      const [task] = await transaction.unsafe(
        `
          INSERT INTO background_task (
            type, status, priority, idempotency_key, payload,
            attempts, max_attempts, run_at, created_by_user_id,
            created_at, updated_at
          ) VALUES ($1, 'queued', 0, $2, $3::jsonb, 0, 3, NOW(), $4, NOW(), NOW())
          ON CONFLICT (idempotency_key) DO UPDATE
          SET idempotency_key = EXCLUDED.idempotency_key
          RETURNING id, status
        `,
        [
          "knowledge_ingestion",
          idempotencyKey,
          JSON.stringify(payload),
          uploadedBy
        ]
      );
      const taskId = stringValue(task?.id);
      const taskStatus = operationStatus(task?.status);
      if (!taskId || !taskStatus) {
        throw new Error("Knowledge ingestion queue did not return a task.");
      }
      await transaction.unsafe(
        `
          UPDATE knowledge_version
          SET status = 'processing',
              metadata = metadata || '{"uploadStatus":"verified"}'::jsonb,
              updated_at = NOW()
          WHERE id = $1 AND document_id = $2
        `,
        [target.versionId, target.documentId]
      );
      await transaction.unsafe(
        `
          UPDATE knowledge_document
          SET status = 'processing',
              metadata = metadata || '{"uploadStatus":"verified"}'::jsonb,
              updated_at = NOW()
          WHERE id = $1 AND current_version_id = $2
        `,
        [target.documentId, target.versionId]
      );
      return {
        taskId,
        taskStatus,
        documentId: target.documentId,
        versionId: target.versionId,
        stage: "ocr_pending"
      };
    });
  }
}

export const knowledgeOriginalUploadRepository =
  new PostgresKnowledgeOriginalUploadRepository();

async function findExactGovernedSourceId(
  sql: KnowledgeUploadSql,
  sourceUrl: string
): Promise<string | null> {
  const rows = await sql.unsafe(
    `
      SELECT id
      FROM knowledge_source
      WHERE canonical_url = $1
        AND enabled = TRUE
        AND deleted_at IS NULL
      ORDER BY id
      LIMIT 2
      FOR SHARE
    `,
    [sourceUrl]
  );
  return rows.length === 1 ? stringValue(rows[0]?.id) : null;
}

function parseTarget(
  row: Record<string, unknown> | undefined
): CurrentKnowledgeOriginalUpload | null {
  if (!row) return null;
  const documentId = stringValue(row.document_id);
  const versionId = stringValue(row.version_id);
  const objectKey = stringValue(row.object_key);
  const originalFilename = stringValue(row.original_filename);
  const mimeType = stringValue(row.mime_type);
  const sha256 = stringValue(row.sha256);
  const uploadedBy = stringValue(row.uploaded_by);
  const sizeBytes = Number(row.size_bytes);
  if (
    !documentId ||
    !versionId ||
    !objectKey ||
    !originalFilename ||
    !mimeType ||
    !sha256 ||
    !uploadedBy ||
    !Number.isSafeInteger(sizeBytes)
  ) {
    return null;
  }
  return {
    documentId,
    versionId,
    objectKey,
    originalFilename,
    mimeType,
    sizeBytes,
    sha256,
    uploadedBy
  };
}

function parseQueueState(
  row: Record<string, unknown> | undefined,
  target: CurrentKnowledgeOriginalUpload
): KnowledgeIngestionQueueState | null {
  const taskId = stringValue(row?.task_id);
  const taskStatus = operationStatus(row?.task_status);
  return taskId && taskStatus
    ? {
        taskId,
        taskStatus,
        documentId: target.documentId,
        versionId: target.versionId,
        stage: "ocr_pending"
      }
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function operationStatus(
  value: unknown
): KnowledgeIngestionQueueState["taskStatus"] | null {
  return value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : null;
}
