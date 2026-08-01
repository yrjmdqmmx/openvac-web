import type { EmbeddingResult } from "../providers";
import {
  assertKnowledgeSourceAuthorized,
  isKnowledgeSourceTier
} from "./source-policy";

export type PublishedEmbeddingCandidate = {
  chunkId: string;
  versionId: string;
  content: string;
  sourceTier: string;
  sourceEnabled: boolean;
  sourceDeletedAt: Date | string | null;
  canonicalUrl: string | null;
  publisher: string | null;
  sourceMetadata: Record<string, unknown>;
  versionMetadata: Record<string, unknown>;
  citationMetadata: Record<string, unknown>;
};

/**
 * This gate is deliberately narrower than the publishing schema. Backfilling
 * embeddings is allowed only for already-published full text whose source
 * rights and content review were explicitly recorded.
 */
export function isPublishedEmbeddingCandidate(
  candidate: PublishedEmbeddingCandidate
): boolean {
  if (!candidate.content.trim()) return false;
  if (candidate.citationMetadata.ingestionMode !== "full_text") return false;
  if (candidate.versionMetadata.reviewStatus !== "approved") return false;
  const review = recordValue(candidate.versionMetadata.review);
  if (review.status !== "approved") return false;
  if (!isKnowledgeSourceTier(candidate.sourceTier)) return false;

  try {
    assertKnowledgeSourceAuthorized(
      {
        sourceTier: candidate.sourceTier,
        enabled: candidate.sourceEnabled,
        deletedAt: candidate.sourceDeletedAt,
        canonicalUrl: candidate.canonicalUrl,
        publisher: candidate.publisher,
        metadata: candidate.sourceMetadata
      },
      candidate.citationMetadata
    );
    return true;
  } catch {
    return false;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function assertValidKnowledgeEmbeddings(
  result: EmbeddingResult,
  expectedCount: number
): void {
  if (
    result.dimensions !== 1024 ||
    result.vectors.length !== expectedCount ||
    result.vectors.some(
      (vector) =>
        vector.length !== 1024 ||
        vector.some((value) => !Number.isFinite(value))
    )
  ) {
    throw new Error(
      "Knowledge embedding backfill requires one finite 1024-dimensional vector per chunk."
    );
  }
}
