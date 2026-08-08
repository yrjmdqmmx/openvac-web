import { describe, expect, it } from "vitest";

import {
  assertKnowledgeSectionReviewComplete,
  assertKnowledgeSectionPublicationReady,
  buildKnowledgeReviewSections,
  buildPageAwareKnowledgeReviewSections,
  knowledgeReviewSectionHash
} from "./review-sections";

const rights = {
  status: "approved",
  scope: "full_text",
  appliesToRecordUrl: "https://example.com/manual.pdf",
  reviewedAt: "2026-08-08T00:00:00.000Z",
  reviewedBy: "owner-1"
};

describe("knowledge review sections", () => {
  it("produces a stable hash independent of rights object key order", () => {
    const first = knowledgeReviewSectionHash({
      sectionIndex: 0,
      contentZh: "  真空泵应定期检查。\r\n",
      officialText: " Check the vacuum pump regularly. ",
      pageStart: 4,
      pageEnd: 4,
      rightsSnapshot: rights
    });
    const second = knowledgeReviewSectionHash({
      sectionIndex: 0,
      contentZh: "真空泵应定期检查。",
      officialText: "Check the vacuum pump regularly.",
      pageStart: 4,
      pageEnd: 4,
      rightsSnapshot: {
        reviewedBy: "owner-1",
        reviewedAt: "2026-08-08T00:00:00.000Z",
        appliesToRecordUrl: "https://example.com/manual.pdf",
        scope: "full_text",
        status: "approved"
      }
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toBe(first);
  });

  it("backfills legacy pending content as required sections without decisions", () => {
    const sections = buildKnowledgeReviewSections({
      versionId: "version-1",
      versionContentHash: "a".repeat(64),
      contentZh: "第一段。\n\n第二段。",
      officialText: "Paragraph one.\n\nParagraph two.",
      rightsSnapshot: rights
    });

    expect(sections).toHaveLength(2);
    expect(sections.map((section) => section.reviewStatus)).toEqual([
      "required",
      "required"
    ]);
    expect(sections.every((section) => section.decision === null)).toBe(true);
  });

  it("keeps CERN 2014 pending instead of trusting legacy approval metadata", () => {
    const [section] = buildKnowledgeReviewSections({
      versionId: "cern-2014-version",
      versionContentHash: "b".repeat(64),
      contentZh: "CERN 2014 真空资料。",
      officialText: "CERN vacuum report 2014.",
      rightsSnapshot: rights,
      legacyReviewMetadata: {
        status: "approved",
        contentHash: "b".repeat(64)
      }
    });

    expect(section?.reviewStatus).toBe("required");
    expect(section?.decision).toBeNull();
  });

  it("creates clean page-bound review paragraphs immediately after OCR", () => {
    const sections = buildPageAwareKnowledgeReviewSections({
      versionId: "version-ocr",
      versionContentHash: "f".repeat(64),
      contentZh:
        "<!-- openvac-page:3 -->\n第一段。\n\n第二段。\n\n<!-- openvac-page:4 -->\n第三段。",
      rightsSnapshot: rights
    });

    expect(sections.map((section) => section.contentZh)).toEqual([
      "第一段。",
      "第二段。",
      "第三段。"
    ]);
    expect(sections.map((section) => section.officialText)).toEqual([
      "第一段。",
      "第二段。",
      "第三段。"
    ]);
    expect(sections.map((section) => section.pageStart)).toEqual([3, 3, 4]);
    expect(sections.map((section) => section.reviewStatus)).toEqual([
      "required",
      "required",
      "required"
    ]);
  });

  it("requires a different reviewer and every current section to be approved", () => {
    const section = buildKnowledgeReviewSections({
      versionId: "version-1",
      versionContentHash: "c".repeat(64),
      contentZh: "已核对段落。",
      officialText: "Reviewed paragraph.",
      rightsSnapshot: rights
    })[0]!;

    expect(() =>
      assertKnowledgeSectionReviewComplete({
        versionId: "version-1",
        currentVersionId: "version-1",
        versionContentHash: "c".repeat(64),
        expectedContentHash: "c".repeat(64),
        versionCreatedBy: "author-1",
        reviewerId: "author-1",
        currentRightsSnapshot: rights,
        sections: [
          {
            ...section,
            decision: {
              decision: "approved",
              sectionHash: section.sectionHash,
              reviewerId: "author-1"
            }
          }
        ]
      })
    ).toThrowError(/不能审核自己创建的知识版本/u);

    expect(() =>
      assertKnowledgeSectionReviewComplete({
        versionId: "version-1",
        currentVersionId: "version-1",
        versionContentHash: "c".repeat(64),
        expectedContentHash: "c".repeat(64),
        versionCreatedBy: "author-1",
        reviewerId: "reviewer-1",
        currentRightsSnapshot: rights,
        sections: [{ ...section, decision: null }]
      })
    ).toThrowError(/所有段落通过/u);
  });

  it("invalidates completion when content, section hash, or rights changed", () => {
    const section = buildKnowledgeReviewSections({
      versionId: "version-1",
      versionContentHash: "d".repeat(64),
      contentZh: "段落。",
      officialText: "Paragraph.",
      rightsSnapshot: rights
    })[0]!;
    const approved = {
      ...section,
      decision: {
        decision: "approved" as const,
        sectionHash: section.sectionHash,
        reviewerId: "reviewer-1"
      }
    };

    expect(() =>
      assertKnowledgeSectionReviewComplete({
        versionId: "version-1",
        currentVersionId: "version-1",
        versionContentHash: "d".repeat(64),
        expectedContentHash: "e".repeat(64),
        versionCreatedBy: "author-1",
        reviewerId: "reviewer-1",
        currentRightsSnapshot: rights,
        sections: [approved]
      })
    ).toThrowError(/版本内容已变化/u);

    expect(() =>
      assertKnowledgeSectionReviewComplete({
        versionId: "version-1",
        currentVersionId: "version-1",
        versionContentHash: "d".repeat(64),
        expectedContentHash: "d".repeat(64),
        versionCreatedBy: "author-1",
        reviewerId: "reviewer-1",
        currentRightsSnapshot: { ...rights, status: "pending" },
        sections: [approved]
      })
    ).toThrowError(/来源权利/u);
  });

  it("rechecks every section decision and hash at publication time", () => {
    const section = buildKnowledgeReviewSections({
      versionId: "version-1",
      versionContentHash: "a".repeat(64),
      contentZh: "待发布段落。",
      officialText: "Paragraph ready to publish.",
      rightsSnapshot: rights
    })[0]!;
    const ready = {
      ...section,
      decision: {
        decision: "approved" as const,
        sectionHash: section.sectionHash,
        reviewerId: "reviewer-1"
      }
    };

    expect(() =>
      assertKnowledgeSectionPublicationReady({
        versionId: "version-1",
        versionContentHash: "a".repeat(64),
        versionCreatedBy: "author-1",
        currentRightsSnapshot: rights,
        sections: [ready]
      })
    ).not.toThrow();
    expect(() =>
      assertKnowledgeSectionPublicationReady({
        versionId: "version-1",
        versionContentHash: "a".repeat(64),
        versionCreatedBy: "author-1",
        currentRightsSnapshot: rights,
        sections: [
          {
            ...ready,
            decision: { ...ready.decision, decision: "changes_requested" }
          }
        ]
      })
    ).toThrowError(/所有段落通过/u);
  });
});
