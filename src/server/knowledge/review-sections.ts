import { createHash } from "node:crypto";

import { ApiError } from "@/server/api/errors";

import {
  hasCompleteKnowledgeSectionAudit,
  type KnowledgeCandidate
} from "./candidate-schema";

export type KnowledgeSectionReviewStatus =
  "required" | "approved" | "rejected" | "changes_requested";

export type KnowledgeReviewSectionInput = {
  sectionIndex: number;
  contentZh: string;
  officialText: string;
  pageStart: number | null;
  pageEnd: number | null;
  rightsSnapshot: Record<string, unknown>;
};

export type KnowledgeReviewSection = KnowledgeReviewSectionInput & {
  id?: string;
  versionId: string;
  versionContentHash: string;
  sectionHash: string;
  rightsSnapshotHash: string;
  reviewStatus: KnowledgeSectionReviewStatus;
  decision: null;
};

export type KnowledgeSectionDecision = {
  decision: Exclude<KnowledgeSectionReviewStatus, "required">;
  sectionHash: string;
  reviewerId: string;
  note?: string | null;
};

function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

export function knowledgeRightsSnapshotHash(
  rightsSnapshot: Record<string, unknown>
): string {
  return sha256(rightsSnapshot);
}

export function knowledgeReviewSectionHash(
  input: KnowledgeReviewSectionInput
): string {
  return sha256({
    sectionIndex: input.sectionIndex,
    contentZh: normalizeText(input.contentZh),
    officialText: normalizeText(input.officialText),
    pageStart: input.pageStart,
    pageEnd: input.pageEnd,
    rightsSnapshot: input.rightsSnapshot
  });
}

function paragraphs(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized
    .split(/\n\s*\n/gu)
    .map(normalizeText)
    .filter(Boolean);
}

export function buildKnowledgeReviewSections(input: {
  versionId: string;
  versionContentHash: string;
  contentZh: string;
  officialText?: string;
  rightsSnapshot: Record<string, unknown>;
  pages?: Array<{ pageStart?: number | null; pageEnd?: number | null }>;
  legacyReviewMetadata?: Record<string, unknown>;
}): KnowledgeReviewSection[] {
  // Legacy review metadata is deliberately ignored. A hash or an old whole-file
  // approval can create required review units, but can never approve them.
  void input.legacyReviewMetadata;
  const chinese = paragraphs(input.contentZh);
  const official = paragraphs(input.officialText ?? "");

  return chinese.map((contentZh, sectionIndex) => {
    const item: KnowledgeReviewSectionInput = {
      sectionIndex,
      contentZh,
      officialText: official[sectionIndex] ?? "",
      pageStart: input.pages?.[sectionIndex]?.pageStart ?? null,
      pageEnd: input.pages?.[sectionIndex]?.pageEnd ?? null,
      rightsSnapshot: input.rightsSnapshot
    };
    return {
      ...item,
      versionId: input.versionId,
      versionContentHash: input.versionContentHash,
      sectionHash: knowledgeReviewSectionHash(item),
      rightsSnapshotHash: knowledgeRightsSnapshotHash(input.rightsSnapshot),
      reviewStatus: "required",
      decision: null
    };
  });
}

function pageParagraphs(
  value: string
): Array<{ text: string; pageStart: number | null; pageEnd: number | null }> {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  const marker = /<!--\s*openvac-page:(\d+)\s*-->\s*/gu;
  const matches = [...normalized.matchAll(marker)];
  if (matches.length === 0) {
    return paragraphs(normalized).map((text) => ({
      text,
      pageStart: null,
      pageEnd: null
    }));
  }
  return matches.flatMap((match, pageIndex) => {
    const page = Number(match[1]);
    const text = normalized.slice(
      (match.index ?? 0) + match[0].length,
      matches[pageIndex + 1]?.index ?? normalized.length
    );
    return paragraphs(text).map((paragraph) => ({
      text: paragraph,
      pageStart: page,
      pageEnd: page
    }));
  });
}

