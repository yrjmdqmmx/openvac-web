import type { ParsedDocument, ParsedDocumentPage } from "@/server/providers";

export type KnowledgeIngestionStage =
  | "ocr_pending"
  | "ocr_processing"
  | "review_required"
  | "embedding_pending"
  | "embedding_processing"
  | "completed";

export interface ManualReviewApproval {
  status: "approved";
  reviewedBy: string;
  reviewedAt: string;
  contentHash: string;
}

export interface KnowledgeIngestionPayload {
  stage: KnowledgeIngestionStage;
  documentId: string;
  versionId: string;
  objectKey?: string;
  filename?: string;
  parserJobId?: string;
  parserSubmittedAt?: string;
  parserPollCount?: number;
  review?: ManualReviewApproval;
}

export interface KnowledgeIngestionJob {
  id: string;
  workerId: string;
  leaseToken: string;
  payload: KnowledgeIngestionPayload;
  attempts: number;
  maxAttempts: number;
}

export interface ApprovedKnowledgeContent {
  documentId: string;
  versionId: string;
  content: string;
}

export interface EmbeddedKnowledgeChunk {
  chunkIndex: number;
  content: string;
  pageStart?: number;
  pageEnd?: number;
  sectionPath: string[];
  embedding: number[];
  embeddingModel: string;
  metadata: Record<string, unknown>;
}

export type WorkerOutcome =
  "idle" | "deferred" | "review_required" | "completed" | "failed";

export interface KnowledgeIngestionRepository {
  claimNext(workerId: string): Promise<KnowledgeIngestionJob | null>;
  renewLease(job: KnowledgeIngestionJob): Promise<void>;
  markOcrSubmitted(
    job: KnowledgeIngestionJob,
    parserJobId: string,
    retryAt: Date
  ): Promise<void>;
  deferOcrPoll(job: KnowledgeIngestionJob, retryAt: Date): Promise<void>;
  saveParsedForReview(
    job: KnowledgeIngestionJob,
    parsed: ParsedDocument,
    renderedContent: string
  ): Promise<void>;
  markReviewRequired(job: KnowledgeIngestionJob, reason: string): Promise<void>;
  loadApprovedContent(
    job: KnowledgeIngestionJob
  ): Promise<ApprovedKnowledgeContent | null>;
  saveEmbeddingsAndComplete(
    job: KnowledgeIngestionJob,
    chunks: EmbeddedKnowledgeChunk[]
  ): Promise<void>;
  markFailed(
    job: KnowledgeIngestionJob,
    error: Error,
    retryAt: Date
  ): Promise<void>;
}

export interface ParsedPageWithText extends ParsedDocumentPage {
  markdown: string;
}
