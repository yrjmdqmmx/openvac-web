import { createHash, randomUUID } from "node:crypto";

import { sqlClient } from "@/server/db";
import { recoverStaleAgentRuns } from "@/server/agent/retention";
import {
  ProviderError,
  type DocumentParser,
  type ObjectStorage,
  type ParsedDocument
} from "@/server/providers";

const POLL_INTERVAL_MS = 5_000;
const RETRY_DELAY_MS = 30_000;
const MAX_CHUNK_CHARACTERS = 8_000;
const CHUNK_OVERLAP_CHARACTERS = 200;
const MAX_CHUNKS = 4_096;
const MAX_WORKER_CONCURRENCY = 4;
const DEFAULT_MAX_PARSER_POLLS = 240;
const DEFAULT_MAX_PARSER_AGE_MS = 2 * 60 * 60 * 1_000;
const DEFAULT_LEASE_HEARTBEAT_MS = 60_000;

export type PrivateAttachmentChunk = {
  ordinal: number;
  content: string;
  contentHash: string;
  locator: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type ChatAttachmentParseJob = {
  id: string;
  objectKey: string;
  filename: string;
  mimeType: string;
  parserJobId?: string;
  parserPollCount: number;
  parserSubmittedAt?: string;
  attempts: number;
  maxAttempts: number;
  workerId: string;
  leaseToken: string;
};

export type ChatStorageDeletionJob = {
  id: string;
  objectKey: string;
  attempts: number;
  maxAttempts: number;
  workerId: string;
  leaseToken: string;
};

export interface ChatStorageWorkerRepository {
  recoverAgentRuns(): Promise<void>;
  enqueueExpiredOrphans(limit?: number): Promise<number>;
  claimAttachmentParse(
    workerId: string
  ): Promise<ChatAttachmentParseJob | null>;
  renewAttachmentLease(job: ChatAttachmentParseJob): Promise<void>;
  markParserSubmitted(
    job: ChatAttachmentParseJob,
    parserJobId: string,
    retryAt: Date,
    provider: string
  ): Promise<void>;
  deferParserPoll(job: ChatAttachmentParseJob, retryAt: Date): Promise<void>;
  saveChunksAndComplete(
    job: ChatAttachmentParseJob,
    chunks: PrivateAttachmentChunk[],
    provider: string
  ): Promise<void>;
  markAttachmentFailed(
    job: ChatAttachmentParseJob,
    error: Error,
    retryAt: Date
  ): Promise<void>;
  claimDeletion(workerId: string): Promise<ChatStorageDeletionJob | null>;
  markDeletionSucceeded(job: ChatStorageDeletionJob): Promise<void>;
  markDeletionFailed(
    job: ChatStorageDeletionJob,
    error: Error,
    retryAt: Date
  ): Promise<void>;
}

export interface ChatStorageWorkerOptions {
  repository: ChatStorageWorkerRepository;
  parser: DocumentParser;
  objectStorage: ObjectStorage;
  workerId?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  maxParserPolls?: number;
  maxParserAgeMs?: number;
  leaseHeartbeatMs?: number;
}

export class StaleChatStorageLeaseError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} lease for ${id} is no longer current.`);
    this.name = "StaleChatStorageLeaseError";
  }
}

export class ChatStorageWorker {
  private readonly repository: ChatStorageWorkerRepository;
  private readonly parser: DocumentParser;
  private readonly objectStorage: ObjectStorage;
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly maxParserPolls: number;
  private readonly maxParserAgeMs: number;
  private readonly leaseHeartbeatMs: number;

  constructor(options: ChatStorageWorkerOptions) {
    this.repository = options.repository;
    this.parser = options.parser;
    this.objectStorage = options.objectStorage;
    this.workerId = options.workerId ?? `chat-storage-${randomUUID()}`;
    this.concurrency = boundedConcurrency(options.concurrency ?? 1);
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? POLL_INTERVAL_MS,
      "pollIntervalMs"
    );
    this.retryDelayMs = positiveInteger(
      options.retryDelayMs ?? RETRY_DELAY_MS,
      "retryDelayMs"
    );
    this.maxParserPolls = positiveInteger(
      options.maxParserPolls ?? DEFAULT_MAX_PARSER_POLLS,
      "maxParserPolls"
    );
    this.maxParserAgeMs = positiveInteger(
      options.maxParserAgeMs ?? DEFAULT_MAX_PARSER_AGE_MS,
      "maxParserAgeMs"
    );
    this.leaseHeartbeatMs = positiveInteger(
      options.leaseHeartbeatMs ?? DEFAULT_LEASE_HEARTBEAT_MS,
      "leaseHeartbeatMs"
    );
  }

  async runOnce(): Promise<"idle" | "deferred" | "completed" | "failed"> {
    const deletion = await this.repository.claimDeletion(this.workerId);
    if (deletion) {
      try {
        await this.objectStorage.deletePrivate(deletion.objectKey);
        await this.repository.markDeletionSucceeded(deletion);
        return "completed";
      } catch (cause) {
        const error = asError(cause);
        if (!isStaleLeaseError(error)) {
          try {
            await this.repository.markDeletionFailed(
              deletion,
              error,
              new Date(Date.now() + this.retryDelayMs)
            );
          } catch (markFailure) {
            if (!isStaleLeaseError(asError(markFailure))) throw markFailure;
          }
        }
        return "failed";
      }
    }

    const job = await this.repository.claimAttachmentParse(this.workerId);
    if (!job) return "idle";
    try {
      if (isLocalTextMime(job.mimeType)) {
        const bytes = await this.withAttachmentLease(job, () =>
          this.objectStorage.getPrivate(job.objectKey)
        );
        const chunks = chunksForLocalText(job.mimeType, bytes);
        await this.repository.saveChunksAndComplete(job, chunks, "local-text");
        return "completed";
      }
      if (!job.parserJobId) {
        const submitted = await this.withAttachmentLease(job, async () => {
          // Completion has already verified the immutable object's size,
          // digest, MIME signature, and ownership. The parser accepts this
          // server-minted URL only through its narrow OSS V4 trust boundary;
          // arbitrary URL ingestion still requires the configured allowlist.
          const url = await this.objectStorage.createPrivateDownloadUrl(
            job.objectKey,
            15 * 60
          );
          return this.parser.submit({
            url,
            urlTrust: "private-oss-v4",
            filename: job.filename,
            outputFormats: ["markdown", "visualLayoutInfo"],
            llmEnhancement: true
          });
        });
        await this.repository.markParserSubmitted(
          job,
          submitted.jobId,
          new Date(Date.now() + this.pollIntervalMs),
          this.parser.id
        );
        return "deferred";
      }

      assertParserPollingBudget(job, this.maxParserPolls, this.maxParserAgeMs);
      const status = await this.withAttachmentLease(job, () =>
        this.parser.getStatus(job.parserJobId!)
      );
      if (status.status === "pending" || status.status === "processing") {
        await this.repository.deferParserPoll(
          job,
          new Date(Date.now() + this.pollIntervalMs)
        );
        return "deferred";
      }
      if (status.status === "failed") {
        throw new ProviderError(status.errorMessage ?? "附件解析失败。", {
          provider: this.parser.id,
          retryable: false
        });
      }
      const parsed = await this.withAttachmentLease(job, () =>
        this.parser.getResult(job.parserJobId!)
      );
      const chunks = chunksForParsedDocument(parsed);
      await this.repository.saveChunksAndComplete(job, chunks, this.parser.id);
      return "completed";
    } catch (cause) {
      const error = asError(cause);
      if (!isStaleLeaseError(error)) {
        try {
          await this.repository.markAttachmentFailed(
            job,
            error,
            new Date(Date.now() + this.retryDelayMs)
          );
        } catch (markFailure) {
          if (!isStaleLeaseError(asError(markFailure))) throw markFailure;
        }
      }
      return "failed";
    }
  }

  private async withAttachmentLease<T>(
    job: ChatAttachmentParseJob,
    operation: () => Promise<T>
  ): Promise<T> {
    await this.repository.renewAttachmentLease(job);
    let renewInFlight: Promise<void> | undefined;
    let leaseError: unknown;
    const timer = setInterval(() => {
      if (renewInFlight || leaseError) return;
      renewInFlight = this.repository
        .renewAttachmentLease(job)
        .catch((error: unknown) => {
          leaseError = error;
        })
        .finally(() => {
          renewInFlight = undefined;
        });
    }, this.leaseHeartbeatMs);
    timer.unref?.();
    try {
      const result = await operation();
      if (renewInFlight) await renewInFlight;
      if (leaseError) throw leaseError;
      await this.repository.renewAttachmentLease(job);
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  async runBatch(): Promise<
    Array<"idle" | "deferred" | "completed" | "failed">
  > {
    await Promise.all([
      this.repository.recoverAgentRuns(),
      this.repository.enqueueExpiredOrphans()
    ]);
    return Promise.all(
      Array.from({ length: this.concurrency }, () => this.runOnce())
    );
  }

  async runUntilStopped(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const outcomes = await this.runBatch();
      if (outcomes.every((outcome) => outcome === "idle")) {
        await abortableDelay(1_000, signal);
      }
    }
  }
}

export interface ChatStorageSql {
  unsafe(
    query: string,
    parameters?: unknown[]
  ): Promise<Array<Record<string, unknown>>>;
  begin<T>(handler: (transaction: ChatStorageSql) => Promise<T>): Promise<T>;
}

export class PostgresChatStorageWorkerRepository implements ChatStorageWorkerRepository {
  constructor(
    private readonly sql: ChatStorageSql = sqlClient as unknown as ChatStorageSql
  ) {}

  async recoverAgentRuns(): Promise<void> {
    await recoverStaleAgentRuns();
  }

  async enqueueExpiredOrphans(limit = 100): Promise<number> {
    positiveInteger(limit, "limit");
    return this.sql.begin(async (transaction) => {
      const rows = await transaction.unsafe(
        `
          SELECT id, user_id, object_key, quota_state,
                 declared_size_bytes, size_bytes
          FROM chat_attachment
          WHERE message_id IS NULL
            AND deletion_status = 'active'
            AND orphan_expires_at <= NOW()
          ORDER BY orphan_expires_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        `,
        [limit]
      );
      for (const row of rows) {
        const id = requiredString(row.id, "expired attachment id");
        const userId = requiredString(row.user_id, "expired attachment user");
        const objectKey = requiredString(
          row.object_key,
          "expired attachment object key"
        );
        const quotaState = requiredString(
          row.quota_state,
          "expired attachment quota state"
        );
        const declaredSize = requiredInteger(
          row.declared_size_bytes,
          "expired attachment declared size"
        );
        const sizeBytes = optionalInteger(row.size_bytes) ?? 0;
        await transaction.unsafe(
          `
            INSERT INTO chat_storage_deletion_job (
              user_id, object_type, source_id, object_key
            ) VALUES ($1, 'attachment', $2, $3)
            ON CONFLICT (object_key) DO NOTHING
          `,
          [userId, id, objectKey]
        );
        await transaction.unsafe(
          `
            UPDATE chat_storage_account
            SET reserved_bytes = GREATEST(
                  reserved_bytes - CASE WHEN $2 = 'reserved' THEN $3 ELSE 0 END,
                  0
                ),
                used_bytes = GREATEST(
                  used_bytes - CASE WHEN $2 = 'committed' THEN $4 ELSE 0 END,
                  0
                ),
                updated_at = NOW()
            WHERE user_id = $1
          `,
          [userId, quotaState, declaredSize, sizeBytes]
        );
        await transaction.unsafe(
          "DELETE FROM chat_attachment WHERE id = $1 AND user_id = $2",
          [id, userId]
        );
      }
      return rows.length;
    });
  }

  async claimAttachmentParse(
    workerId: string
  ): Promise<ChatAttachmentParseJob | null> {
    const [row] = await this.sql.unsafe(CLAIM_ATTACHMENT_PARSE_SQL, [workerId]);
    return row ? parseAttachmentJob(row) : null;
  }

  async renewAttachmentLease(job: ChatAttachmentParseJob): Promise<void> {
    const rows = await this.sql.unsafe(
      `
        UPDATE chat_attachment
        SET parse_locked_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND parse_status = 'processing'
          AND parse_locked_by = $2 AND parse_lease_token = $3::uuid
        RETURNING id
      `,
      [job.id, job.workerId, job.leaseToken]
    );
    assertLease(job.id, rows, "attachment parse");
  }

  async markParserSubmitted(
    job: ChatAttachmentParseJob,
    parserJobId: string,
    retryAt: Date,
    provider: string
  ): Promise<void> {
    const rows = await this.sql.unsafe(
      `
        UPDATE chat_attachment
        SET parse_status = 'queued', parse_provider = $2,
            parse_job_id = $3, parse_run_at = $4,
            parse_poll_count = 0, parse_submitted_at = NOW(),
            parse_attempts = GREATEST(parse_attempts - 1, 0),
            parse_locked_at = NULL, parse_locked_by = NULL,
            parse_lease_token = NULL, updated_at = NOW()
        WHERE id = $1 AND parse_status = 'processing'
          AND parse_locked_by = $5 AND parse_lease_token = $6::uuid
        RETURNING id
      `,
      [
        job.id,
        provider,
        parserJobId,
        retryAt.toISOString(),
        job.workerId,
        job.leaseToken
      ]
    );
    assertLease(job.id, rows, "attachment parse");
  }

  async deferParserPoll(
    job: ChatAttachmentParseJob,
    retryAt: Date
  ): Promise<void> {
    const rows = await this.sql.unsafe(
      `
        UPDATE chat_attachment
        SET parse_status = 'queued', parse_run_at = $2,
            parse_poll_count = parse_poll_count + 1,
            parse_attempts = GREATEST(parse_attempts - 1, 0),
            parse_locked_at = NULL, parse_locked_by = NULL,
            parse_lease_token = NULL, updated_at = NOW()
        WHERE id = $1 AND parse_status = 'processing'
          AND parse_locked_by = $3 AND parse_lease_token = $4::uuid
        RETURNING id
      `,
      [job.id, retryAt.toISOString(), job.workerId, job.leaseToken]
    );
    assertLease(job.id, rows, "attachment parse");
  }

  async saveChunksAndComplete(
    job: ChatAttachmentParseJob,
    chunks: PrivateAttachmentChunk[],
    provider: string
  ): Promise<void> {
    if (chunks.length < 1 || chunks.length > MAX_CHUNKS) {
      throw new Error("Attachment parser returned an invalid chunk count.");
    }
    await this.sql.begin(async (transaction) => {
      await assertAttachmentLease(transaction, job);
      await transaction.unsafe(
        "DELETE FROM chat_attachment_chunk WHERE attachment_id = $1",
        [job.id]
      );
      for (let offset = 0; offset < chunks.length; offset += 100) {
        const batch = chunks.slice(offset, offset + 100);
        const parameters: unknown[] = [];
        const values = batch.map((chunk, index) => {
          const base = index * 6;
          parameters.push(
            job.id,
            chunk.ordinal,
            chunk.content,
            chunk.contentHash,
            JSON.stringify(chunk.locator),
            JSON.stringify(chunk.metadata)
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}::jsonb)`;
        });
        await transaction.unsafe(
          `
            INSERT INTO chat_attachment_chunk (
              attachment_id, ordinal, content, content_hash, locator, metadata
            ) VALUES ${values.join(", ")}
          `,
          parameters
        );
      }
      const rows = await transaction.unsafe(
        `
          UPDATE chat_attachment
          SET status = 'ready', parse_status = 'ready', parse_provider = $2,
              failure_code = NULL, failure_message = NULL, ready_at = NOW(),
              parse_locked_at = NULL, parse_locked_by = NULL,
              parse_lease_token = NULL, updated_at = NOW()
          WHERE id = $1 AND parse_status = 'processing'
            AND parse_locked_by = $3 AND parse_lease_token = $4::uuid
          RETURNING id
        `,
        [job.id, provider, job.workerId, job.leaseToken]
      );
      assertLease(job.id, rows, "attachment parse");
    });
  }

  async markAttachmentFailed(
    job: ChatAttachmentParseJob,
    error: Error,
    retryAt: Date
  ): Promise<void> {
    const terminal =
      job.attempts >= job.maxAttempts ||
      (error instanceof ProviderError && !error.retryable);
    const rows = await this.sql.unsafe(
      `
        UPDATE chat_attachment
        SET status = CASE WHEN $2 THEN 'failed' ELSE 'processing' END,
            parse_status = CASE WHEN $2 THEN 'failed' ELSE 'queued' END,
            parse_run_at = $3,
            failure_code = CASE WHEN $2 THEN 'ATTACHMENT_PARSE_FAILED' ELSE NULL END,
            failure_message = CASE WHEN $2 THEN $4 ELSE NULL END,
            parse_locked_at = NULL, parse_locked_by = NULL,
            parse_lease_token = NULL, updated_at = NOW()
        WHERE id = $1 AND parse_status = 'processing'
          AND parse_locked_by = $5 AND parse_lease_token = $6::uuid
        RETURNING id
      `,
      [
        job.id,
        terminal,
        retryAt.toISOString(),
        "附件解析失败，请重新上传或更换文件格式。",
        job.workerId,
        job.leaseToken
      ]
    );
    assertLease(job.id, rows, "attachment parse");
  }

  async claimDeletion(
    workerId: string
  ): Promise<ChatStorageDeletionJob | null> {
    const [row] = await this.sql.unsafe(CLAIM_DELETION_SQL, [workerId]);
    return row ? parseDeletionJob(row) : null;
  }

  async markDeletionSucceeded(job: ChatStorageDeletionJob): Promise<void> {
    const rows = await this.sql.unsafe(
      `
        UPDATE chat_storage_deletion_job
        SET status = 'succeeded', completed_at = NOW(), last_error = NULL,
            locked_at = NULL, locked_by = NULL, lease_token = NULL,
            updated_at = NOW()
        WHERE id = $1 AND status = 'running'
          AND locked_by = $2 AND lease_token = $3::uuid
        RETURNING id
      `,
      [job.id, job.workerId, job.leaseToken]
    );
    assertLease(job.id, rows, "storage deletion");
  }

  async markDeletionFailed(
    job: ChatStorageDeletionJob,
    error: Error,
    retryAt: Date
  ): Promise<void> {
    const terminal =
      job.attempts >= job.maxAttempts ||
      (error instanceof ProviderError && !error.retryable);
    const rows = await this.sql.unsafe(
      `
        UPDATE chat_storage_deletion_job
        SET status = CASE WHEN $2 THEN 'failed' ELSE 'queued' END,
            run_at = $3, last_error = $4,
            completed_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
            locked_at = NULL, locked_by = NULL, lease_token = NULL,
            updated_at = NOW()
        WHERE id = $1 AND status = 'running'
          AND locked_by = $5 AND lease_token = $6::uuid
        RETURNING id
      `,
      [
        job.id,
        terminal,
        retryAt.toISOString(),
        safeErrorMessage(error),
        job.workerId,
        job.leaseToken
      ]
    );
    assertLease(job.id, rows, "storage deletion");
  }
}

