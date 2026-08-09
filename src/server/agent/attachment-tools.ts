import { createHash } from "node:crypto";

import { sanitizeEvidenceExcerpt } from "@/server/chat/evidence";
import { ProviderError, ProviderTimeoutError } from "@/server/providers";
import type {
  DocumentParser,
  VisionImage,
  VisionProvider,
  VisionRequest,
  VisionResult
} from "@/server/providers";
import type { AttachmentKind, AttachmentStatus } from "@/types/chat-v3";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_POLLS = 90;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_CHUNK_CHARACTERS = 2_400;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_MAX_CHUNKS = 256;
const MAX_SEARCH_CANDIDATE_CHUNKS = 64;
const MAX_QUERY_CHARACTERS = 2_000;
const MAX_IMAGE_PROMPT_CHARACTERS = 2_000;
const MAX_VISION_OUTPUT_CHARACTERS = 6_000;
const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
  "text/markdown"
]);

export type AttachmentAccessScope = {
  userId: string;
  conversationId: string;
  messageId: string;
  attachmentId: string;
};

export type StoredAttachment = AttachmentAccessScope & {
  kind: AttachmentKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: AttachmentStatus;
  bytes?: Uint8Array;
};

export type AttachmentTextChunk = {
  chunkId: string;
  attachmentId: string;
  text: string;
  pageNumber?: number;
};

export interface AttachmentStorage {
  getAuthorizedAttachment(
    scope: AttachmentAccessScope
  ): Promise<StoredAttachment | null>;
  getParsedChunks(
    scope: AttachmentAccessScope
  ): Promise<AttachmentTextChunk[] | null>;
  searchParsedChunks?(
    scope: AttachmentAccessScope,
    query: string,
    limit: number
  ): Promise<AttachmentTextChunk[] | null>;
  getParsedChunk?(
    scope: AttachmentAccessScope,
    chunkId: string
  ): Promise<AttachmentTextChunk | null>;
  putParsedChunks(
    scope: AttachmentAccessScope,
    chunks: readonly AttachmentTextChunk[]
  ): Promise<void>;
}

export class UnconfiguredAttachmentStorage implements AttachmentStorage {
  async getAuthorizedAttachment(): Promise<never> {
    throw new AttachmentToolError(
      "ATTACHMENT_STORAGE_UNCONFIGURED",
      "Attachment storage is not configured."
    );
  }

  async getParsedChunks(): Promise<never> {
    throw new AttachmentToolError(
      "ATTACHMENT_STORAGE_UNCONFIGURED",
      "Attachment storage is not configured."
    );
  }

  async putParsedChunks(): Promise<never> {
    throw new AttachmentToolError(
      "ATTACHMENT_STORAGE_UNCONFIGURED",
      "Attachment storage is not configured."
    );
  }
}

export type AttachmentToolScope = AttachmentAccessScope & {
  allowedAttachmentIds: readonly string[];
};

export type SearchAttachmentInput = AttachmentToolScope & {
  query: string;
  signal?: AbortSignal;
};

export type SearchAttachmentOutput = {
  attachmentId: string;
  matches: Array<{
    chunkId: string;
    excerpt: string;
    pageNumber?: number;
  }>;
};

export type OpenAttachmentExcerptInput = AttachmentToolScope & {
  chunkId: string;
  signal?: AbortSignal;
};

export type OpenAttachmentExcerptOutput = {
  attachmentId: string;
  chunkId: string;
  excerpt: string;
  pageNumber?: number;
};

export type AnalyzeImageInput = AttachmentToolScope & {
  prompt: string;
  signal?: AbortSignal;
};

export type AnalyzeImageOutput = {
  attachmentId: string;
  analysis: string;
};

export type AttachmentToolErrorCode =
  | "ATTACHMENT_NOT_ALLOWED"
  | "ATTACHMENT_NOT_FOUND"
  | "ATTACHMENT_NOT_READY"
  | "ATTACHMENT_SCOPE_MISMATCH"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_KIND_MISMATCH"
  | "ATTACHMENT_STORAGE_UNCONFIGURED"
  | "DOCUMENT_PARSER_UNCONFIGURED"
  | "DOCUMENT_PARSE_FAILED"
  | "DOCUMENT_PARSE_LIMIT"
  | "INVALID_ATTACHMENT_INPUT"
  | "VISION_PROVIDER_UNCONFIGURED"
  | "VISION_PROVIDER_AUTH_FAILED"
  | "VISION_PROVIDER_QUOTA_EXHAUSTED"
  | "VISION_PROVIDER_RATE_LIMITED"
  | "VISION_PROVIDER_REQUEST_INVALID"
  | "VISION_PROVIDER_TIMEOUT"
  | "VISION_PROVIDER_UNAVAILABLE"
  | "VISION_PROVIDER_FAILED"
  | "VISION_OUTPUT_INVALID";

