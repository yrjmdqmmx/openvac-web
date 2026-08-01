import { createHash } from "node:crypto";

import { sqlClient } from "@/server/db";
import {
  assertKnowledgeSourceAuthorized,
  isKnowledgeSourceTier
} from "@/server/knowledge/source-policy";
import { ProviderError, type ParsedDocument } from "@/server/providers";

import type {
  ApprovedKnowledgeContent,
  EmbeddedKnowledgeChunk,
  KnowledgeIngestionJob,
  KnowledgeIngestionPayload,
  KnowledgeIngestionRepository
} from "./types";

export interface WorkerSql {
  unsafe(
    query: string,
    parameters?: unknown[]
  ): Promise<Array<Record<string, unknown>>>;
  begin<T>(handler: (transaction: WorkerSql) => Promise<T>): Promise<T>;
}

export class StaleWorkerLeaseError extends Error {
  constructor(jobId: string) {
    super(`Knowledge worker lease for ${jobId} is no longer current.`);
    this.name = "StaleWorkerLeaseError";
  }
}

export class PostgresKnowledgeIngestionRepository implements KnowledgeIngestionRepository {
  private readonly sql: WorkerSql;

  constructor(client: WorkerSql = sqlClient as unknown as WorkerSql) {
    this.sql = client;
  }