export function buildPageAwareKnowledgeReviewSections(input: {
  versionId: string;
  versionContentHash: string;
  contentZh: string;
  officialText?: string;
  rightsSnapshot: Record<string, unknown>;
  pages?: Array<{ pageStart?: number | null; pageEnd?: number | null }>;
  legacyReviewMetadata?: Record<string, unknown>;
}): KnowledgeReviewSection[] {
  void input.legacyReviewMetadata;
  const chinese = pageParagraphs(input.contentZh);
  const official = pageParagraphs(input.officialText ?? "");
  return chinese.map((content, sectionIndex) => {
    const item: KnowledgeReviewSectionInput = {
      sectionIndex,
      contentZh: content.text,
      officialText: official[sectionIndex]?.text ?? content.text,
      pageStart:
        content.pageStart ?? input.pages?.[sectionIndex]?.pageStart ?? null,
      pageEnd: content.pageEnd ?? input.pages?.[sectionIndex]?.pageEnd ?? null,
      rightsSnapshot: input.rightsSnapshot
    };
    return {
      ...item,
      versionId: input.versionId,
      versionContentHash: input.versionContentHash,
      sectionHash: knowledgeReviewSectionHash(item),
      rightsSnapshotHash: knowledgeRightsSnapshotHash(input.rightsSnapshot),
      reviewStatus: "required",
      decision: null
    };
  });
}