export class AttachmentToolError extends Error {
  constructor(
    readonly code: AttachmentToolErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AttachmentToolError";
  }
}

export interface AttachmentToolServiceOptions {
  storage: AttachmentStorage;
  parser?: DocumentParser;
  vision?: VisionProvider;
  maxPolls?: number;
  pollIntervalMs?: number;
  chunkCharacters?: number;
  chunkOverlap?: number;
  maxChunks?: number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class AttachmentToolService {
  private readonly storage: AttachmentStorage;
  private readonly parser?: DocumentParser;
  private readonly vision?: VisionProvider;
  private readonly maxPolls: number;
  private readonly pollIntervalMs: number;
  private readonly chunkCharacters: number;
  private readonly chunkOverlap: number;
  private readonly maxChunks: number;
  private readonly wait: (
    milliseconds: number,
    signal?: AbortSignal
  ) => Promise<void>;

  constructor(options: AttachmentToolServiceOptions) {
    this.storage = options.storage;
    this.parser = options.parser;
    this.vision = options.vision;
    this.maxPolls = positiveInteger(options.maxPolls ?? DEFAULT_MAX_POLLS);
    this.pollIntervalMs = nonNegativeInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    );
    this.chunkCharacters = positiveInteger(
      options.chunkCharacters ?? DEFAULT_CHUNK_CHARACTERS
    );
    this.chunkOverlap = nonNegativeInteger(
      options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP
    );
    this.maxChunks = positiveInteger(options.maxChunks ?? DEFAULT_MAX_CHUNKS);
    if (this.chunkOverlap >= this.chunkCharacters) {
      throw new TypeError("chunkOverlap must be smaller than chunkCharacters.");
    }
    this.wait = options.wait ?? waitFor;
  }