const CLAIM_ATTACHMENT_PARSE_SQL = `
WITH candidate AS (
  SELECT id
  FROM chat_attachment
  WHERE kind = 'document'
    AND quota_state = 'committed'
    AND deletion_status = 'active'
    AND status = 'processing'
    AND (
      (parse_status = 'queued' AND parse_run_at <= NOW())
      OR (
        parse_status = 'processing'
        AND parse_locked_at < NOW() - INTERVAL '15 minutes'
      )
    )
  ORDER BY parse_run_at, created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE chat_attachment attachment
SET parse_status = 'processing', parse_attempts = parse_attempts + 1,
    parse_locked_at = NOW(), parse_locked_by = $1,
    parse_lease_token = gen_random_uuid(), updated_at = NOW()
FROM candidate
WHERE attachment.id = candidate.id
RETURNING attachment.id, attachment.object_key,
  attachment.original_filename, attachment.mime_type,
  attachment.parse_job_id, attachment.parse_attempts,
  attachment.parse_max_attempts, attachment.parse_poll_count,
  attachment.parse_submitted_at, attachment.parse_locked_by,
  attachment.parse_lease_token
`.trim();

const CLAIM_DELETION_SQL = `
WITH candidate AS (
  SELECT id
  FROM chat_storage_deletion_job
  WHERE (status = 'queued' AND run_at <= NOW())
    OR (status = 'running' AND locked_at < NOW() - INTERVAL '15 minutes')
  ORDER BY run_at, created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE chat_storage_deletion_job job
SET status = 'running', attempts = attempts + 1, locked_at = NOW(),
    locked_by = $1, lease_token = gen_random_uuid(), updated_at = NOW()
FROM candidate
WHERE job.id = candidate.id
RETURNING job.id, job.object_key, job.attempts, job.max_attempts,
  job.locked_by, job.lease_token
`.trim();

