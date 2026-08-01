import { describe, expect, it } from "vitest";

import {
  assertValidKnowledgeEmbeddings,
  isPublishedEmbeddingCandidate,
  type PublishedEmbeddingCandidate
} from "./published-embedding";

const base: PublishedEmbeddingCandidate = {
  chunkId: "chunk-1",
  versionId: "version-1",
  content: "reviewed evidence",
  sourceTier: "open_license",
  sourceEnabled: true,
  sourceDeletedAt: null,
  canonicalUrl: "https://cds.cern.ch/record/2929324",
  publisher: "CERN",
  sourceMetadata: {
    rightsDecision: {
      status: "approved",
      scope: "full_text",
      appliesToRecordUrl: "https://cds.cern.ch/record/2929324"
    }
  },
  versionMetadata: { reviewStatus: "approved", review: { status: "approved" } },
  citationMetadata: { ingestionMode: "full_text" }
};

describe("isPublishedEmbeddingCandidate", () => {
  it("accepts reviewed open-license full text", () => {
    expect(isPublishedEmbeddingCandidate(base)).toBe(true);
  });

  it.each(["manufacturer_metadata", "standard_metadata"])(
    "rejects %s sources even if the version says full text",
    (sourceTier) => {
      expect(isPublishedEmbeddingCandidate({ ...base, sourceTier })).toBe(
        false
      );
    }
  );

  it("requires commercial AI rights for private full text", () => {
    expect(
      isPublishedEmbeddingCandidate({
        ...base,
        sourceTier: "internal",
        sourceMetadata: { commercialAiRightsConfirmed: false }
      })
    ).toBe(false);
    expect(
      isPublishedEmbeddingCandidate({
        ...base,
        sourceTier: "internal",
        sourceMetadata: { commercialAiRightsConfirmed: true }
      })
    ).toBe(true);
  });

  it("rejects unreviewed content and metadata-only records", () => {
    expect(
      isPublishedEmbeddingCandidate({
        ...base,
        versionMetadata: { reviewStatus: "required" }
      })
    ).toBe(false);
    expect(
      isPublishedEmbeddingCandidate({
        ...base,
        citationMetadata: { ingestionMode: "metadata_only" }
      })
    ).toBe(false);
  });
});

describe("assertValidKnowledgeEmbeddings", () => {
  it("accepts one finite 1024-dimensional vector per chunk", () => {
    expect(() =>
      assertValidKnowledgeEmbeddings(
        {
          model: "text-embedding-v4",
          dimensions: 1024,
          vectors: [Array.from({ length: 1024 }, () => 0.5)]
        },
        1
      )
    ).not.toThrow();
  });

  it("rejects dimension and result-count mismatches", () => {
    expect(() =>
      assertValidKnowledgeEmbeddings(
        { model: "bad", dimensions: 3, vectors: [[1, 2, 3]] },
        1
      )
    ).toThrow(/1024-dimensional/u);
    expect(() =>
      assertValidKnowledgeEmbeddings(
        { model: "bad", dimensions: 1024, vectors: [] },
        1
      )
    ).toThrow(/1024-dimensional/u);
  });
});