  async claimNext(workerId: string): Promise<KnowledgeIngestionJob | null> {
    const rows = await this.sql.unsafe(CLAIM_NEXT_SQL, [workerId]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    try {
      return parseJob(row);
    } catch (cause) {
      const error =
        cause instanceof Error
          ? cause
          : new Error("Malformed knowledge task", { cause });
      await this.sql.unsafe(
        `
          UPDATE background_task
          SET
            status = 'failed',
            last_error = $2,
            completed_at = NOW(),
            locked_at = NULL,
            locked_by = NULL,
            lease_token = NULL,
            updated_at = NOW()
          WHERE id = $1
            AND locked_by = $3
            AND lease_token = $4::uuid
        `,
        [
          String(row.id ?? ""),
          safeErrorMessage(error),
          typeof row.locked_by === "string" ? row.locked_by : "",
          typeof row.lease_token === "string" ? row.lease_token : null
        ]
      );
      return null;
    }
  }

  async renewLease(job: KnowledgeIngestionJob): Promise<void> {
    const rows = await this.sql.unsafe(
      `
        UPDATE background_task
        SET locked_at = NOW(), updated_at = NOW()
        WHERE id = $1
          AND status = 'running'
          AND locked_by = $2
          AND lease_token = $3::uuid
        RETURNING id
      `,
      [job.id, job.workerId, job.leaseToken]
    );
    assertOneLeaseRow(job, rows);
  }

  async markOcrSubmitted(
    job: KnowledgeIngestionJob,
    parserJobId: string,
    retryAt: Date
  ): Promise<void> {
    await this.requeue(job, retryAt, {
      ...job.payload,
      stage: "ocr_processing",
      parserJobId,
      parserSubmittedAt: new Date().toISOString(),
      parserPollCount: 0
    });
  }

  async deferOcrPoll(job: KnowledgeIngestionJob, retryAt: Date): Promise<void> {
    await this.requeue(job, retryAt, {
      ...job.payload,
      stage: "ocr_processing",
      parserPollCount: (job.payload.parserPollCount ?? 0) + 1
    });
  }

  async saveParsedForReview(
    job: KnowledgeIngestionJob,
    parsed: ParsedDocument,
    renderedContent: string
  ): Promise<void> {
    const contentHash = sha256(renderedContent);
    await this.sql.begin(async (transaction) => {
      await assertCurrentLease(transaction, job, true);
      const versions = await transaction.unsafe(
        `
          UPDATE knowledge_version
          SET
            content = $2,
            content_hash = $5,
            parser_version = 'alibaba-docmind-vlm',
            status = 'review',
            metadata = (metadata - 'review') || $3::jsonb,
            updated_at = NOW()
          WHERE id = $1 AND document_id = $4
          RETURNING id
        `,
        [
          job.payload.versionId,
          renderedContent,
          JSON.stringify({
            reviewStatus: "required",
            embeddingStatus: "pending_review",
            parserJobId: parsed.jobId,
            parsedPageCount: parsed.pages.length
          }),
          job.payload.documentId,
          contentHash
        ]
      );
      if (versions.length !== 1) {
        throw new Error("OCR target knowledge version no longer exists.");
      }
      const documents = await transaction.unsafe(
        `
          UPDATE knowledge_document
          SET status = 'review', updated_at = NOW()
          WHERE id = $1 AND current_version_id = $2
          RETURNING id
        `,
        [job.payload.documentId, job.payload.versionId]
      );
      if (documents.length !== 1) {
        throw new Error("OCR target is no longer the current draft.");
      }
      const taskRows = await transaction.unsafe(
        `
          UPDATE background_task
          SET
            status = 'succeeded',
            result = $2::jsonb,
            completed_at = NOW(),
            locked_at = NULL,
            locked_by = NULL,
            lease_token = NULL,
            updated_at = NOW()
          WHERE id = $1
            AND status = 'running'
            AND locked_by = $3
            AND lease_token = $4::uuid
          RETURNING id
        `,
        [
          job.id,
          JSON.stringify({
            stage: "review_required",
            documentId: job.payload.documentId,
            versionId: job.payload.versionId,
            parserJobId: parsed.jobId,
            contentHash,
            manualReviewRequired: true
          }),
          job.workerId,
          job.leaseToken
        ]
      );
      assertOneLeaseRow(job, taskRows);
    });
  }

  async markReviewRequired(
    job: KnowledgeIngestionJob,
    reason: string
  ): Promise<void> {
    const rows = await this.sql.unsafe(
      `
        UPDATE background_task
        SET
          status = 'succeeded',
          result = $2::jsonb,
          completed_at = NOW(),
          locked_at = NULL,
          locked_by = NULL,
          lease_token = NULL,
          updated_at = NOW()
        WHERE id = $1
          AND status = 'running'
          AND locked_by = $3
          AND lease_token = $4::uuid
        RETURNING id
      `,
      [
        job.id,
        JSON.stringify({
          stage: "review_required",
          documentId: job.payload.documentId,
          versionId: job.payload.versionId,
          manualReviewRequired: true,
          reason
        }),
        job.workerId,
        job.leaseToken
      ]
    );
    assertOneLeaseRow(job, rows);
  }

  async loadApprovedContent(
    job: KnowledgeIngestionJob
  ): Promise<ApprovedKnowledgeContent | null> {
    await assertCurrentLease(this.sql, job, false);
    const rows = await this.sql.unsafe(
      `
        SELECT
          kv.document_id,
          kv.id AS version_id,
          kv.content,
          kv.citation_metadata,
          ks.source_tier,
          ks.enabled AS source_enabled,
          ks.deleted_at AS source_deleted_at,
          ks.canonical_url,
          ks.publisher,
          ks.metadata AS source_metadata
        FROM knowledge_version kv
        JOIN knowledge_document kd ON kd.id = kv.document_id
        JOIN knowledge_source ks ON ks.id = kd.source_id
        WHERE
          kv.id = $1
          AND kv.document_id = $2
          AND kd.current_version_id = kv.id
          AND kv.status = 'review'
          AND kd.status = 'review'
          AND kv.content_hash = $3
          AND kv.metadata ->> 'reviewStatus' = 'approved'
          AND kv.metadata #>> '{review,status}' = 'approved'
          AND kv.metadata #>> '{review,contentHash}' = $3
          AND kv.citation_metadata ->> 'ingestionMode' = 'full_text'
        LIMIT 1
      `,
      [
        job.payload.versionId,
        job.payload.documentId,
        job.payload.review?.contentHash ?? null
      ]
    );
    const row = rows[0];
    if (
      !row ||
      typeof row.document_id !== "string" ||
      typeof row.version_id !== "string" ||
      typeof row.content !== "string" ||
      !isKnowledgeSourceTier(row.source_tier)
    ) {
      return null;
    }
    try {
      assertKnowledgeSourceAuthorized(
        {
          sourceTier: row.source_tier,
          enabled: row.source_enabled === true,
          deletedAt:
            row.source_deleted_at instanceof Date ||
            typeof row.source_deleted_at === "string"
              ? row.source_deleted_at
              : null,
          canonicalUrl:
            typeof row.canonical_url === "string" ? row.canonical_url : null,
          publisher: typeof row.publisher === "string" ? row.publisher : null,
          metadata: recordValue(row.source_metadata)
        },
        recordValue(row.citation_metadata)
      );
    } catch {
      return null;
    }
    return {
      documentId: row.document_id,
      versionId: row.version_id,
      content: row.content
    };
  }

  async saveEmbeddingsAndComplete(
    job: KnowledgeIngestionJob,
    chunks: EmbeddedKnowledgeChunk[]
  ): Promise<void> {
    const review = job.payload.review;
    if (
      review?.status !== "approved" ||
      !review.reviewedBy.trim() ||
      !isValidDate(review.reviewedAt) ||
      !/^[a-f0-9]{64}$/u.test(review.contentHash)
    ) {
      throw new Error("Embedding completion requires valid human review.");
    }

    await this.sql.begin(async (transaction) => {
      await assertCurrentLease(transaction, job, true);
      await transaction.unsafe(
        "DELETE FROM knowledge_chunk WHERE version_id = $1",
        [job.payload.versionId]
      );
      for (const chunk of chunks) {
        await transaction.unsafe(
          `
            INSERT INTO knowledge_chunk (
              version_id,
              chunk_index,
              content,
              page_start,
              page_end,
              section_path,
              metadata,
              embedding,
              embedding_model,
              embedded_at
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6::text[],
              $7::jsonb,
              $8::vector(1024),
              $9,
              NOW()
            )
          `,
          [
            job.payload.versionId,
            chunk.chunkIndex,
            chunk.content,
            chunk.pageStart ?? null,
            chunk.pageEnd ?? null,
            chunk.sectionPath,
            JSON.stringify(chunk.metadata),
            `[${chunk.embedding.join(",")}]`,
            chunk.embeddingModel
          ]
        );
      }
      const versions = await transaction.unsafe(
        `
          UPDATE knowledge_version
          SET
            content_hash = $3,
            status = 'review',
            metadata = metadata || $2::jsonb,
            updated_at = NOW()
          WHERE
            id = $1
            AND document_id = $4
            AND status = 'review'
            AND content_hash = $3
          RETURNING id
        `,
        [
          job.payload.versionId,
          JSON.stringify({
            reviewStatus: "approved",
            embeddingStatus: "completed",
            embeddedChunkCount: chunks.length,
            review
          }),
          review.contentHash,
          job.payload.documentId
        ]
      );
      if (versions.length !== 1) {
        throw new Error(
          "Reviewed knowledge content changed before embeddings were saved."
        );
      }
      const documents = await transaction.unsafe(
        `
          UPDATE knowledge_document
          SET status = 'review', updated_at = NOW()
          WHERE
            id = $1
            AND current_version_id = $2
            AND status = 'review'
          RETURNING id
        `,
        [job.payload.documentId, job.payload.versionId]
      );
      if (documents.length !== 1) {
        throw new Error(
          "Reviewed knowledge version is no longer the current document version."
        );
      }
      const taskRows = await transaction.unsafe(
        `
          UPDATE background_task
          SET
            status = 'succeeded',
            result = $2::jsonb,
            completed_at = NOW(),
            locked_at = NULL,
            locked_by = NULL,
            lease_token = NULL,
            updated_at = NOW()
          WHERE id = $1
            AND status = 'running'
            AND locked_by = $3
            AND lease_token = $4::uuid
          RETURNING id
        `,
        [
          job.id,
          JSON.stringify({
            stage: "completed",
            documentId: job.payload.documentId,
            versionId: job.payload.versionId,
            embeddedChunkCount: chunks.length,
            readyToPublish: true
          }),
          job.workerId,
          job.leaseToken
        ]
      );
      assertOneLeaseRow(job, taskRows);
    });
  }

  async markFailed(
    job: KnowledgeIngestionJob,
    error: Error,
    retryAt: Date
  ): Promise<void> {
    const terminal =
      job.attempts >= job.maxAttempts ||
      (error instanceof ProviderError && !error.retryable);
    const rows = await this.sql.unsafe(
      `
        UPDATE background_task
        SET
          status = $2,
          run_at = $3,
          last_error = $4,
          locked_at = NULL,
          locked_by = NULL,
          lease_token = NULL,
          completed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE NULL END,
          updated_at = NOW()
        WHERE id = $1
          AND status = 'running'
          AND locked_by = $5
          AND lease_token = $6::uuid
        RETURNING id
      `,
      [
        job.id,
        terminal ? "failed" : "queued",
        retryAt,
        safeErrorMessage(error),
        job.workerId,
        job.leaseToken
      ]
    );
    assertOneLeaseRow(job, rows);
  }

  private async requeue(
    job: KnowledgeIngestionJob,
    retryAt: Date,
    payload: KnowledgeIngestionPayload
  ): Promise<void> {
    const rows = await this.sql.unsafe(
      `
        UPDATE background_task
        SET
          status = 'queued',
          attempts = GREATEST(attempts - 1, 0),
          payload = $2::jsonb,
          run_at = $3,
          locked_at = NULL,
          locked_by = NULL,
          lease_token = NULL,
          updated_at = NOW()
        WHERE id = $1
          AND status = 'running'
          AND locked_by = $4
          AND lease_token = $5::uuid
        RETURNING id
      `,
      [job.id, JSON.stringify(payload), retryAt, job.workerId, job.leaseToken]
    );
    assertOneLeaseRow(job, rows);
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isValidDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

const CLAIM_NEXT_SQL = `
WITH candidate AS (
  SELECT id
  FROM background_task
  WHERE
    type = 'knowledge_ingestion'
    AND (
      (status = 'queued' AND run_at <= NOW())
      OR (
        status = 'running'
        AND locked_at < NOW() - INTERVAL '15 minutes'
      )
    )
  ORDER BY priority DESC, run_at ASC, created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE background_task task
SET
  status = 'running',
  attempts = attempts + 1,
  locked_at = NOW(),
  locked_by = $1,
  lease_token = gen_random_uuid(),
  updated_at = NOW()
FROM candidate
WHERE task.id = candidate.id
RETURNING
  task.id,
  task.payload,
  task.attempts,
  task.max_attempts,
  task.locked_by,
  task.lease_token
`.trim();

function parseJob(row: Record<string, unknown>): KnowledgeIngestionJob {
  const payload = recordValue(row.payload);
  const stage = payload.stage;
  if (
    typeof row.id !== "string" ||
    typeof row.locked_by !== "string" ||
    typeof row.lease_token !== "string" ||
    typeof payload.documentId !== "string" ||
    typeof payload.versionId !== "string" ||
    !isStage(stage)
  ) {
    throw new Error("Malformed knowledge_ingestion background task payload.");
  }
  return {
    id: row.id,
    workerId: row.locked_by,
    leaseToken: row.lease_token,
    attempts: numberValue(row.attempts, 1),
    maxAttempts: numberValue(row.max_attempts, 3),
    payload: payload as unknown as KnowledgeIngestionPayload
  };
}

function isStage(value: unknown): value is KnowledgeIngestionPayload["stage"] {
  return [
    "ocr_pending",
    "ocr_processing",
    "review_required",
    "embedding_pending",
    "embedding_processing",
    "completed"
  ].includes(String(value));
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeErrorMessage(error: Error): string {
  return `${error.name}: ${error.message}`.slice(0, 2_000);
}

async function assertCurrentLease(
  database: WorkerSql,
  job: KnowledgeIngestionJob,
  lock: boolean
): Promise<void> {
  const rows = await database.unsafe(
    `
      SELECT id
      FROM background_task
      WHERE id = $1
        AND status = 'running'
        AND locked_by = $2
        AND lease_token = $3::uuid
      ${lock ? "FOR UPDATE" : ""}
    `,
    [job.id, job.workerId, job.leaseToken]
  );
  assertOneLeaseRow(job, rows);
}

function assertOneLeaseRow(
  job: KnowledgeIngestionJob,
  rows: Array<Record<string, unknown>>
): void {
  if (rows.length !== 1) {
    throw new StaleWorkerLeaseError(job.id);
  }
}
