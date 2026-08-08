import { ApiError } from "@/server/api/errors";

import {
  assertKnowledgeSectionReviewComplete,
  buildPageAwareKnowledgeReviewSections,
  knowledgeRightsSnapshotHash,
  type KnowledgeReviewSection,
  type KnowledgeSectionDecision
} from "./review-sections";
import {
  assertKnowledgeSourceAuthorized,
  type GovernedKnowledgeSource
} from "./source-policy";

export type KnowledgeSectionReviewTarget = {
  documentId: string;
  documentStatus: string;
  currentVersionId: string;
  editorUserIds?: string[];
  source:
    | (GovernedKnowledgeSource & {
        id: string;
      })
    | null;
  version: {
    id: string;
    content: string;
    contentHash: string | null;
    citationMetadata: Record<string, unknown>;
    metadata: Record<string, unknown>;
    createdBy: string | null;
    status: string;
  };
};

export type StoredKnowledgeReviewSection = Omit<
  KnowledgeReviewSection,
  "id" | "reviewStatus" | "decision"
> & {
  id: string;
  decision:
    | (KnowledgeSectionDecision & {
        revision: number;
      })
    | null;
};

export type KnowledgeSectionReviewWorkspace = {
  documentId: string;
  versionId: string;
  versionContentHash: string;
  versionStatus: string;
  sections: Array<
    StoredKnowledgeReviewSection & {
      reviewStatus: "required" | KnowledgeSectionDecision["decision"];
    }
  >;
};

export type KnowledgeSectionReviewRepository = {
  getTarget(
    documentId: string,
    versionId?: string
  ): Promise<KnowledgeSectionReviewTarget | null>;
  listSections(versionId: string): Promise<StoredKnowledgeReviewSection[]>;
  insertRequiredSections(
    target: KnowledgeSectionReviewTarget,
    sections: KnowledgeReviewSection[]
  ): Promise<StoredKnowledgeReviewSection[]>;
  getSection(
    documentId: string,
    versionId: string,
    sectionId: string
  ): Promise<StoredKnowledgeReviewSection | null>;
  writeDecision(input: {
    documentId: string;
    versionId: string;
    sectionId: string;
    sectionHash: string;
    expectedRevision: number;
    decision: KnowledgeSectionDecision["decision"];
    note?: string;
    reviewerId: string;
  }): Promise<StoredKnowledgeReviewSection>;
  completeReview(input: {
    documentId: string;
    versionId: string;
    contentHash: string;
    reviewerId: string;
    reviewedAt: Date;
    sectionCount: number;
    ingestionMode: "full_text" | "metadata_only";
    nextDocumentStatus: "review";
    nextVersionStatus: "review";
  }): Promise<void>;
};

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function currentKnowledgeRightsSnapshot(
  target: KnowledgeSectionReviewTarget
): Record<string, unknown> {
  try {
    assertKnowledgeSourceAuthorized(
      target.source ?? undefined,
      target.version.citationMetadata
    );
  } catch (error) {
    throw new ApiError(
      409,
      "KNOWLEDGE_SOURCE_RIGHTS_INVALID",
      error instanceof Error
        ? `来源权利无效：${error.message}`
        : "来源权利无效，不能审核。"
    );
  }

  const source = target.source!;
  const rightsDecision = recordValue(source.metadata.rightsDecision);
  return {
    ...rightsDecision,
    status: "approved",
    sourceId: source.id,
    canonicalUrl: source.canonicalUrl,
    sourceTier: source.sourceTier,
    publisher: source.publisher
  };
}

function contentHash(target: KnowledgeSectionReviewTarget): string {
  if (!target.version.contentHash?.match(/^[a-f0-9]{64}$/u)) {
    throw new ApiError(
      409,
      "KNOWLEDGE_CONTENT_HASH_REQUIRED",
      "知识版本缺少有效内容哈希，不能生成审核段落。"
    );
  }
  return target.version.contentHash;
}

function officialText(target: KnowledgeSectionReviewTarget): string {
  const value = target.version.citationMetadata.officialText;
  return typeof value === "string" ? value : "";
}

function sectionPages(
  target: KnowledgeSectionReviewTarget
): Array<{ pageStart?: number | null; pageEnd?: number | null }> | undefined {
  const value = target.version.citationMetadata.reviewSectionPages;
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const record = recordValue(item);
    return {
      pageStart: typeof record.pageStart === "number" ? record.pageStart : null,
      pageEnd: typeof record.pageEnd === "number" ? record.pageEnd : null
    };
  });
}

function withStatuses(
  sections: StoredKnowledgeReviewSection[]
): KnowledgeSectionReviewWorkspace["sections"] {
  return sections.map((section) => ({
    ...section,
    reviewStatus: section.decision?.decision ?? "required"
  }));
}

function requiredSectionsForTarget(
  target: KnowledgeSectionReviewTarget
): KnowledgeReviewSection[] {
  return buildPageAwareKnowledgeReviewSections({
    versionId: target.version.id,
    versionContentHash: contentHash(target),
    contentZh: target.version.content,
    officialText: officialText(target),
    rightsSnapshot: currentKnowledgeRightsSnapshot(target),
    pages: sectionPages(target),
    legacyReviewMetadata: recordValue(target.version.metadata.review)
  });
}

export class KnowledgeSectionReviewService {
  constructor(private readonly repository: KnowledgeSectionReviewRepository) {}