export function buildCandidateKnowledgeReviewSections(input: {
  candidate: KnowledgeCandidate;
  versionId: string;
  versionContentHash: string;
  rightsSnapshot: Record<string, unknown>;
}): KnowledgeReviewSection[] {
  return input.candidate.sections.map((section, sectionIndex) => {
    const completeAudit = hasCompleteKnowledgeSectionAudit(section);
    const metadataOnly =
      input.candidate.citation.ingestionMode === "metadata_only";
    const sourceLocator = section.sourceSection?.trim();
    if (!completeAudit && !metadataOnly && !sourceLocator) {
      throw new ApiError(
        409,
        "KNOWLEDGE_REVIEW_EVIDENCE_INCOMPLETE",
        `第 ${sectionIndex + 1} 段缺少官方原文、页码或审核证据。`
      );
    }
    const citation = input.candidate.citation as Record<string, unknown>;
    const metadataEvidence = [
      citation.publicationNumber
        ? `出版号：${String(citation.publicationNumber)}`
        : null,
      citation.title ? `来源题名：${String(citation.title)}` : null,
      citation.officialRecordUrl
        ? `官方记录：${String(citation.officialRecordUrl)}`
        : citation.primaryAuthorityUrl
          ? `官方机构：${String(citation.primaryAuthorityUrl)}`
          : null,
      Array.isArray(citation.claimLocators)
        ? `定位：${citation.claimLocators.map(String).join("；")}`
        : null
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n");
    const locatorEvidence = sourceLocator
      ? `官方页面：${input.candidate.sourceCanonicalUrl}\n来源章节：${sourceLocator}`
      : metadataEvidence;
    const item: KnowledgeReviewSectionInput = {
      sectionIndex,
      contentZh: completeAudit ? section.chineseStatement : section.content,
      officialText: completeAudit ? section.originalExcerpt : locatorEvidence,
      pageStart: completeAudit ? section.originalExcerptPage : null,
      pageEnd: completeAudit ? section.originalExcerptPage : null,
      rightsSnapshot: input.rightsSnapshot
    };
    return {
      ...item,
      versionId: input.versionId,
      versionContentHash: input.versionContentHash,
      sectionHash: knowledgeReviewSectionHash(item),
      rightsSnapshotHash: knowledgeRightsSnapshotHash(input.rightsSnapshot),
      reviewStatus: "required",
      decision: null
    };
  });
}

function conflict(code: string, message: string): never {
  throw new ApiError(409, code, message);
}

type PublicationSection = Omit<
  KnowledgeReviewSection,
  "decision" | "reviewStatus"
> & {
  decision: {
    decision: string;
    sectionHash: string;
    reviewerId: string;
    note?: string | null;
  } | null;
};

export function assertKnowledgeSectionPublicationReady(input: {
  versionId: string;
  versionContentHash: string;
  versionCreatedBy: string | null;
  currentRightsSnapshot: Record<string, unknown>;
  sections: PublicationSection[];
}): void {
  if (input.currentRightsSnapshot.status !== "approved") {
    conflict(
      "KNOWLEDGE_SOURCE_RIGHTS_INVALID",
      "来源权利尚未有效批准，不能发布。"
    );
  }
  if (input.sections.length === 0) {
    conflict(
      "KNOWLEDGE_REVIEW_SECTIONS_MISSING",
      "尚未生成稳定审核段落，不能发布。"
    );
  }
  const currentRightsHash = knowledgeRightsSnapshotHash(
    input.currentRightsSnapshot
  );
  for (const section of input.sections) {
    if (
      section.versionId !== input.versionId ||
      section.versionContentHash !== input.versionContentHash ||
      section.sectionHash !== knowledgeReviewSectionHash(section)
    ) {
      conflict(
        "KNOWLEDGE_SECTION_CHANGED",
        "审核段落或所属版本已变化，不能发布。"
      );
    }
    if (section.rightsSnapshotHash !== currentRightsHash) {
      conflict(
        "KNOWLEDGE_SOURCE_RIGHTS_CHANGED",
        "来源权利已变化，必须重新完成人工审核。"
      );
    }
    if (
      !section.decision ||
      section.decision.decision !== "approved" ||
      section.decision.sectionHash !== section.sectionHash
    ) {
      conflict("KNOWLEDGE_SECTIONS_NOT_APPROVED", "必须先让所有段落通过审核。");
    }
    if (
      input.versionCreatedBy &&
      section.decision.reviewerId === input.versionCreatedBy
    ) {
      conflict(
        "KNOWLEDGE_SELF_REVIEW_FORBIDDEN",
        "创建或修改者不能审核自己创建的知识版本。"
      );
    }
  }
}

export function assertKnowledgeSectionReviewComplete(input: {
  versionId: string;
  currentVersionId: string;
  versionContentHash: string;
  expectedContentHash: string;
  versionCreatedBy: string | null;
  reviewerId: string;
  currentRightsSnapshot: Record<string, unknown>;
  sections: Array<
    Omit<KnowledgeReviewSection, "decision" | "reviewStatus"> & {
      decision: {
        decision: string;
        sectionHash: string;
        reviewerId: string;
        note?: string | null;
      } | null;
    }
  >;
}): void {
  if (input.versionCreatedBy && input.versionCreatedBy === input.reviewerId) {
    conflict(
      "KNOWLEDGE_SELF_REVIEW_FORBIDDEN",
      "创建或修改者不能审核自己创建的知识版本。"
    );
  }
  if (input.versionId !== input.currentVersionId) {
    conflict("KNOWLEDGE_VERSION_CHANGED", "当前知识版本已变化，请刷新后重试。");
  }
  if (input.versionContentHash !== input.expectedContentHash) {
    conflict("KNOWLEDGE_CONTENT_CHANGED", "版本内容已变化，原逐段审核已失效。");
  }
  if (input.currentRightsSnapshot.status !== "approved") {
    conflict(
      "KNOWLEDGE_SOURCE_RIGHTS_INVALID",
      "来源权利尚未有效批准，不能完成逐段审核。"
    );
  }
  if (input.sections.length === 0) {
    conflict(
      "KNOWLEDGE_REVIEW_SECTIONS_MISSING",
      "尚未生成稳定审核段落，不能完成审核。"
    );
  }

  assertKnowledgeSectionPublicationReady({
    versionId: input.versionId,
    versionContentHash: input.versionContentHash,
    versionCreatedBy: input.versionCreatedBy,
    currentRightsSnapshot: input.currentRightsSnapshot,
    sections: input.sections
  });

  for (const section of input.sections) {
    if (
      input.versionCreatedBy &&
      section.decision?.reviewerId === input.versionCreatedBy
    ) {
      conflict(
        "KNOWLEDGE_SELF_REVIEW_FORBIDDEN",
        "创建或修改者不能审核自己创建的知识版本。"
      );
    }
  }
}
