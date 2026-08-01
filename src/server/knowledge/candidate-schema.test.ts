import { describe, expect, it } from "vitest";

import superconducting from "../../../knowledge/candidates/cern-vacuum-superconducting-devices-2014.json";
import hseDsear from "../../../knowledge/candidates/hse-dsear.json";
import hseOxygen from "../../../knowledge/candidates/hse-oxygen-safety.json";
import hseMaintenance from "../../../knowledge/candidates/hse-safe-maintenance.json";
import cnPatent from "../../../knowledge/candidates/patent-cn221568833u.metadata.json";
import usPatent from "../../../knowledge/candidates/patent-us7674096b2.metadata.json";
import {
  computeKnowledgeSectionContentHash,
  hasCompleteKnowledgeSectionAudit,
  parseKnowledgeCandidate,
  renderKnowledgeCandidate
} from "./candidate-schema";

describe("knowledge candidate files", () => {
  it.each([
    ["CERN superconducting devices", superconducting],
    ["HSE safe maintenance", hseMaintenance],
    ["HSE DSEAR", hseDsear],
    ["HSE oxygen safety", hseOxygen],
    ["US7674096B2", usPatent],
    ["CN221568833U", cnPatent]
  ])("validates %s", (_name, raw) => {
    const candidate = parseKnowledgeCandidate(raw);
    expect(candidate.review.status).toBe("required");
    expect(renderKnowledgeCandidate(candidate)).toContain("关键词：");
  });

  it("keeps CERN page locators for the embedding worker", () => {
    const candidate = parseKnowledgeCandidate(superconducting);
    const rendered = renderKnowledgeCandidate(candidate);
    expect(rendered).toContain("<!-- openvac-page:497 -->");
    expect(rendered).toContain("<!-- openvac-page:513 -->");
    expect(rendered).toContain("原文摘录（印刷页 498）");
    expect(rendered).toContain("块审核：required；许可：open；SHA-256：");
    expect(candidate.sections).toHaveLength(18);
    expect(candidate.sections.every(hasCompleteKnowledgeSectionAudit)).toBe(
      true
    );
    for (const section of candidate.sections) {
      expect(section.contentHash).toBe(
        computeKnowledgeSectionContentHash({
          sourceCanonicalUrl: candidate.sourceCanonicalUrl,
          documentExternalKey: candidate.document.externalKey,
          section
        })
      );
      expect(section.chineseStatement).toBe(section.content);
      expect(section.reviewStatus).toBe("required");
    }
  });

  it("rejects an audited CERN block when material content changes without a new hash", () => {
    const raw = structuredClone(superconducting);
    raw.sections[0].applicability = `${raw.sections[0].applicability} 已变更`;

    expect(() => parseKnowledgeCandidate(raw)).toThrow(
      "contentHash does not match the canonical audited section content."
    );
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

  it("keeps web section locators for HTML evidence", () => {
    const rendered = renderKnowledgeCandidate(
      parseKnowledgeCandidate(hseMaintenance)
    );
    expect(rendered).toContain(
      "来源章节：Safe plant and equipment > Safe isolation"
    );
  });

  it("rejects full-text evidence without a page or section locator", () => {
    const raw = structuredClone(superconducting);
    delete (raw.sections[0] as { pageStart?: number }).pageStart;

    expect(() => parseKnowledgeCandidate(raw)).toThrow(
      "Full-text evidence requires either a page range or a source section locator."
    );
  });

  it("rejects a metadata-only candidate presented as open full text", () => {
    const raw = structuredClone(usPatent);
    raw.citation.licenseClass = "open";

    expect(() => parseKnowledgeCandidate(raw)).toThrow(
      "licenseClass must match ingestionMode."
    );
  });
});
