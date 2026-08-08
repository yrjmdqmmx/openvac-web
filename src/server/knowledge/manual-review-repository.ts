import { createHash } from "node:crypto";

import { ApiError } from "@/server/api/errors";
import { sqlClient } from "@/server/db";

import { KNOWLEDGE_AUTOMATION_POLICY_VERSION } from "./review-policy";
import {
  assertKnowledgePublicationEvidence,
  assertKnowledgeSourceAuthorized,
  isKnowledgeSourceTier,
  KnowledgeSourcePolicyError
} from "./source-policy";
import type {
  KnowledgeManualResolutionInput,
  KnowledgeManualReviewOutcome,
  KnowledgeManualReviewRepository,
  KnowledgeManualReviewTarget
} from "./manual-review-service";

export interface KnowledgeManualReviewSql {
  unsafe(
    query: string,
    parameters?: unknown[]
  ): Promise<Array<Record<string, unknown>>>;
  begin<T>(
    handler: (transaction: KnowledgeManualReviewSql) => Promise<T>
  ): Promise<T>;
}

type CurrentTarget = {
  documentId: string;
  versionId: string;
  version: number;
  content: string;
  contentHash: string;
  citationMetadata: Record<string, unknown>;
  versionMetadata: Record<string, unknown>;
  objectKey: string | null;
  parserVersion: string | null;
  sourceUpdatedAt: unknown;
  createdBy: string;
  sourceId: string | null;
};

export class PostgresKnowledgeManualReviewRepository implements KnowledgeManualReviewRepository {
  constructor(
    private readonly sql: KnowledgeManualReviewSql = sqlClient as unknown as KnowledgeManualReviewSql
  ) {}

  retry(
    input: KnowledgeManualReviewTarget
  ): Promise<KnowledgeManualReviewOutcome> {
    return this.sql.begin(async (transaction) => {
      const target = await resolveCurrentSourceLink(
        transaction,
        await loadCurrentTarget(transaction, input)
      );
      await assertCurrentSourceRights(transaction, target);
      const taskId = await queueAutomationRun(transaction, target, "initial");
      await audit(transaction, input, "knowledge.automation_review.retry", {
        versionId: target.versionId,
        contentHash: target.contentHash,
        taskId
      });
      return outcome("retry", target, "queued", taskId);
    });
  }