export function chunksForParsedDocument(
  parsed: ParsedDocument
): PrivateAttachmentChunk[] {
  const chunks: PrivateAttachmentChunk[] = [];
  for (const [pageIndex, page] of parsed.pages.entries()) {
    const markdown = page.markdown?.trim();
    if (!markdown) continue;
    const pageChunks = chunkText(markdown);
    for (const chunk of pageChunks) {
      chunks.push({
        ordinal: chunks.length,
        content: chunk.content,
        contentHash: sha256(chunk.content),
        locator: {
          type: "page",
          page: page.pageNumber ?? pageIndex + 1,
          characterStart: chunk.start,
          characterEnd: chunk.end
        },
        metadata: { parserJobId: parsed.jobId }
      });
      assertChunkLimit(chunks);
    }
  }
  if (chunks.length === 0) {
    throw new Error("Attachment parser returned no extractable text.");
  }
  return chunks;
}

export function chunksForLocalText(
  mimeType: string,
  bytes: Uint8Array
): PrivateAttachmentChunk[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.trim() || text.includes("\0")) {
    throw new Error("Attachment text is empty or invalid UTF-8.");
  }
  if (mimeType === "text/csv") {
    return chunksForCsv(text);
  }
  const chunks = chunkText(text);
  return chunks.map((chunk, ordinal) => ({
    ordinal,
    content: chunk.content,
    contentHash: sha256(chunk.content),
    locator: {
      type: mimeType === "text/markdown" ? "markdown" : "text",
      lineStart: lineNumberAt(text, chunk.start),
      lineEnd: lineNumberAt(text, chunk.end)
    },
    metadata: {}
  }));
}

