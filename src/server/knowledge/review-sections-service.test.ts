import { describe, expect, it, vi } from "vitest";

import {
  KnowledgeSectionReviewService,
  type KnowledgeSectionReviewRepository,
  type KnowledgeSectionReviewTarget,
  type StoredKnowledgeReviewSection
} from "./review-sections-service";

const target: KnowledgeSectionReviewTarget = {
  documentId: "document-1",
  documentStatus: "draft",
  currentVersionId: "version-1",
  source: {
    id: "source-1",
    sourceTier: "open_license",
    enabled: true,
    deletedAt: null,
    canonicalUrl: "https://example.com/manual.pdf",
    publisher: "Example",
    metadata: {
      rightsDecision: {
        status: "approved",
        scope: "full_text",
        appliesToRecordUrl: "https://example.com/manual.pdf",
        reviewedBy: "owner-1",
        reviewedAt: "2026-08-08T00:00:00.000Z"
      }
    }
  },
  version: {
    id: "version-1",
    content: "第一段。\n\n第二段。",
    contentHash: "a".repeat(64),
    citationMetadata: {
      ingestionMode: "full_text",
      officialText: "Paragraph one.\n\nParagraph two."
    },
    metadata: { reviewStatus: "required" },
    createdBy: "author-1",
    status: "draft"
  }
};

function repository(
  overrides: Partial<KnowledgeSectionReviewRepository> = {}
): KnowledgeSectionReviewRepository {
  return {
    getTarget: vi.fn().mockResolvedValue(target),
    listSections: vi.fn().mockResolvedValue([]),
    insertRequiredSections: vi.fn(
      async (
        _target,
        sections: import("./review-sections").KnowledgeReviewSection[]
      ) =>
        sections.map((section, index) => ({
          ...section,
          id: `section-${index + 1}`,
          decision: null
        }))
    ),
    getSection: vi.fn(),
    writeDecision: vi.fn(),
    completeReview: vi.fn(),
    ...overrides
  };
}

describe("KnowledgeSectionReviewService", () => {
  it("materializes stable required sections but never legacy approvals", async () => {
    const repo = repository();
    const service = new KnowledgeSectionReviewService(repo);

    const workspace = await service.getWorkspace("document-1");

    expect(workspace.sections).toHaveLength(2);
    expect(
      workspace.sections.every((item) => item.reviewStatus === "required")
    ).toBe(true);
    expect(repo.insertRequiredSections).toHaveBeenCalledTimes(1);
  });

  it("forbids the version author from deciding a section", async () => {
    const section = {
      id: "section-1",
      versionId: "version-1",
      versionContentHash: "a".repeat(64),
      sectionIndex: 0,
      contentZh: "第一段。",
      officialText: "Paragraph one.",
      pageStart: 1,
      pageEnd: 1,
      rightsSnapshot: {
        status: "approved",
        scope: "full_text",
        appliesToRecordUrl: "https://example.com/manual.pdf"
      },
      rightsSnapshotHash: "b".repeat(64),
      sectionHash: "c".repeat(64),
      decision: null
    } satisfies StoredKnowledgeReviewSection;
    const repo = repository({ getSection: vi.fn().mockResolvedValue(section) });

    await expect(
      new KnowledgeSectionReviewService(repo).decide({
        documentId: "document-1",
        versionId: "version-1",
        sectionId: "section-1",
        expectedSectionHash: section.sectionHash,
        expectedRevision: 0,
        decision: "approved",
        reviewerId: "author-1",
        note: undefined
      })
    ).rejects.toThrow(/不能审核自己/u);
    expect(repo.writeDecision).not.toHaveBeenCalled();
  });

  it("also forbids a user who modified the current version", async () => {
    const repo = repository({
      getTarget: vi.fn().mockResolvedValue({
        ...target,
        editorUserIds: ["author-1", "modifier-1"]
      })
    });

    await expect(
      new KnowledgeSectionReviewService(repo).decide({
        documentId: "document-1",
        versionId: "version-1",
        sectionId: "section-1",
        expectedSectionHash: "a".repeat(64),
        expectedRevision: 0,
        decision: "approved",
        reviewerId: "modifier-1"
      })
    ).rejects.toThrow(/不能审核自己/u);
    expect(repo.getSection).not.toHaveBeenCalled();
  });

  it("completes review without publishing after all current sections pass", async () => {
    const rightsDecision = target.source!.metadata.rightsDecision as Record<
      string,
      unknown
    >;
    const currentRights = {
      ...rightsDecision,
      status: "approved",
      sourceId: "source-1",
      canonicalUrl: "https://example.com/manual.pdf",
      sourceTier: "open_license",
      publisher: "Example"
    };
    const { buildKnowledgeReviewSections } = await import("./review-sections");
    const sections = buildKnowledgeReviewSections({
      versionId: "version-1",
      versionContentHash: "a".repeat(64),
      contentZh: target.version.content,
      officialText: "Paragraph one.\n\nParagraph two.",
      rightsSnapshot: currentRights
    }).map(
      (section, index) =>
        ({
          ...section,
          id: `section-${index + 1}`,
          decision: {
            decision: "approved" as const,
            sectionHash: section.sectionHash,
            reviewerId: "reviewer-1",
            note: null,
            revision: 1
          }
        }) satisfies StoredKnowledgeReviewSection
    );
    const repo = repository({
      listSections: vi.fn().mockResolvedValue(sections)
    });

    await new KnowledgeSectionReviewService(repo).complete({
      documentId: "document-1",
      versionId: "version-1",
      expectedContentHash: "a".repeat(64),
      reviewerId: "reviewer-1"
    });

    expect(repo.completeReview).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: "document-1",
        versionId: "version-1",
        reviewerId: "reviewer-1",
        ingestionMode: "full_text",
        nextDocumentStatus: "review",
        nextVersionStatus: "review"
      })
    );
  });

  it("invalidates decisions when current citation metadata changes the official text", async () => {
    const { buildKnowledgeReviewSections } = await import("./review-sections");
    const currentRights = {
      ...(target.source!.metadata.rightsDecision as Record<string, unknown>),
      status: "approved",
      sourceId: "source-1",
      canonicalUrl: "https://example.com/manual.pdf",
      sourceTier: "open_license",
      publisher: "Example"
    };
    const old = buildKnowledgeReviewSections({
      versionId: "version-1",
      versionContentHash: "a".repeat(64),
      contentZh: target.version.content,
      officialText: "Outdated one.\n\nOutdated two.",
      rightsSnapshot: currentRights
    })[0]!;
    const section = {
      ...old,
      id: "section-1",
      decision: {
        decision: "approved" as const,
        sectionHash: old.sectionHash,
        reviewerId: "reviewer-1",
        revision: 1
      }
    } satisfies StoredKnowledgeReviewSection;
    const repo = repository({
      listSections: vi.fn().mockResolvedValue([section])
    });

    await expect(
      new KnowledgeSectionReviewService(repo).complete({
        documentId: "document-1",
        versionId: "version-1",
        expectedContentHash: "a".repeat(64),
        reviewerId: "reviewer-1"
      })
    ).rejects.toThrow(/审核段落.*变化/u);
    expect(repo.completeReview).not.toHaveBeenCalled();
  });
});
