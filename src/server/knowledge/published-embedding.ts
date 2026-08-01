import type { EmbeddingResult } from "../providers";

export type PublishedEmbeddingCandidate = {
  chunkId: string;
  versionId: string;
  content: string;
  sourceTier: string;
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

  if (candidate.sourceTier === "open_license") {
    return candidate.sourceMetadata.rightsReviewed === true;
  }
  if (candidate.sourceTier === "internal") {
    return candidate.sourceMetadata.commercialAiRightsConfirmed === true;
  }
  return false;
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