function chunksForCsv(text: string): PrivateAttachmentChunk[] {
  const lines = text.split(/\r?\n/u);
  const chunks: PrivateAttachmentChunk[] = [];
  let rowStart = 1;
  let buffer: string[] = [];
  const flush = () => {
    const content = buffer.join("\n").trim();
    if (!content) return;
    chunks.push({
      ordinal: chunks.length,
      content,
      contentHash: sha256(content),
      locator: {
        type: "csv_rows",
        rowStart,
        rowEnd: rowStart + buffer.length - 1
      },
      metadata: {}
    });
    assertChunkLimit(chunks);
    rowStart += buffer.length;
    buffer = [];
  };
  for (const line of lines) {
    const candidate = [...buffer, line].join("\n");
    if (buffer.length > 0 && candidate.length > MAX_CHUNK_CHARACTERS) flush();
    if (line.length > MAX_CHUNK_CHARACTERS) {
      if (buffer.length > 0) flush();
      for (const part of chunkText(line)) {
        const content = part.content;
        chunks.push({
          ordinal: chunks.length,
          content,
          contentHash: sha256(content),
          locator: { type: "csv_row", row: rowStart },
          metadata: {}
        });
        assertChunkLimit(chunks);
      }
      rowStart += 1;
    } else {
      buffer.push(line);
    }
  }
  if (buffer.length > 0) flush();
  if (chunks.length === 0) throw new Error("CSV attachment contains no rows.");
  return chunks;
}

