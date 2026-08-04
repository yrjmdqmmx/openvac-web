import type {
  KnowledgeCandidate,
  KnowledgeCandidateSection
} from "./candidate-schema";
import { ACTIVE_PENDING_REVIEW } from "./review-policy";

export type ProvisionalKnowledgeChunk = {
  content: string;
  pageStart?: number;
  pageEnd?: number;
  sectionPath: string[];
  metadata: Record<string, unknown>;
};

export function buildProvisionalKnowledgeChunks(
  candidate: KnowledgeCandidate
): ProvisionalKnowledgeChunk[] {
  if (candidate.citation.ingestionMode !== "full_text") return [];

  return candidate.sections.map((section) => ({
    content: renderRetrievalContent(section),
    pageStart: section.pageStart,
    pageEnd: section.pageEnd,
    sectionPath: section.sectionPath,
    metadata: {
      keywords: section.keywords,
      ...(section.sourceSection
        ? { sourceSection: section.sourceSection }
        : {}),
      ...(section.originalExcerpt
        ? { originalExcerpt: section.originalExcerpt }
        : {}),
      ...(section.originalExcerptPage
        ? { originalExcerptPage: section.originalExcerptPage }
        : {}),
      ...(section.applicability
        ? { applicability: section.applicability }
        : {}),
      ...(section.contentHash
        ? { sectionContentHash: section.contentHash }
        : {}),
      reviewStatus: "required",
      retrievalStatus: ACTIVE_PENDING_REVIEW
    }
  }));
}

export function buildPendingReviewActivationMetadata(input: {
  existing?: Record<string, unknown>;
  contentHash: string;
  embeddingStatus: "completed" | "not_applicable";
  embeddingModel?: string;
  embeddedChunkCount: number;
  activatedAt: Date;
  sourcePath: string;
}): Record<string, unknown> {
  const existing = input.existing ?? {};
  const existingReview = recordValue(existing.review);
  const alreadyApproved =
    existing.reviewStatus === "approved" &&
    existingReview.status === "approved" &&
    existingReview.contentHash === input.contentHash;

  return {
    ...existing,
    reviewStatus: alreadyApproved ? "approved" : "required",
    retrievalStatus: alreadyApproved
      ? "active_reviewed"
      : ACTIVE_PENDING_REVIEW,
    retrievalContentHash: input.contentHash,
    embeddingStatus: input.embeddingStatus,
    ...(input.embeddingModel ? { embeddingModel: input.embeddingModel } : {}),
    embeddedChunkCount: input.embeddedChunkCount,
    humanTechnicalReviewRequired: !alreadyApproved,
    provisionalActivation: {
      policy: "product_owner_deferred_human_review",
      activatedAt: input.activatedAt.toISOString(),
      sourcePath: input.sourcePath,
      contentHash: input.contentHash
    }
  };
}

function renderRetrievalContent(section: KnowledgeCandidateSection): string {
  const statement = section.chineseStatement ?? section.content;
  return section.applicability
    ? `${statement}\n\n适用条件：${section.applicability}`
    : statement;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