  resolve(
    input: KnowledgeManualResolutionInput
  ): Promise<KnowledgeManualReviewOutcome> {
    return this.sql.begin(async (transaction) => {
      let target = await loadCurrentTarget(transaction, input);
      if (input.action === "archive") {
        await transaction.unsafe(
          `
            UPDATE knowledge_version SET status = 'archived', updated_at = NOW()
            WHERE id = $1 AND content_hash = $2
          `,
          [target.versionId, target.contentHash]
        );
        await transaction.unsafe(
          `
            UPDATE knowledge_document SET status = 'archived', updated_at = NOW()
            WHERE id = $1 AND current_version_id = $2
          `,
          [target.documentId, target.versionId]
        );
        await audit(transaction, input, "knowledge.manual_review.archived", {
          versionId: target.versionId,
          contentHash: target.contentHash,
          note: input.note ?? null
        });
        return outcome(input.action, target, "archived");
      }

      target = await resolveCurrentSourceLink(transaction, target);
      await assertCurrentSourceRights(transaction, target);
      if (input.action === "manual_approve_with_note") {
        const review = {
          status: "approved",
          mode: "manual_document_resolution",
          reviewedBy: input.actorId,
          reviewedAt: new Date().toISOString(),
          contentHash: target.contentHash,
          note: input.note
        };
        const fullText = target.citationMetadata.ingestionMode === "full_text";
        const updated = await transaction.unsafe(
          `
            UPDATE knowledge_version
            SET status = $3,
                published_at = CASE WHEN $3 = 'published' THEN NOW() ELSE published_at END,
                metadata = metadata || $4::jsonb,
                updated_at = NOW()
            WHERE id = $1 AND content_hash = $2
            RETURNING id
          `,
          [
            target.versionId,
            target.contentHash,
            fullText ? "review" : "published",
            JSON.stringify({
              reviewStatus: "approved",
              embeddingStatus: fullText ? "queued" : "not_applicable",
              review
            })
          ]
        );
        if (updated.length !== 1) throw conflict();
        let taskId: string | undefined;
        if (fullText) {
          const tasks = await transaction.unsafe(
            `
              INSERT INTO background_task (
                type, status, priority, idempotency_key, payload,
                attempts, max_attempts, run_at, created_by_user_id,
                created_at, updated_at
              ) VALUES ('knowledge_ingestion', 'queued', 10, $1, $2::jsonb,
                0, 3, NOW(), $3, NOW(), NOW())
              ON CONFLICT (idempotency_key) DO UPDATE
              SET idempotency_key = EXCLUDED.idempotency_key
              RETURNING id, status
            `,
            [
              `knowledge-embedding:${target.versionId}:${target.contentHash}:manual`,
              JSON.stringify({
                stage: "embedding_pending",
                documentId: target.documentId,
                versionId: target.versionId,
                review
              }),
              input.actorId
            ]
          );
          taskId = requiredString(tasks[0]?.id);
        }
        await transaction.unsafe(
          `UPDATE knowledge_document SET status = $3, updated_at = NOW()
           WHERE id = $1 AND current_version_id = $2`,
          [
            target.documentId,
            target.versionId,
            fullText ? "review" : "published"
          ]
        );
        await audit(transaction, input, "knowledge.manual_review.approved", {
          versionId: target.versionId,
          contentHash: target.contentHash,
          note: input.note,
          sourceRightsRevalidated: true,
          taskId: taskId ?? null
        });
        return outcome(input.action, target, "approved", taskId);
      }

      if (input.action === "manual_edit_and_retry") {
        const contentHash = sha256(input.revisedContent);
        const versionId = crypto.randomUUID();
        const inserted = await transaction.unsafe(
          `
            INSERT INTO knowledge_version (
              id, document_id, version, content_hash, content, citation_metadata,
              status, object_key, parser_version, source_updated_at, metadata,
              created_by, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'review', $7, $8, $9,
              $10::jsonb, $11, NOW(), NOW())
            RETURNING id
          `,
          [
            versionId,
            target.documentId,
            target.version + 1,
            contentHash,
            input.revisedContent,
            JSON.stringify(target.citationMetadata),
            target.objectKey,
            target.parserVersion,
            target.sourceUpdatedAt,
            JSON.stringify({
              ...target.versionMetadata,
              reviewStatus: "required",
              embeddingStatus: "pending_review",
              originalReferenceVersionId: target.versionId,
              manualResolutionNote: input.note ?? null
            }),
            target.createdBy
          ]
        );
        if (inserted.length !== 1) throw conflict();
        await transaction.unsafe(
          `UPDATE knowledge_document SET current_version_id = $2, status = 'review', updated_at = NOW()
           WHERE id = $1 AND current_version_id = $3`,
          [target.documentId, versionId, target.versionId]
        );
        const revisedTarget = { ...target, versionId, contentHash };
        const taskId = await queueAutomationRun(
          transaction,
          revisedTarget,
          "initial"
        );
        await audit(
          transaction,
          input,
          "knowledge.manual_review.edited_retry",
          {
            previousVersionId: target.versionId,
            versionId,
            contentHash,
            note: input.note ?? null,
            taskId
          }
        );
        return outcome(input.action, revisedTarget, "queued", taskId);
      }

      const taskId = await queueAutomationRun(transaction, target, "verify");
      await audit(transaction, input, "knowledge.manual_review.adopted_retry", {
        versionId: target.versionId,
        contentHash: target.contentHash,
        note: input.note ?? null,
        taskId
      });
      return outcome(input.action, target, "queued", taskId);
    });
  }
}

export const knowledgeManualReviewRepository =
  new PostgresKnowledgeManualReviewRepository();

async function loadCurrentTarget(
  sql: KnowledgeManualReviewSql,
  input: KnowledgeManualReviewTarget
): Promise<CurrentTarget> {
  const rows = await sql.unsafe(
    `
      SELECT
        kd.id AS document_id, kv.id AS version_id, kv.version, kv.content,
        kv.content_hash, kv.citation_metadata, kv.metadata AS version_metadata,
        kv.object_key, kv.parser_version, kv.source_updated_at, kv.created_by,
        ks.id AS source_id, ks.source_tier, ks.enabled AS source_enabled,
        ks.deleted_at AS source_deleted_at, ks.canonical_url, ks.publisher,
        ks.metadata AS source_metadata
      FROM knowledge_document kd
      JOIN knowledge_version kv ON kd.current_version_id = kv.id
      LEFT JOIN knowledge_source ks ON kd.source_id = ks.id
      WHERE kd.id = $1
        AND kd.current_version_id = kv.id
        AND kv.id = $2
        AND kv.content_hash = $3
        AND kd.status IN ('processing', 'review', 'failed', 'draft')
      FOR UPDATE OF kd, kv
    `,
    [input.documentId, input.expectedVersionId, input.expectedContentHash]
  );
  const row = rows[0];
  if (!row) throw conflict();
  return {
    documentId: requiredString(row.document_id),
    versionId: requiredString(row.version_id),
    version: Number(row.version),
    content: requiredString(row.content),
    contentHash: requiredString(row.content_hash),
    citationMetadata: recordValue(row.citation_metadata),
    versionMetadata: recordValue(row.version_metadata),
    objectKey: stringValue(row.object_key),
    parserVersion: stringValue(row.parser_version),
    sourceUpdatedAt: row.source_updated_at ?? null,
    createdBy: requiredString(row.created_by),
    sourceId: stringValue(row.source_id)
  };
}