function chunkText(text: string): Array<{
  content: string;
  start: number;
  end: number;
}> {
  const chunks: Array<{ content: string; start: number; end: number }> = [];
  const step = MAX_CHUNK_CHARACTERS - CHUNK_OVERLAP_CHARACTERS;
  for (let start = 0; start < text.length; start += step) {
    const raw = text.slice(start, start + MAX_CHUNK_CHARACTERS);
    const content = raw.trim();
    if (content) {
      const leading = raw.length - raw.trimStart().length;
      chunks.push({
        content,
        start: start + leading,
        end: start + leading + content.length
      });
      assertChunkLimit(chunks);
    }
    if (start + MAX_CHUNK_CHARACTERS >= text.length) break;
  }
  return chunks;
}

function lineNumberAt(text: string, offset: number): number {
  return text.slice(0, Math.max(0, offset)).split("\n").length;
}

function parseAttachmentJob(
  row: Record<string, unknown>
): ChatAttachmentParseJob {
  return {
    id: requiredString(row.id, "attachment id"),
    objectKey: requiredString(row.object_key, "attachment object key"),
    filename: requiredString(row.original_filename, "attachment filename"),
    mimeType: requiredString(row.mime_type, "attachment MIME type"),
    ...(typeof row.parse_job_id === "string"
      ? { parserJobId: row.parse_job_id }
      : {}),
    parserPollCount: requiredInteger(
      row.parse_poll_count,
      "attachment parser poll count"
    ),
    ...(timestampString(row.parse_submitted_at)
      ? { parserSubmittedAt: timestampString(row.parse_submitted_at)! }
      : {}),
    attempts: requiredInteger(row.parse_attempts, "attachment attempts"),
    maxAttempts: requiredInteger(
      row.parse_max_attempts,
      "attachment max attempts"
    ),
    workerId: requiredString(row.parse_locked_by, "attachment worker"),
    leaseToken: requiredString(row.parse_lease_token, "attachment lease")
  };
}

