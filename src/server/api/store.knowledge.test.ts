import { describe, expect, it } from "vitest";

import { ApiError } from "./errors";
import {
  assertHistoricalRollbackTarget,
  assertKnowledgePublicationGate,
  buildKnowledgeReviewTransition,
  effectiveKnowledgeReviewStatus,
  invalidateKnowledgeReviewAfterHashChange,
  knowledgeEvidenceMetadataChanged,
  sha256KnowledgeContent,
  type KnowledgePublicationGateInput
} from "./store";

describe("knowledge publication gate", () => {
  it("accepts reviewed full-text knowledge only after embeddings exist", () => {
    expect(() =>
      assertKnowledgePublicationGate(validPublication())
    ).not.toThrow();
  });

  it("requires both the document and version to remain in review", () => {
    expectGateError(
      { ...validPublication(), documentStatus: "draft" },
      "KNOWLEDGE_REVIEW_REQUIRED"
    );
    expectGateError(
      { ...validPublication(), versionStatus: "draft" },
      "KNOWLEDGE_REVIEW_REQUIRED"
    );
  });

  it("requires an identified human reviewer and review time", () => {
    const input = validPublication();
    input.metadata = {
      ...input.metadata,
      review: {
        contentHash: input.contentHash
      }
    };

    expectGateError(input, "KNOWLEDGE_HUMAN_REVIEW_REQUIRED");
  });

  it("rejects content changed after the approved SHA-256", () => {
    const input = validPublication();
    input.content = `${input.content}\nChanged after review.`;

    expectGateError(input, "KNOWLEDGE_CONTENT_HASH_MISMATCH");
  });

  it("requires completed embeddings and at least one full-text chunk", () => {
    expectGateError(
      { ...validPublication(), chunkCount: 0 },
      "KNOWLEDGE_EMBEDDING_REQUIRED"
    );
    expectGateError(
      {
        ...validPublication(),
        metadata: {
          ...validPublication().metadata,
          embeddingStatus: "pending_review"
        }
      },
      "KNOWLEDGE_EMBEDDING_REQUIRED"
    );
  });

  it("allows reviewed metadata-only knowledge without chunks", () => {
    const input = validPublication();
    input.citationMetadata = { ingestionMode: "metadata_only" };
    input.metadata = {
      ...input.metadata,
      embeddingStatus: "not_applicable"
    };
    input.chunkCount = 0;

    expect(() => assertKnowledgePublicationGate(input)).not.toThrow();
  });
});

describe("knowledge manual review transition", () => {
  it("uses the server reviewer and queues full-text embedding by content hash", () => {
    const content = "# Pump manual\nReviewed content.";
    const contentHash = sha256KnowledgeContent(content);
    const transition = buildKnowledgeReviewTransition({
      documentId: "document-1",
      versionId: "version-1",
      expectedVersionId: "version-1",
      content,
      storedContentHash: contentHash,
      expectedContentHash: contentHash,
      ingestionMode: "full_text",
      reviewerId: "server-authenticated-reviewer",
      reviewedAt: new Date("2026-07-31T08:00:00.000Z")
    });

    expect(transition).toMatchObject({
      contentHash,
      embeddingStatus: "queued",
      review: {
        status: "approved",
        reviewedBy: "server-authenticated-reviewer",
        contentHash
      },
      task: {
        idempotencyKey: `knowledge-embedding:version-1:${contentHash}`,
        payload: {
          stage: "embedding_pending",
          documentId: "document-1",
          versionId: "version-1"
        }
      }
    });
  });

  it("rejects stale content or version approvals", () => {
    const content = "Reviewed content.";
    const contentHash = sha256KnowledgeContent(content);

    expect(() =>
      buildKnowledgeReviewTransition({
        documentId: "document-1",
        versionId: "version-2",
        expectedVersionId: "version-1",
        content,
        storedContentHash: contentHash,
        expectedContentHash: contentHash,
        ingestionMode: "metadata_only",
        reviewerId: "reviewer-1",
        reviewedAt: new Date()
      })
    ).toThrowError(
      expect.objectContaining({ code: "KNOWLEDGE_REVIEW_CONFLICT" })
    );
  });

  it("records a rejection note without queuing embeddings", () => {
    const content = "Reviewed but unsafe guidance.";
    const contentHash = sha256KnowledgeContent(content);

    expect(
      buildKnowledgeReviewTransition({
        documentId: "document-1",
        versionId: "version-1",
        expectedVersionId: "version-1",
        content,
        storedContentHash: contentHash,
        expectedContentHash: contentHash,
        ingestionMode: "full_text",
        reviewerId: "reviewer-1",
        reviewedAt: new Date("2026-07-31T08:00:00.000Z"),
        decision: "rejected",
        note: "缺少停机与能源隔离边界。"
      })
    ).toMatchObject({
      documentStatus: "draft",
      versionStatus: "draft",
      embeddingStatus: "pending_review",
      task: undefined,
      review: {
        status: "rejected",
        note: "缺少停机与能源隔离边界。"
      }
    });
  });
});

