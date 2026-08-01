import { describe, expect, it } from "vitest";

import superconducting from "../../../knowledge/candidates/cern-vacuum-superconducting-devices-2014.json";
import cnPatent from "../../../knowledge/candidates/patent-cn221568833u.metadata.json";
import usPatent from "../../../knowledge/candidates/patent-us7674096b2.metadata.json";
import {
  parseKnowledgeCandidate,
  renderKnowledgeCandidate
} from "./candidate-schema";

describe("knowledge candidate files", () => {
  it.each([
    ["CERN superconducting devices", superconducting],
    ["US7674096B2", usPatent],
    ["CN221568833U", cnPatent]
  ])("validates %s", (_name, raw) => {
    const candidate = parseKnowledgeCandidate(raw);
    expect(candidate.review.status).toBe("required");
    expect(renderKnowledgeCandidate(candidate)).toContain("关键词：");
  });

  it("keeps CERN page locators for the embedding worker", () => {
    const rendered = renderKnowledgeCandidate(
      parseKnowledgeCandidate(superconducting)
    );
    expect(rendered).toContain("<!-- openvac-page:497 -->");
    expect(rendered).toContain("<!-- openvac-page:513 -->");
  });

  it.each([usPatent, cnPatent])(
    "keeps patent material metadata-only",
    (raw) => {
      const candidate = parseKnowledgeCandidate(raw);
      expect(candidate.citation.ingestionMode).toBe("metadata_only");
      expect(candidate.citation.licenseClass).toBe("metadata_only");
      expect(candidate.sections.length).toBeGreaterThan(0);
    }
  );
});