  async getWorkspace(
    documentId: string
  ): Promise<KnowledgeSectionReviewWorkspace> {
    const target = await this.repository.getTarget(documentId);
    if (!target) {
      throw new ApiError(404, "NOT_FOUND", "知识文档不存在或无权访问。");
    }
    const hash = contentHash(target);
    let sections = await this.repository.listSections(target.version.id);
    if (sections.length === 0) {
      const required = requiredSectionsForTarget(target);
      if (required.length === 0) {
        throw new ApiError(
          409,
          "KNOWLEDGE_REVIEW_CONTENT_EMPTY",
          "知识正文为空，不能生成审核段落。"
        );
      }
      sections = await this.repository.insertRequiredSections(target, required);
    }
    return {
      documentId,
      versionId: target.version.id,
      versionContentHash: hash,
      versionStatus: target.version.status,
      sections: withStatuses(sections)
    };
  }

  async decide(input: {
    documentId: string;
    versionId: string;
    sectionId: string;
    expectedSectionHash: string;
    expectedRevision: number;
    decision: KnowledgeSectionDecision["decision"];
    note?: string;
    reviewerId: string;
  }): Promise<StoredKnowledgeReviewSection> {
    const target = await this.repository.getTarget(
      input.documentId,
      input.versionId
    );
    if (!target) {
      throw new ApiError(404, "NOT_FOUND", "知识版本不存在或无权访问。");
    }
    const editors = new Set([
      ...(target.editorUserIds ?? []),
      ...(target.version.createdBy ? [target.version.createdBy] : [])
    ]);
    if (editors.has(input.reviewerId)) {
      throw new ApiError(
        409,
        "KNOWLEDGE_SELF_REVIEW_FORBIDDEN",
        "创建或修改者不能审核自己创建的知识版本。"
      );
    }
    const section = await this.repository.getSection(
      input.documentId,
      input.versionId,
      input.sectionId
    );
    if (!section) {
      throw new ApiError(404, "NOT_FOUND", "审核段落不存在或已变化。");
    }
    if (
      section.sectionHash !== input.expectedSectionHash ||
      section.versionContentHash !== contentHash(target) ||
      section.rightsSnapshotHash !==
        knowledgeRightsSnapshotHash(currentKnowledgeRightsSnapshot(target))
    ) {
      throw new ApiError(
        409,
        "KNOWLEDGE_SECTION_CHANGED",
        "段落、版本或来源权利已变化，请刷新后重新审核。"
      );
    }
    if (input.decision !== "approved" && !input.note?.trim()) {
      throw new ApiError(
        422,
        "KNOWLEDGE_SECTION_NOTE_REQUIRED",
        "驳回或要求修改段落时必须填写审核备注。"
      );
    }
    return this.repository.writeDecision({
      ...input,
      sectionHash: section.sectionHash
    });
  }

  async complete(input: {
    documentId: string;
    versionId: string;
    expectedContentHash: string;
    reviewerId: string;
  }): Promise<KnowledgeSectionReviewWorkspace> {
    const target = await this.repository.getTarget(
      input.documentId,
      input.versionId
    );
    if (!target) {
      throw new ApiError(404, "NOT_FOUND", "知识版本不存在或无权访问。");
    }
    const sections = await this.repository.listSections(input.versionId);
    const currentSections = requiredSectionsForTarget(target);
    if (
      currentSections.length !== sections.length ||
      currentSections.some(
        (current, index) =>
          current.sectionHash !== sections[index]?.sectionHash ||
          current.versionContentHash !== sections[index]?.versionContentHash
      )
    ) {
      throw new ApiError(
        409,
        "KNOWLEDGE_SECTION_CHANGED",
        "当前内容、原文、页码或来源权利对应的审核段落已变化。"
      );
    }
    const editors = new Set([
      ...(target.editorUserIds ?? []),
      ...(target.version.createdBy ? [target.version.createdBy] : [])
    ]);
    if (
      editors.has(input.reviewerId) ||
      sections.some(
        (section) =>
          section.decision && editors.has(section.decision.reviewerId)
      )
    ) {
      throw new ApiError(
        409,
        "KNOWLEDGE_SELF_REVIEW_FORBIDDEN",
        "创建或修改者不能审核自己参与编写的知识版本。"
      );
    }
    assertKnowledgeSectionReviewComplete({
      versionId: input.versionId,
      currentVersionId: target.currentVersionId,
      versionContentHash: contentHash(target),
      expectedContentHash: input.expectedContentHash,
      versionCreatedBy: target.version.createdBy,
      reviewerId: input.reviewerId,
      currentRightsSnapshot: currentKnowledgeRightsSnapshot(target),
      sections
    });
    await this.repository.completeReview({
      documentId: input.documentId,
      versionId: input.versionId,
      contentHash: input.expectedContentHash,
      reviewerId: input.reviewerId,
      reviewedAt: new Date(),
      sectionCount: sections.length,
      ingestionMode:
        target.version.citationMetadata.ingestionMode === "metadata_only"
          ? "metadata_only"
          : "full_text",
      nextDocumentStatus: "review",
      nextVersionStatus: "review"
    });
    const refreshed = await this.repository.listSections(input.versionId);
    return {
      documentId: input.documentId,
      versionId: input.versionId,
      versionContentHash: input.expectedContentHash,
      versionStatus: "review",
      sections: withStatuses(refreshed.length > 0 ? refreshed : sections)
    };
  }
}
