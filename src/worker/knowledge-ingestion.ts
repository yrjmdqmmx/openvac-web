import { createHash, randomUUID } from "node:crypto";

import {
  ConfigurationError,
  ProviderError,
  ProviderResponseError,
  type DocumentParser,
  type EmbeddingProvider,
  type ObjectStorage,
  type ParsedDocument
} from "@/server/providers";

import type {
  EmbeddedKnowledgeChunk,
  KnowledgeIngestionJob,
  KnowledgeIngestionRepository,
  ParsedPageWithText,
  WorkerOutcome
} from "./types";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_CHUNK_CHARACTERS = 2_400;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_LEASE_HEARTBEAT_MS = 60_000;
const DEFAULT_MAX_OCR_POLLS = 240;
const DEFAULT_MAX_OCR_AGE_MS = 2 * 60 * 60 * 1_000;
const KNOWLEDGE_OBJECT_PREFIXES = [
  "private/knowledge-originals/",
  "knowledge-originals/"
] as const;
const MAX_WORKER_CONCURRENCY = 4;

export interface KnowledgeIngestionWorkerOptions {
  repository: KnowledgeIngestionRepository;
  parser: DocumentParser;
  embeddings: EmbeddingProvider;
  objectStorage?: ObjectStorage;
  workerId?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  leaseHeartbeatMs?: number;
  maxOcrPolls?: number;
  maxOcrAgeMs?: number;
  allowedDocumentHosts?: string[];
}

export class KnowledgeIngestionWorker {
  private readonly repository: KnowledgeIngestionRepository;
  private readonly parser: DocumentParser;
  private readonly embeddings: EmbeddingProvider;
  private readonly objectStorage?: ObjectStorage;
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly leaseHeartbeatMs: number;
  private readonly maxOcrPolls: number;
  private readonly maxOcrAgeMs: number;
  private readonly allowedDocumentHosts: ReadonlySet<string>;

