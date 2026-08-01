import { describe, expect, it } from "vitest";

import candidate from "../../knowledge/candidates/cern-vacuum-superconducting-devices-2014.json";
import {
  CANDIDATE_RETRIEVAL_EVAL_CASES,
  evaluateCandidateRetrieval
} from "./candidate-retrieval";

describe("candidate retrieval evaluation", () => {
  it("contains eight unique, page-located CERN cases", () => {
    expect(CANDIDATE_RETRIEVAL_EVAL_CASES).toHaveLength(8);
    expect(
      new Set(CANDIDATE_RETRIEVAL_EVAL_CASES.map((item) => item.id)).size
    ).toBe(8);

    for (const item of CANDIDATE_RETRIEVAL_EVAL_CASES) {
      const section = candidate.sections.find(
        (entry) =>
          entry.sectionPath.join(" > ").includes(item.expectedSection) &&
          item.expectedTerms.every((term) => entry.content.includes(term))
      );
      expect(section, item.id).toBeDefined();
      expect(section?.pageStart).toBeTypeOf("number");
    }
  });

  it("checks the expected source, section, and terms in the top five", async () => {
    const item = CANDIDATE_RETRIEVAL_EVAL_CASES[0]!;
    const results = await evaluateCandidateRetrieval(
      async () => [
        {
          chunkId: "candidate-chunk",
          documentId: "candidate-document",
          versionId: "candidate-version",
          title: "Vacuum Technology for Superconducting Devices",
          content: item.expectedTerms.join("，"),
          sectionPath: [item.expectedSection],
          score: 1,
          citation: {
            sourceId: "candidate-source:candidate-chunk",
            title: "Vacuum Technology for Superconducting Devices",
            publisher: "CERN",
            url: item.expectedSourceUrl,
            fetchedAt: "2026-08-01T00:00:00.000Z",
            licenseClass: "open"
          }
        }
      ],
      [item]
    );
    expect(results).toEqual([
      {
        id: item.id,
        hit: true,
        matchedChunkId: "candidate-chunk"
      }
    ]);
  });
});
