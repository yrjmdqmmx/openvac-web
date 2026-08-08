import { describe, expect, it } from "vitest";

import { mapStoredKnowledgeReviewSection } from "./review-sections-repository";

describe("knowledge section repository mapping", () => {
  it("maps a missing decision to a required review unit", () => {
    const mapped = mapStoredKnowledgeReviewSection({
      section: {
        id: "section-1",
        versionId: "version-1",
        sectionIndex: 0,
        contentZh: "中文段落",
        officialText: "Official paragraph",
        pageStart: 2,
        pageEnd: 3,
        rightsSnapshot: { status: "approved" },
        rightsSnapshotHash: "a".repeat(64),
        versionContentHash: "b".repeat(64),
        sectionHash: "c".repeat(64)
      },
      decision: null
    });

    expect(mapped.decision).toBeNull();
    expect(mapped.sectionIndex).toBe(0);
  });

  it("returns the persisted revision and exact reviewed section hash", () => {
    const mapped = mapStoredKnowledgeReviewSection({
      section: {
        id: "section-1",
        versionId: "version-1",
        sectionIndex: 0,
        contentZh: "中文段落",
        officialText: "Official paragraph",
        pageStart: null,
        pageEnd: null,
        rightsSnapshot: { status: "approved" },
        rightsSnapshotHash: "a".repeat(64),
        versionContentHash: "b".repeat(64),
        sectionHash: "c".repeat(64)
      },
      decision: {
        decision: "changes_requested",
        sectionHash: "c".repeat(64),
        reviewerId: "reviewer-1",
        note: "术语需要修正。",
        revision: 2
      }
    });

    expect(mapped.decision).toEqual({
      decision: "changes_requested",
      sectionHash: "c".repeat(64),
      reviewerId: "reviewer-1",
      note: "术语需要修正。",
      revision: 2
    });
  });
});