  constructor(options: KnowledgeIngestionWorkerOptions) {
    this.repository = options.repository;
    this.parser = options.parser;
    this.embeddings = options.embeddings;
    this.objectStorage = options.objectStorage;
    this.workerId = options.workerId ?? `openvac-worker-${randomUUID()}`;
    this.concurrency = boundedConcurrency(options.concurrency ?? 1);
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs"
    );
    this.retryDelayMs = positiveInteger(
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      "retryDelayMs"
    );
    this.leaseHeartbeatMs = positiveInteger(
      options.leaseHeartbeatMs ?? DEFAULT_LEASE_HEARTBEAT_MS,
      "leaseHeartbeatMs"
    );
    this.maxOcrPolls = positiveInteger(
      options.maxOcrPolls ?? DEFAULT_MAX_OCR_POLLS,
      "maxOcrPolls"
    );
    this.maxOcrAgeMs = positiveInteger(
      options.maxOcrAgeMs ?? DEFAULT_MAX_OCR_AGE_MS,
      "maxOcrAgeMs"
    );
    this.allowedDocumentHosts = new Set(
      (options.allowedDocumentHosts ?? [])
        .map((host) => normalizeHostname(host))
        .filter(Boolean)
    );
  }

  async runOnce(): Promise<WorkerOutcome> {
    const job = await this.repository.claimNext(this.workerId);
    if (!job) {
      return "idle";
    }

    try {
      switch (job.payload.stage) {
        case "ocr_pending":
          return await this.submitOcr(job);
        case "ocr_processing":
          return await this.pollOcr(job);
        case "embedding_pending":
        case "embedding_processing":
          return await this.embedApprovedContent(job);
        case "review_required":
          await this.repository.markReviewRequired(
            job,
            "知识内容仍在等待人工复核。"
          );
          return "review_required";
        case "completed":
          await this.repository.markReviewRequired(
            job,
            "任务已完成，不应再次进入队列。"
          );
          return "review_required";
      }
    } catch (cause) {
      const error =
        cause instanceof Error
          ? cause
          : new Error("Unknown worker failure", { cause });
      if (isStaleLeaseError(error)) {
        return "failed";
      }
      try {
        await this.repository.markFailed(
          job,
          error,
          new Date(Date.now() + this.retryDelayMs)
        );
      } catch (markFailure) {
        if (!isStaleLeaseError(asError(markFailure))) {
          throw markFailure;
        }
      }
      return "failed";
    }
  }

  async runBatch(): Promise<WorkerOutcome[]> {
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

  private async submitOcr(job: KnowledgeIngestionJob): Promise<WorkerOutcome> {
    const payload = job.payload;
    if (!payload.objectKey) {
      throw new ConfigurationError(
        "knowledge-worker",
        "OCR jobs must reference a private OSS object key."
      );
    }
    validateKnowledgeObjectKey(payload.objectKey);
    if (!this.objectStorage) {
      throw new ConfigurationError(
        "knowledge-worker",
        "Object storage is required for OCR jobs."
      );
    }

    const sourceUrl = await this.withLeaseHeartbeat(job, () =>
      this.objectStorage!.createPrivateDownloadUrl(payload.objectKey!, 900)
    );
    validatePrivateDocumentUrl(sourceUrl, this.allowedDocumentHosts);
    const submitted = await this.withLeaseHeartbeat(job, () =>
      this.parser.submit({
        url: sourceUrl,
        filename: payload.filename,
        outputFormats: ["markdown", "visualLayoutInfo"],
        llmEnhancement: true
      })
    );
    await this.repository.markOcrSubmitted(
      job,
      submitted.jobId,
      new Date(Date.now() + this.pollIntervalMs)
    );
    return "deferred";
  }

  private async pollOcr(job: KnowledgeIngestionJob): Promise<WorkerOutcome> {
    const parserJobId = job.payload.parserJobId;
    if (!parserJobId) {
      throw new ConfigurationError(
        "knowledge-worker",
        "OCR processing job is missing parserJobId."
      );
    }
    assertOcrPollingBudget(job, this.maxOcrPolls, this.maxOcrAgeMs);
    const status = await this.withLeaseHeartbeat(job, () =>
      this.parser.getStatus(parserJobId)
    );
    if (status.status === "pending" || status.status === "processing") {
      await this.repository.deferOcrPoll(
        job,
        new Date(Date.now() + this.pollIntervalMs)
      );
      return "deferred";
    }
    if (status.status === "failed") {
      throw new ProviderError(
        status.errorMessage ?? "DocMind OCR job failed.",
        { provider: this.parser.id, retryable: false }
      );
    }

    const parsed = await this.withLeaseHeartbeat(job, () =>
      this.parser.getResult(parserJobId)
    );
    const rendered = renderParsedDocument(parsed);
    if (!rendered.trim()) {
      throw new ProviderError(
        "DocMind OCR completed without reviewable text.",
        { provider: this.parser.id, retryable: true }
      );
    }

    // This is the hard gate: OCR output is persisted in review and the task
    // ends in review_required. Embeddings are never generated in this branch.
    await this.repository.saveParsedForReview(job, parsed, rendered);
    return "review_required";
  }

  private async embedApprovedContent(
    job: KnowledgeIngestionJob
  ): Promise<WorkerOutcome> {
    const review = job.payload.review;
    if (
      review?.status !== "approved" ||
      !review.reviewedBy.trim() ||
      !isValidDate(review.reviewedAt) ||
      !/^[a-f0-9]{64}$/u.test(review.contentHash)
    ) {
      await this.repository.markReviewRequired(
        job,
        "Embedding requires an identified human reviewer, review time, and approved SHA-256 content hash."
      );
      return "review_required";
    }
    const approved = await this.repository.loadApprovedContent(job);
    if (!approved) {
      await this.repository.markReviewRequired(
        job,
        "The reviewed knowledge version no longer exists."
      );
      return "review_required";
    }
    const actualHash = sha256(approved.content);
    if (actualHash !== review.contentHash) {
      await this.repository.markReviewRequired(
        job,
        "Knowledge content changed after approval; a new human review is required."
      );
      return "review_required";
    }

    const baseChunks = chunkReviewedMarkdown(approved.content);
    if (baseChunks.length === 0) {
      await this.repository.markReviewRequired(
        job,
        "Approved content contains no embeddable text."
      );
      return "review_required";
    }
    const embedded = await this.withLeaseHeartbeat(job, () =>
      this.embeddings.embed(baseChunks.map((chunk) => chunk.content))
    );
    if (embedded.vectors.length !== baseChunks.length) {
      throw new ProviderError(
        "Embedding result count does not match reviewed chunks.",
        { provider: this.embeddings.id, retryable: true }
      );
    }
    if (
      embedded.dimensions !== 1024 ||
      embedded.vectors.some(
        (vector) =>
          vector.length !== 1024 ||
          vector.some((value) => !Number.isFinite(value))
      )
    ) {
      throw new ProviderError(
        "Knowledge embeddings must contain exactly 1024 finite dimensions.",
        { provider: this.embeddings.id, retryable: true }
      );
    }
    const chunks: EmbeddedKnowledgeChunk[] = baseChunks.map((chunk, index) => ({
      ...chunk,
      embedding: embedded.vectors[index] ?? [],
      embeddingModel: embedded.model,
      metadata: {
        review: {
          reviewedBy: review.reviewedBy,
          reviewedAt: review.reviewedAt,
          contentHash: review.contentHash
        }
      }
    }));
    await this.repository.saveEmbeddingsAndComplete(job, chunks);
    return "completed";
  }

  private async withLeaseHeartbeat<T>(
    job: KnowledgeIngestionJob,
    operation: () => Promise<T>
  ): Promise<T> {
    await this.repository.renewLease(job);
    let renewInFlight: Promise<void> | undefined;
    let leaseError: unknown;
    const timer = setInterval(() => {
      if (renewInFlight || leaseError) {
        return;
      }
      renewInFlight = this.repository
        .renewLease(job)
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
      if (renewInFlight) {
        await renewInFlight;
      }
      if (leaseError) {
        throw leaseError;
      }
      await this.repository.renewLease(job);
      return result;
    } finally {
      clearInterval(timer);
    }
  }
}

export interface ChunkedKnowledgeText {
  chunkIndex: number;
  content: string;
  pageStart?: number;
  pageEnd?: number;
  sectionPath: string[];
}

export function renderParsedDocument(parsed: ParsedDocument): string {
  return parsed.pages
    .filter(
      (page): page is ParsedPageWithText =>
        typeof page.markdown === "string" && page.markdown.trim().length > 0
    )
    .map(
      (page, index) =>
        `<!-- openvac-page:${page.pageNumber ?? index + 1} -->\n${page.markdown.trim()}`
    )
    .join("\n\n");
}

export function chunkReviewedMarkdown(
  content: string,
  maxCharacters = DEFAULT_CHUNK_CHARACTERS,
  overlapCharacters = DEFAULT_CHUNK_OVERLAP
): ChunkedKnowledgeText[] {
  positiveInteger(maxCharacters, "maxCharacters");
  if (
    !Number.isInteger(overlapCharacters) ||
    overlapCharacters < 0 ||
    overlapCharacters >= maxCharacters
  ) {
    throw new Error(
      "overlapCharacters must be an integer from 0 to maxCharacters - 1."
    );
  }

  const pagePattern = /<!--\s*openvac-page:(\d+)\s*-->\s*/gu;
  const markers = [...content.matchAll(pagePattern)];
  const pages =
    markers.length > 0
      ? markers.map((marker, index) => ({
          page: Number(marker[1]),
          text: content
            .slice(
              (marker.index ?? 0) + marker[0].length,
              markers[index + 1]?.index ?? content.length
            )
            .trim()
        }))
      : [{ page: undefined, text: content.trim() }];
  const chunks: ChunkedKnowledgeText[] = [];

  for (const page of pages) {
    if (!page.text) {
      continue;
    }
    const paragraphs = page.text
      .split(/\n{2,}/u)
      .map((value) => value.trim())
      .filter(Boolean);
    let buffer = "";
    const flush = () => {
      const normalized = buffer.trim();
      if (!normalized) {
        return;
      }
      chunks.push({
        chunkIndex: chunks.length,
        content: normalized,
        pageStart: page.page,
        pageEnd: page.page,
        sectionPath: inferSectionPath(normalized)
      });
      buffer =
        overlapCharacters > 0 ? normalized.slice(-overlapCharacters) : "";
    };

    for (const paragraph of paragraphs) {
      if (paragraph.length > maxCharacters) {
        if (buffer.trim()) {
          flush();
          buffer = "";
        }
        const step = maxCharacters - overlapCharacters;
        for (let offset = 0; offset < paragraph.length; offset += step) {
          const piece = paragraph.slice(offset, offset + maxCharacters).trim();
          if (piece) {
            chunks.push({
              chunkIndex: chunks.length,
              content: piece,
              pageStart: page.page,
              pageEnd: page.page,
              sectionPath: inferSectionPath(piece)
            });
          }
          if (offset + maxCharacters >= paragraph.length) {
            break;
          }
        }
        continue;
      }
      const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      if (candidate.length > maxCharacters) {
        flush();
        buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
        if (buffer.length > maxCharacters) {
          buffer = paragraph;
        }
      } else {
        buffer = candidate;
      }
    }
    if (buffer.trim()) {
      flush();
    }
  }
  return chunks.map((chunk, index) => ({
    ...chunk,
    chunkIndex: index
  }));
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function inferSectionPath(content: string): string[] {
  const heading = content
    .split("\n")
    .find((line) => /^#{1,6}\s+\S/u.test(line));
  return heading ? [heading.replace(/^#{1,6}\s+/u, "").trim()] : [];
}

function boundedConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Worker concurrency must be a positive integer.");
  }
  return Math.min(value, MAX_WORKER_CONCURRENCY);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function isValidDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function validateKnowledgeObjectKey(objectKey: string): void {
  if (
    !KNOWLEDGE_OBJECT_PREFIXES.some((prefix) =>
      objectKey.startsWith(prefix)
    ) ||
    objectKey.startsWith("/") ||
    objectKey.includes("\0") ||
    objectKey.split("/").includes("..")
  ) {
    throw new ProviderResponseError(
      "knowledge-worker",
      `OCR object keys must stay under ${KNOWLEDGE_OBJECT_PREFIXES[0]}.`
    );
  }
}

export function validatePrivateDocumentUrl(
  value: string,
  allowedHosts: ReadonlySet<string>
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new ProviderResponseError(
      "knowledge-worker",
      "OSS returned an invalid signed document URL.",
      { cause }
    );
  }
  const hostname = normalizeHostname(url.hostname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hostname ||
    !allowedHosts.has(hostname)
  ) {
    throw new ProviderResponseError(
      "knowledge-worker",
      "The signed OCR document URL is outside the configured HTTPS host allowlist."
    );
  }
}

function normalizeHostname(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/u, "");
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`
    ).hostname
      .toLowerCase()
      .replace(/\.$/u, "");
  } catch {
    return "";
  }
}

function assertOcrPollingBudget(
  job: KnowledgeIngestionJob,
  maxPolls: number,
  maxAgeMs: number
): void {
  const submittedAt = job.payload.parserSubmittedAt;
  const submittedAtMs = submittedAt ? Date.parse(submittedAt) : Number.NaN;
  if (!Number.isFinite(submittedAtMs)) {
    throw new ProviderResponseError(
      "knowledge-worker",
      "OCR polling metadata is missing its submission time."
    );
  }
  if (
    (job.payload.parserPollCount ?? 0) >= maxPolls ||
    Date.now() - submittedAtMs > maxAgeMs
  ) {
    throw new ProviderResponseError(
      "knowledge-worker",
      "OCR polling exceeded its bounded attempt or wall-clock budget."
    );
  }
}

function isStaleLeaseError(error: Error): boolean {
  return error.name === "StaleWorkerLeaseError";
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("Unknown worker failure", { cause: value });
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
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
