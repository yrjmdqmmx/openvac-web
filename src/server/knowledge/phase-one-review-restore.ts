import { createHash } from "node:crypto";

import {
  renderKnowledgeCandidate,
  type KnowledgeCandidate
} from "./candidate-schema";
import {
  buildCandidateKnowledgeReviewSections,
  type KnowledgeReviewSection
} from "./review-sections";
import {
  assertKnowledgeSourceAuthorized,
  isKnowledgeSourceTier
} from "./source-policy";

type CandidateEntry = {
  path: string;
  value: KnowledgeCandidate;
};

type SourceRecord = {
  canonicalUrl: string;
  publisher: string;
  sourceTier: string;
  enabled: boolean;
  deletedAt?: Date | string | null;
  rightsDecision?: Record<string, unknown>;
};

export type PhaseOneReviewRestoreDocument = {
  sourceId: string;
  sourceCanonicalUrl: string;
  externalKey: string;
  title: string;
  description: string;
  language: string;
  mimeType: string;
  tags: string[];
  status: "review";
  content: string;
  contentHash: string;
  citationMetadata: Record<string, unknown>;
  documentMetadata: Record<string, unknown>;
  metadata: Record<string, unknown>;
  sections: KnowledgeReviewSection[];
  chunks: [];
};

export function assertPhaseOneReviewRestoreAuthorized(input: {
  apply: boolean;
  confirmation?: string;
  adoptLegacy?: boolean;
  legacyConfirmation?: string;
}): void {
  if (!input.apply) return;
  if (input.confirmation !== "RESTORE_PHASE_ONE_REVIEW") {
    throw new Error(
      "Applying the knowledge restore requires OPENVAC_KNOWLEDGE_RESTORE_CONFIRM=RESTORE_PHASE_ONE_REVIEW."
    );
  }
  if (
    input.adoptLegacy === true &&
    input.legacyConfirmation !== "ADOPT_PHASE_ONE_LEGACY"
  ) {
    throw new Error(
      "Adopting exact legacy Phase 1 versions requires OPENVAC_KNOWLEDGE_LEGACY_ADOPTION_CONFIRM=ADOPT_PHASE_ONE_LEGACY."
    );
  }
}

export function assertLegacyPhaseOneAdoption(input: {
  enabled: boolean;
  externalKey: string;
  expectedContentHash: string;
  expectedChunkCount: number;
  documentStatus: string;
  versionStatus: string;
  versionContentHash: string | null;
  versionPublishedAt: Date | null;
  metadata: Record<string, unknown>;
  sectionCount: number;
  decisionCount: number;
  chunkCount: number;
}): void {
  if (!input.enabled) {
    throw new Error(
      `Existing document ${input.externalKey} requires explicit --adopt-legacy confirmation.`
    );
  }
  const matchesLegacyFingerprint =
    input.documentStatus === "published" &&
    input.versionStatus === "published" &&
    input.versionPublishedAt instanceof Date &&
    input.versionContentHash === input.expectedContentHash &&
    input.metadata.reviewStatus === "required" &&
    input.metadata.retrievalStatus === "active_pending_review" &&
    input.metadata.retrievalContentHash === input.expectedContentHash &&
    input.sectionCount === 0 &&
    input.decisionCount === 0 &&
    input.chunkCount === input.expectedChunkCount;
  if (!matchesLegacyFingerprint) {
    throw new Error(
      `Existing document ${input.externalKey} does not match the exact provisional Phase 1 legacy fingerprint; restore stopped without changing its current version.`
    );
  }
}

export function buildPhaseOneReviewRestorePlan(input: {
  candidates: readonly CandidateEntry[];
  sources: readonly SourceRecord[];
  sourceIdForUrl: (canonicalUrl: string) => string;
  versionIdForDocument?: (externalKey: string, contentHash: string) => string;
}): { documents: PhaseOneReviewRestoreDocument[] } {
  const documents = input.candidates.map((entry) => {
    const candidate = entry.value;
    const source = input.sources.find(
      (item) => item.canonicalUrl === candidate.sourceCanonicalUrl
    );
    if (!source) {
      throw new Error(
        `缺少受治理来源：${candidate.sourceCanonicalUrl}（${candidate.document.externalKey}）`
      );
    }
    const sourceId = input.sourceIdForUrl(candidate.sourceCanonicalUrl);
    if (!isKnowledgeSourceTier(source.sourceTier)) {
      throw new Error(
        `无效的知识来源层级：${source.sourceTier}（${source.canonicalUrl}）`
      );
    }
    assertKnowledgeSourceAuthorized(
      {
        sourceTier: source.sourceTier,
        enabled: source.enabled,
        deletedAt: source.deletedAt ?? null,
        canonicalUrl: source.canonicalUrl,
        publisher: source.publisher,
        metadata: {
          ...(source.rightsDecision
            ? { rightsDecision: source.rightsDecision }
            : {})
        }
      },
      candidate.citation
    );
    const content = renderKnowledgeCandidate(candidate);
    const contentHash = createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
    const versionId = input.versionIdForDocument
      ? input.versionIdForDocument(candidate.document.externalKey, contentHash)
      : `phase-one-review:${candidate.document.externalKey}:${contentHash}`;
    const rightsSnapshot = {
      ...(source.rightsDecision ?? {}),
      status: "approved",
      sourceId,
      canonicalUrl: source.canonicalUrl,
      sourceTier: source.sourceTier,
      publisher: source.publisher
    };

    return {
      sourceId,
      sourceCanonicalUrl: candidate.sourceCanonicalUrl,
      externalKey: candidate.document.externalKey,
      title: candidate.document.title,
      description: candidate.document.description,
      language: candidate.document.language,
      mimeType: candidate.document.mimeType,
      tags: candidate.document.tags,
      status: "review" as const,
      content,
      contentHash,
      citationMetadata: {
        ...candidate.citation,
        sourceCandidatePath: entry.path,
        reviewEvidenceMode: "normalized_sections_v1"
      },
      documentMetadata: {
        curationStatus: "ai_assisted_draft",
        sourceCandidatePath: entry.path,
        reviewRequirements: candidate.review.requirements,
        restoredForHumanReview: true,
        notRetrievableUntilHumanReviewAndPublication: true
      },
      metadata: {
        reviewStatus: "required",
        embeddingStatus:
          candidate.citation.ingestionMode === "full_text"
            ? "pending_review"
            : "not_applicable",
        curationStatus: "ai_assisted_draft",
        sourceCandidatePath: entry.path,
        restoredForHumanReview: true
      },
      sections: buildCandidateKnowledgeReviewSections({
        candidate,
        versionId,
        versionContentHash: contentHash,
        rightsSnapshot
      }),
      chunks: [] as []
    };
  });

  return { documents };
}