async function assertCurrentSourceRights(
  sql: KnowledgeManualReviewSql,
  target: CurrentTarget
): Promise<void> {
  try {
    const rows = target.sourceId
      ? await sql.unsafe(
          `
            SELECT source_tier, enabled AS source_enabled, deleted_at AS source_deleted_at,
                   canonical_url, publisher, metadata AS source_metadata
            FROM knowledge_source WHERE id = $1 FOR UPDATE
          `,
          [target.sourceId]
        )
      : [];
    const row = rows[0];
    const source =
      row && isKnowledgeSourceTier(row.source_tier)
        ? {
            sourceTier: row.source_tier,
            enabled: row.source_enabled === true,
            deletedAt:
              row.source_deleted_at instanceof Date ||
              typeof row.source_deleted_at === "string"
                ? row.source_deleted_at
                : null,
            canonicalUrl: stringValue(row.canonical_url),
            publisher: stringValue(row.publisher),
            metadata: recordValue(row.source_metadata)
          }
        : undefined;
    assertKnowledgeSourceAuthorized(source, target.citationMetadata);
    assertKnowledgePublicationEvidence(source, target.citationMetadata);
  } catch (error) {
    if (error instanceof KnowledgeSourcePolicyError) {
      throw new ApiError(
        409,
        "KNOWLEDGE_SOURCE_RIGHTS_INVALID",
        error.message,
        { sourcePolicyCode: error.code }
      );
    }
    throw error;
  }
}

async function resolveCurrentSourceLink(
  sql: KnowledgeManualReviewSql,
  target: CurrentTarget
): Promise<CurrentTarget> {
  if (target.sourceId) return target;
  const sourceUrl = stringValue(target.citationMetadata.sourceUrl);
  if (!sourceUrl) return target;

  const sources = await sql.unsafe(
    `
      SELECT id
      FROM knowledge_source
      WHERE canonical_url = $1
        AND enabled = TRUE
        AND deleted_at IS NULL
      ORDER BY id
      LIMIT 2
      FOR UPDATE
    `,
    [sourceUrl]
  );
  const sourceId = sources.length === 1 ? stringValue(sources[0]?.id) : null;
  if (!sourceId) return target;

  const linked = await sql.unsafe(
    `
      UPDATE knowledge_document
      SET source_id = $2, updated_at = NOW()
      WHERE id = $1
        AND source_id IS NULL
        AND current_version_id = $3
      RETURNING source_id
    `,
    [target.documentId, sourceId, target.versionId]
  );
  if (stringValue(linked[0]?.source_id) !== sourceId) throw conflict();
  return { ...target, sourceId };
}

async function queueAutomationRun(
  sql: KnowledgeManualReviewSql,
  target: Pick<CurrentTarget, "versionId" | "contentHash">,
  phase: "initial" | "verify"
): Promise<string> {
  const rows = await sql.unsafe(
    `
      INSERT INTO knowledge_review_run (
        phase, status, input_version_id, input_content_hash,
        model, prompt_version, created_at, updated_at
      ) VALUES ($1, 'queued', $2, $3, 'gpt-5.5-codex', $4, NOW(), NOW())
      ON CONFLICT (input_version_id, input_content_hash, prompt_version, phase)
      DO UPDATE SET status = 'queued', risk = NULL, decision = NULL,
        structured_report = '{}'::jsonb, revised_version_id = NULL,
        completed_at = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
        updated_at = NOW()
      WHERE knowledge_review_run.status IN ('failed', 'needs_human', 'queued')
      RETURNING id
    `,
    [
      phase,
      target.versionId,
      target.contentHash,
      KNOWLEDGE_AUTOMATION_POLICY_VERSION
    ]
  );
  if (!rows[0]) {
    throw new ApiError(
      409,
      "KNOWLEDGE_REVIEW_RETRY_CONFLICT",
      "当前审核任务仍在运行或已完成，不能重复排队。"
    );
  }
  return requiredString(rows[0].id);
}

async function audit(
  sql: KnowledgeManualReviewSql,
  input: KnowledgeManualReviewTarget,
  action: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await sql.unsafe(
    `
      INSERT INTO audit_log (
        actor_user_id, actor_role, action, target_type, target_id,
        request_id, metadata, created_at
      ) VALUES ($1, $2, '${action}', 'knowledge_document', $3, $4, $5::jsonb, NOW())
    `,
    [
      input.actorId,
      input.actorRole,
      input.documentId,
      input.requestId,
      JSON.stringify(metadata)
    ]
  );
}

function outcome(
  action: KnowledgeManualReviewOutcome["action"],
  target: Pick<CurrentTarget, "documentId" | "versionId" | "contentHash">,
  status: KnowledgeManualReviewOutcome["status"],
  taskId?: string
): KnowledgeManualReviewOutcome {
  return {
    action,
    documentId: target.documentId,
    versionId: target.versionId,
    contentHash: target.contentHash,
    status,
    ...(taskId ? { taskId } : {})
  };
}

function conflict(): ApiError {
  return new ApiError(
    409,
    "KNOWLEDGE_REVIEW_CONFLICT",
    "知识内容或版本已变化，请刷新详情后重新处理。"
  );
}

function requiredString(value: unknown): string {
  const parsed = stringValue(value);
  if (!parsed)
    throw new Error("Knowledge manual review database row is invalid.");
  return parsed;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