function parseDeletionJob(
  row: Record<string, unknown>
): ChatStorageDeletionJob {
  return {
    id: requiredString(row.id, "deletion id"),
    objectKey: requiredString(row.object_key, "deletion object key"),
    attempts: requiredInteger(row.attempts, "deletion attempts"),
    maxAttempts: requiredInteger(row.max_attempts, "deletion max attempts"),
    workerId: requiredString(row.locked_by, "deletion worker"),
    leaseToken: requiredString(row.lease_token, "deletion lease")
  };
}

async function assertAttachmentLease(
  transaction: ChatStorageSql,
  job: ChatAttachmentParseJob
): Promise<void> {
  const rows = await transaction.unsafe(
    `
      SELECT id
      FROM chat_attachment
      WHERE id = $1 AND parse_status = 'processing'
        AND parse_locked_by = $2 AND parse_lease_token = $3::uuid
      FOR UPDATE
    `,
    [job.id, job.workerId, job.leaseToken]
  );
  assertLease(job.id, rows, "attachment parse");
}

function assertLease(
  id: string,
  rows: Array<Record<string, unknown>>,
  kind: string
): void {
  if (rows.length !== 1) {
    throw new StaleChatStorageLeaseError(kind, id);
  }
}

function isLocalTextMime(mimeType: string): boolean {
  return ["text/plain", "text/markdown", "text/csv"].includes(mimeType);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Malformed ${label}.`);
  }
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  const parsed = optionalInteger(value);
  if (parsed === null) throw new Error(`Malformed ${label}.`);
  return parsed;
}

function optionalInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function timestampString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function safeErrorMessage(error: Error): string {
  return error.message.replace(/[\r\n]+/gu, " ").slice(0, 1_000);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Unknown worker error");
}

function isStaleLeaseError(error: Error): boolean {
  return error instanceof StaleChatStorageLeaseError;
}

function assertParserPollingBudget(
  job: ChatAttachmentParseJob,
  maxPolls: number,
  maxAgeMs: number
): void {
  const submittedAt = job.parserSubmittedAt
    ? new Date(job.parserSubmittedAt).getTime()
    : Number.NaN;
  if (
    job.parserPollCount >= maxPolls ||
    !Number.isFinite(submittedAt) ||
    Date.now() - submittedAt > maxAgeMs
  ) {
    throw new ProviderError("附件解析超出轮询时限。", {
      provider: "chat-storage-worker",
      retryable: false
    });
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function assertChunkLimit(chunks: { length: number }): void {
  if (chunks.length > MAX_CHUNKS) {
    throw new Error(`Attachment parsing exceeds ${MAX_CHUNKS} private chunks.`);
  }
}

function boundedConcurrency(value: number): number {
  return Math.min(
    positiveInteger(value, "concurrency"),
    MAX_WORKER_CONCURRENCY
  );
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