  async search(input: SearchAttachmentInput): Promise<SearchAttachmentOutput> {
    const query = boundedText(input.query, MAX_QUERY_CHARACTERS, "query");
    const attachment = await this.loadAuthorized(input, "document");
    const chunks = await this.loadSearchChunks(attachment, query, input.signal);
    const terms = searchTerms(query);
    const matches = chunks
      .map((chunk) => ({ chunk, score: scoreChunk(chunk.text, query, terms) }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.chunk.chunkId.localeCompare(right.chunk.chunkId)
      )
      .slice(0, 8)
      .map(({ chunk }) => ({
        chunkId: chunk.chunkId,
        excerpt: sanitizeEvidenceExcerpt(chunk.text, 2_600),
        ...(chunk.pageNumber === undefined
          ? {}
          : { pageNumber: chunk.pageNumber })
      }));
    return { attachmentId: attachment.attachmentId, matches };
  }

  async open(
    input: OpenAttachmentExcerptInput
  ): Promise<OpenAttachmentExcerptOutput> {
    const chunkId = boundedText(input.chunkId, 240, "chunkId");
    const attachment = await this.loadAuthorized(input, "document");
    const chunk = await this.loadOpenedChunk(attachment, chunkId, input.signal);
    if (!chunk) {
      throw new AttachmentToolError(
        "ATTACHMENT_NOT_FOUND",
        "The requested attachment excerpt is unavailable."
      );
    }
    return {
      attachmentId: attachment.attachmentId,
      chunkId: chunk.chunkId,
      excerpt: sanitizeEvidenceExcerpt(chunk.text, 4_000),
      ...(chunk.pageNumber === undefined
        ? {}
        : { pageNumber: chunk.pageNumber })
    };
  }

  async analyze(input: AnalyzeImageInput): Promise<AnalyzeImageOutput> {
    const prompt = boundedText(
      input.prompt,
      MAX_IMAGE_PROMPT_CHARACTERS,
      "prompt"
    );
    const attachment = await this.loadAuthorized(input, "image");
    if (!this.vision) {
      throw new AttachmentToolError(
        "VISION_PROVIDER_UNCONFIGURED",
        "Vision analysis is not configured."
      );
    }
    if (
      attachment.mimeType !== "image/jpeg" &&
      attachment.mimeType !== "image/png"
    ) {
      throw new AttachmentToolError(
        "ATTACHMENT_KIND_MISMATCH",
        "Only JPEG and PNG images may be analyzed."
      );
    }
    if (!(attachment.bytes instanceof Uint8Array)) {
      throw new AttachmentToolError(
        "ATTACHMENT_NOT_READY",
        "Image bytes are unavailable."
      );
    }
    const result = await analyzeVisionWithOneRetry(this.vision, {
      images: [
        {
          mimeType: attachment.mimeType,
          bytes: new Uint8Array(attachment.bytes)
        } satisfies VisionImage
      ],
      prompt,
      maxOutputTokens: 2_048,
      signal: input.signal
    });
    if (typeof result.text !== "string" || !result.text.trim()) {
      throw new AttachmentToolError(
        "VISION_OUTPUT_INVALID",
        "The vision provider returned no readable analysis."
      );
    }
    return {
      attachmentId: attachment.attachmentId,
      analysis: sanitizeEvidenceExcerpt(
        result.text,
        MAX_VISION_OUTPUT_CHARACTERS
      )
    };
  }

  private async loadAuthorized(
    input: AttachmentToolScope,
    expectedKind: AttachmentKind
  ): Promise<StoredAttachment> {
    assertScope(input);
    if (!input.allowedAttachmentIds.includes(input.attachmentId)) {
      throw new AttachmentToolError(
        "ATTACHMENT_NOT_ALLOWED",
        "The attachment is not allowed for this turn."
      );
    }
    const scope = storageScope(input);
    const attachment = await this.storage.getAuthorizedAttachment(scope);
    if (!attachment) {
      throw new AttachmentToolError(
        "ATTACHMENT_NOT_FOUND",
        "The attachment is unavailable."
      );
    }
    if (
      attachment.userId !== input.userId ||
      attachment.conversationId !== input.conversationId ||
      attachment.messageId !== input.messageId ||
      attachment.attachmentId !== input.attachmentId
    ) {
      throw new AttachmentToolError(
        "ATTACHMENT_SCOPE_MISMATCH",
        "Attachment ownership could not be verified."
      );
    }
    if (attachment.status !== "ready") {
      throw new AttachmentToolError(
        "ATTACHMENT_NOT_READY",
        "The attachment is not ready."
      );
    }
    if (attachment.kind !== expectedKind) {
      throw new AttachmentToolError(
        "ATTACHMENT_KIND_MISMATCH",
        `Expected a ${expectedKind} attachment.`
      );
    }
    if (
      typeof attachment.filename !== "string" ||
      !attachment.filename.trim() ||
      attachment.filename.length > 240 ||
      /[/\\\p{Cc}]/u.test(attachment.filename) ||
      (expectedKind === "document" &&
        !DOCUMENT_MIME_TYPES.has(attachment.mimeType)) ||
      (expectedKind === "image" &&
        attachment.mimeType !== "image/jpeg" &&
        attachment.mimeType !== "image/png")
    ) {
      throw new AttachmentToolError(
        "ATTACHMENT_KIND_MISMATCH",
        "Attachment filename or content type could not be verified."
      );
    }
    if (
      !Number.isInteger(attachment.sizeBytes) ||
      attachment.sizeBytes <= 0 ||
      attachment.sizeBytes > MAX_ATTACHMENT_BYTES ||
      (expectedKind === "image" &&
        (!(attachment.bytes instanceof Uint8Array) ||
          attachment.bytes.byteLength > MAX_ATTACHMENT_BYTES ||
          attachment.bytes.byteLength !== attachment.sizeBytes))
    ) {
      throw new AttachmentToolError(
        "ATTACHMENT_TOO_LARGE",
        "Attachment size could not be verified."
      );
    }
    return attachment;
  }

  private async loadSearchChunks(
    attachment: StoredAttachment,
    query: string,
    signal?: AbortSignal
  ): Promise<AttachmentTextChunk[]> {
    if (!this.storage.searchParsedChunks) {
      return this.loadDocumentChunks(attachment, signal);
    }
    const cached = await this.storage.searchParsedChunks(
      storageScope(attachment),
      query,
      MAX_SEARCH_CANDIDATE_CHUNKS
    );
    if (cached === null) {
      return this.parseAndCacheDocument(attachment, signal);
    }
    return validateCachedChunks(
      cached,
      attachment.attachmentId,
      MAX_SEARCH_CANDIDATE_CHUNKS,
      true
    );
  }

  private async loadOpenedChunk(
    attachment: StoredAttachment,
    chunkId: string,
    signal?: AbortSignal
  ): Promise<AttachmentTextChunk | undefined> {
    if (this.storage.getParsedChunk) {
      const cached = await this.storage.getParsedChunk(
        storageScope(attachment),
        chunkId
      );
      if (cached === null) return undefined;
      return validateCachedChunks([cached], attachment.attachmentId, 1)[0];
    }
    return (await this.loadDocumentChunks(attachment, signal)).find(
      (candidate) =>
        candidate.chunkId === chunkId &&
        candidate.attachmentId === attachment.attachmentId
    );
  }

  private async loadDocumentChunks(
    attachment: StoredAttachment,
    signal?: AbortSignal
  ): Promise<AttachmentTextChunk[]> {
    const scope = storageScope(attachment);
    const cached = await this.storage.getParsedChunks(scope);
    if (cached) {
      return validateCachedChunks(
        cached,
        attachment.attachmentId,
        this.maxChunks
      );
    }
    return this.parseAndCacheDocument(attachment, signal);
  }

  private async parseAndCacheDocument(
    attachment: StoredAttachment,
    signal?: AbortSignal
  ): Promise<AttachmentTextChunk[]> {
    const scope = storageScope(attachment);
    if (!this.parser) {
      throw new AttachmentToolError(
        "DOCUMENT_PARSER_UNCONFIGURED",
        "Document parsing is not configured."
      );
    }
    if (!(attachment.bytes instanceof Uint8Array)) {
      throw new AttachmentToolError(
        "DOCUMENT_PARSE_FAILED",
        "Document bytes are unavailable for fallback parsing."
      );
    }
    const job = await this.parser.submit({
      bytes: new Uint8Array(attachment.bytes),
      filename: attachment.filename,
      outputFormats: ["markdown"],
      llmEnhancement: false
    });
    let succeeded = false;
    for (let poll = 0; poll < this.maxPolls; poll += 1) {
      throwIfAborted(signal);
      const status = await this.parser.getStatus(job.jobId);
      if (status.status === "failed") {
        throw new AttachmentToolError(
          "DOCUMENT_PARSE_FAILED",
          "Document parsing failed."
        );
      }
      if (status.status === "succeeded") {
        succeeded = true;
        break;
      }
      if (poll + 1 < this.maxPolls) {
        await this.wait(this.pollIntervalMs, signal);
      }
    }
    if (!succeeded) {
      throw new AttachmentToolError(
        "DOCUMENT_PARSE_LIMIT",
        "Document parsing did not finish within the polling limit."
      );
    }
    const parsed = await this.parser.getResult(job.jobId);
    const chunks = chunkParsedDocument(
      attachment.attachmentId,
      parsed.pages,
      this.chunkCharacters,
      this.chunkOverlap,
      this.maxChunks
    );
    await this.storage.putParsedChunks(scope, chunks);
    return chunks;
  }
}

async function analyzeVisionWithOneRetry(
  provider: VisionProvider,
  request: VisionRequest
): Promise<VisionResult> {
  try {
    return await provider.analyze(request);
  } catch (error) {
    if (
      !(error instanceof ProviderError) ||
      !error.retryable ||
      request.signal?.aborted
    ) {
      throw normalizeVisionProviderError(error);
    }
  }

  try {
    return await provider.analyze(request);
  } catch (error) {
    throw normalizeVisionProviderError(error);
  }
}

function normalizeVisionProviderError(error: unknown): AttachmentToolError {
  if (error instanceof ProviderTimeoutError) {
    return new AttachmentToolError(
      "VISION_PROVIDER_TIMEOUT",
      "Vision analysis timed out."
    );
  }
  if (error instanceof ProviderError) {
    const code =
      error.status === 401 || error.status === 403
        ? "VISION_PROVIDER_AUTH_FAILED"
        : error.status === 402
          ? "VISION_PROVIDER_QUOTA_EXHAUSTED"
          : error.status === 429
            ? "VISION_PROVIDER_RATE_LIMITED"
            : error.status === 400 || error.status === 422
              ? "VISION_PROVIDER_REQUEST_INVALID"
              : error.status !== undefined && error.status >= 500
                ? "VISION_PROVIDER_UNAVAILABLE"
                : error.retryable
                  ? "VISION_PROVIDER_UNAVAILABLE"
                  : "VISION_PROVIDER_FAILED";
    return new AttachmentToolError(code, "Vision analysis failed.");
  }
  return new AttachmentToolError(
    "VISION_PROVIDER_FAILED",
    "Vision analysis failed."
  );
}

function chunkParsedDocument(
  attachmentId: string,
  pages: ReadonlyArray<{ pageNumber?: number; markdown?: string }>,
  chunkCharacters: number,
  overlap: number,
  maxChunks: number
): AttachmentTextChunk[] {
  const chunks: AttachmentTextChunk[] = [];
  for (const page of pages) {
    const text = normalizeText(page.markdown ?? "");
    for (
      let start = 0;
      start < text.length && chunks.length < maxChunks;
      start += chunkCharacters - overlap
    ) {
      const value = text.slice(start, start + chunkCharacters).trim();
      if (!value) continue;
      chunks.push({
        chunkId: createChunkId(attachmentId, chunks.length, value),
        attachmentId,
        text: value,
        ...(page.pageNumber === undefined
          ? {}
          : { pageNumber: page.pageNumber })
      });
    }
    if (chunks.length === maxChunks) break;
  }
  if (chunks.length === 0) {
    throw new AttachmentToolError(
      "DOCUMENT_PARSE_FAILED",
      "The parsed document contained no readable text."
    );
  }
  return chunks;
}

function validateCachedChunks(
  chunks: readonly AttachmentTextChunk[],
  attachmentId: string,
  maxChunks: number,
  allowEmpty = false
): AttachmentTextChunk[] {
  if ((!allowEmpty && chunks.length === 0) || chunks.length > maxChunks) {
    throw new AttachmentToolError(
      "DOCUMENT_PARSE_FAILED",
      "The parsed-document cache is invalid."
    );
  }
  return chunks.map((chunk) => {
    if (
      chunk.attachmentId !== attachmentId ||
      typeof chunk.chunkId !== "string" ||
      chunk.chunkId.length < 1 ||
      chunk.chunkId.length > 240 ||
      typeof chunk.text !== "string" ||
      chunk.text.length < 1 ||
      chunk.text.length > 8_000
    ) {
      throw new AttachmentToolError(
        "DOCUMENT_PARSE_FAILED",
        "The parsed-document cache is invalid."
      );
    }
    return { ...chunk };
  });
}

function createChunkId(
  attachmentId: string,
  index: number,
  text: string
): string {
  const digest = createHash("sha256")
    .update(attachmentId)
    .update("\0")
    .update(String(index))
    .update("\0")
    .update(text)
    .digest("hex")
    .slice(0, 16);
  return `AC${index + 1}-${digest}`;
}

function scoreChunk(
  text: string,
  query: string,
  terms: readonly string[]
): number {
  const haystack = text.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  let score = haystack.includes(normalizedQuery) ? 20 : 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

function searchTerms(value: string): string[] {
  const normalized = value.toLocaleLowerCase();
  const words = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const han = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  const bigrams = han
    .slice(0, -1)
    .map((character, index) => `${character}${han[index + 1]}`);
  return [...new Set([...words, ...bigrams])].slice(0, 64);
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v]+/gu, " ")
    .replace(/ {2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function assertScope(scope: AttachmentToolScope): void {
  boundedText(scope.userId, 240, "userId");
  boundedText(scope.conversationId, 240, "conversationId");
  boundedText(scope.messageId, 240, "messageId");
  boundedText(scope.attachmentId, 240, "attachmentId");
  if (
    !Array.isArray(scope.allowedAttachmentIds) ||
    scope.allowedAttachmentIds.length > 16 ||
    scope.allowedAttachmentIds.some(
      (id) => typeof id !== "string" || id.length < 1 || id.length > 240
    )
  ) {
    throw new AttachmentToolError(
      "INVALID_ATTACHMENT_INPUT",
      "Allowed attachment identifiers are invalid."
    );
  }
}

function storageScope(input: AttachmentAccessScope): AttachmentAccessScope {
  return {
    userId: input.userId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    attachmentId: input.attachmentId
  };
}

function boundedText(value: string, maximum: number, field: string): string {
  if (typeof value !== "string") {
    throw new AttachmentToolError(
      "INVALID_ATTACHMENT_INPUT",
      `${field} must be a string.`
    );
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum) {
    throw new AttachmentToolError(
      "INVALID_ATTACHMENT_INPUT",
      `${field} is outside the allowed length.`
    );
  }
  return normalized;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Expected a positive integer.");
  }
  return value;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Expected a non-negative integer.");
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Operation aborted.");
  }
}

function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Operation aborted.")
        );
      },
      { once: true }
    );
  });
}
