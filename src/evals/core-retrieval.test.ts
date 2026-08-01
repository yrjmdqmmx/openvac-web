import { describe, expect, it } from "vitest";

import core from "../../knowledge/core/cern-vacuum-systems-2024.json";
import {
  CORE_RETRIEVAL_EVAL_CASES,
  evaluateCoreRetrieval
} from "./core-retrieval";

describe("core retrieval evaluation", () => {
  it("contains 20 unique cases tied to real curated sections and terms", () => {
    expect(CORE_RETRIEVAL_EVAL_CASES).toHaveLength(20);
    expect(new Set(CORE_RETRIEVAL_EVAL_CASES.map((item) => item.id)).size).toBe(
      20
    );

    for (const item of CORE_RETRIEVAL_EVAL_CASES) {
      const matchingChunk = core.chunks.find(
        (chunk) =>
          chunk.sectionPath.join(" > ").includes(item.expectedSection) &&
          item.expectedTerms.every((term) => chunk.content.includes(term))
      );
      expect(matchingChunk, item.id).toBeDefined();
    }
  });

  it("reports whether the expected evidence appears in the top five", async () => {
    const item = CORE_RETRIEVAL_EVAL_CASES[0]!;
    const results = await evaluateCoreRetrieval(
      async () => [
        {
          chunkId: "chunk-1",
          documentId: "document-1",
          versionId: "version-1",
          title: "Vacuum systems",
          content: `工程证据：${item.expectedTerms.join("，")}`,
          sectionPath: [item.expectedSection],
          score: 1,
          citation: {
            sourceId: "source-1:chunk:chunk-1",
            title: "Vacuum systems",
            publisher: "CERN",
            url: item.expectedSourceUrl,
            fetchedAt: "2026-07-31T00:00:00.000Z",
            licenseClass: "open"
          }
        }
      ],
      [item]
    );

    expect(results).toEqual([
      { id: item.id, hit: true, matchedChunkId: "chunk-1" }
    ]);
  });
});