describe("knowledge review hash invalidation", () => {
  const approvedMetadata = {
    reviewStatus: "approved",
    embeddingStatus: "completed",
    review: {
      status: "approved",
      reviewedBy: "reviewer-1",
      reviewedAt: "2026-07-31T08:00:00.000Z",
      contentHash: "a".repeat(64),
      note: "依据原文逐段复核。"
    }
  };

  it("invalidates approval automatically when the content hash changes", () => {
    const invalidatedAt = new Date("2026-08-01T08:00:00.000Z");
    const result = invalidateKnowledgeReviewAfterHashChange({
      metadata: approvedMetadata,
      previousContentHash: "a".repeat(64),
      nextContentHash: "b".repeat(64),
      invalidatedBy: "editor-1",
      invalidatedAt
    });

    expect(result).toMatchObject({
      invalidated: true,
      metadata: {
        reviewStatus: "required",
        embeddingStatus: "pending_review",
        review: {
          status: "invalidated",
          contentHash: "a".repeat(64),
          invalidatedContentHash: "b".repeat(64),
          invalidatedBy: "editor-1",
          invalidatedAt: invalidatedAt.toISOString(),
          note: "依据原文逐段复核。"
        }
      }
    });
  });

  it("keeps approval intact when the hash does not change", () => {
    const result = invalidateKnowledgeReviewAfterHashChange({
      metadata: approvedMetadata,
      previousContentHash: "a".repeat(64),
      nextContentHash: "a".repeat(64),
      invalidatedBy: "editor-1",
      invalidatedAt: new Date()
    });

    expect(result).toEqual({
      invalidated: false,
      metadata: approvedMetadata
    });
  });

  it("reports stale persisted approval as invalidated in read models", () => {
    const content = "Current content";
    expect(
      effectiveKnowledgeReviewStatus({
        metadata: approvedMetadata,
        content,
        contentHash: sha256KnowledgeContent(content)
      })
    ).toBe("invalidated");
  });
});

describe("knowledge evidence metadata invalidation", () => {
  it("invalidates review when the governed source changes", () => {
    expect(
      knowledgeEvidenceMetadataChanged({
        currentSourceId: "source-cern",
        nextSourceId: "source-hse",
        ingestionModeProvided: false,
        citationMetadataProvided: false
      })
    ).toBe(true);
  });

  it("does not invalidate review when the source is unchanged", () => {
    expect(
      knowledgeEvidenceMetadataChanged({
        currentSourceId: "source-cern",
        nextSourceId: "source-cern",
        ingestionModeProvided: false,
        citationMetadataProvided: false
      })
    ).toBe(false);
  });
});

describe("knowledge rollback target gate", () => {
  it("allows a non-current archived version that was previously published", () => {
    expect(() =>
      assertHistoricalRollbackTarget({
        targetVersionId: "version-1",
        currentVersionId: "version-2",
        status: "archived",
        publishedAt: new Date("2026-07-01T00:00:00.000Z")
      })
    ).not.toThrow();
  });

  it.each([
    {
      targetVersionId: "version-2",
      currentVersionId: "version-2",
      status: "published" as const,
      publishedAt: new Date("2026-07-01T00:00:00.000Z")
    },
    {
      targetVersionId: "version-1",
      currentVersionId: "version-2",
      status: "draft" as const,
      publishedAt: new Date("2026-07-01T00:00:00.000Z")
    },
    {
      targetVersionId: "version-1",
      currentVersionId: "version-2",
      status: "archived" as const,
      publishedAt: null
    }
  ])("rejects a version that is not historical published", (input) => {
    try {
      assertHistoricalRollbackTarget(input);
      throw new Error("Expected rollback target gate to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("ROLLBACK_TARGET_NOT_PUBLISHED");
    }
  });
});

function validPublication(): KnowledgePublicationGateInput {
  const content = "# Reviewed vacuum guidance\nStop and isolate the pump.";
  const contentHash = sha256KnowledgeContent(content);

  return {
    documentStatus: "review",
    versionStatus: "review",
    content,
    contentHash,
    citationMetadata: { ingestionMode: "full_text" },
    metadata: {
      reviewStatus: "approved",
      embeddingStatus: "completed",
      review: {
        reviewedBy: "knowledge-editor-1",
        reviewedAt: new Date(Date.now() - 1_000).toISOString(),
        contentHash
      }
    },
    chunkCount: 1
  };
}

function expectGateError(
  input: KnowledgePublicationGateInput,
  code: string
): void {
  try {
    assertKnowledgePublicationGate(input);
    throw new Error("Expected publication gate to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(code);
  }
}
