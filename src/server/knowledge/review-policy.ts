export const ACTIVE_PENDING_REVIEW = "active_pending_review";
export const ACTIVE_REVIEWED = "active_reviewed";

/**
 * Knowledge can be used by the answer agent in either of two explicit states:
 *
 * 1. a normal human-approved publication; or
 * 2. a product-owner-activated Phase 1 publication whose exact content hash is
 *    pinned while human review is still pending.
 *
 * The second state is deliberately narrow. Changing the content hash, removing
 * the activation marker, rejecting the review, or archiving the document makes
 * the row ineligible immediately.
 */
export const RETRIEVAL_REVIEW_POLICY_SQL = `(
  (
    kv.metadata ->> 'reviewStatus' = 'approved'
    AND kv.metadata #>> '{review,status}' = 'approved'
  )
  OR (
    kv.metadata ->> 'reviewStatus' = 'required'
    AND kv.metadata ->> 'retrievalStatus' = '${ACTIVE_PENDING_REVIEW}'
    AND kv.metadata ->> 'retrievalContentHash' = kv.content_hash
  )
)`;

export function isPendingReviewRetrievalActive(input: {
  metadata: Record<string, unknown>;
  contentHash: string | null;
}): boolean {
  const configuredHash = input.metadata.retrievalContentHash;
  return (
    input.metadata.reviewStatus === "required" &&
    input.metadata.retrievalStatus === ACTIVE_PENDING_REVIEW &&
    typeof configuredHash === "string" &&
    configuredHash.length === 64 &&
    configuredHash === input.contentHash
  );
}
