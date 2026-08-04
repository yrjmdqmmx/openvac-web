import { describe, expect, it } from "vitest";

import {
  ACTIVE_PENDING_REVIEW,
  isPendingReviewRetrievalActive,
  RETRIEVAL_REVIEW_POLICY_SQL
} from "./review-policy";

const hash = "a".repeat(64);

describe("pending-review retrieval policy", () => {
  it("allows only an explicitly activated, hash-pinned pending review", () => {
    expect(
      isPendingReviewRetrievalActive({
        metadata: {
          reviewStatus: "required",
          retrievalStatus: ACTIVE_PENDING_REVIEW,
          retrievalContentHash: hash
        },
        contentHash: hash
      })
    ).toBe(true);
  });

  it("fails closed when content changes or activation is absent", () => {
    expect(
      isPendingReviewRetrievalActive({
        metadata: {
          reviewStatus: "required",
          retrievalStatus: ACTIVE_PENDING_REVIEW,
          retrievalContentHash: hash
        },
        contentHash: "b".repeat(64)
      })
    ).toBe(false);
    expect(
      isPendingReviewRetrievalActive({
        metadata: { reviewStatus: "required" },
        contentHash: hash
      })
    ).toBe(false);
  });

  it("keeps the SQL predicate pinned to review and content state", () => {
    expect(RETRIEVAL_REVIEW_POLICY_SQL).toContain(ACTIVE_PENDING_REVIEW);
    expect(RETRIEVAL_REVIEW_POLICY_SQL).toContain("retrievalContentHash");
    expect(RETRIEVAL_REVIEW_POLICY_SQL).toContain("kv.content_hash");
  });
});
