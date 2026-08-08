import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "@/server/db";
import {
  backgroundTasks,
  auditLogs,
  knowledgeDocuments,
  knowledgeReviewSections,
  knowledgeSectionDecisions,
  knowledgeSources,
  knowledgeVersions
} from "@/server/db/schema";
import { ApiError } from "@/server/api/errors";

import type { KnowledgeReviewSection } from "./review-sections";
import type {
  KnowledgeSectionReviewRepository,
  KnowledgeSectionReviewTarget,
  StoredKnowledgeReviewSection
} from "./review-sections-service";

type SectionRow = Pick<
  typeof knowledgeReviewSections.$inferSelect,
  | "id"
  | "versionId"
  | "sectionIndex"
  | "contentZh"
  | "officialText"
  | "pageStart"
  | "pageEnd"
  | "rightsSnapshot"
  | "rightsSnapshotHash"
  | "versionContentHash"
  | "sectionHash"
>;

type DecisionRow = Pick<
  typeof knowledgeSectionDecisions.$inferSelect,
  "decision" | "sectionHash" | "reviewerId" | "note" | "revision"
>;

export function mapStoredKnowledgeReviewSection(input: {
  section: SectionRow;
  decision: DecisionRow | null;
}): StoredKnowledgeReviewSection {
  return {
    ...input.section,
    decision: input.decision
      ? {
          decision: input.decision.decision,
          sectionHash: input.decision.sectionHash,
          reviewerId: input.decision.reviewerId ?? "",
          note: input.decision.note,
          revision: input.decision.revision
        }
      : null
  };
}

async function listSectionsWith(
  database: typeof db,
  versionId: string
): Promise<StoredKnowledgeReviewSection[]> {
  const rows = await database
    .select({
      section: {
        id: knowledgeReviewSections.id,
        versionId: knowledgeReviewSections.versionId,
        sectionIndex: knowledgeReviewSections.sectionIndex,
        contentZh: knowledgeReviewSections.contentZh,
        officialText: knowledgeReviewSections.officialText,
        pageStart: knowledgeReviewSections.pageStart,
        pageEnd: knowledgeReviewSections.pageEnd,
        rightsSnapshot: knowledgeReviewSections.rightsSnapshot,
        rightsSnapshotHash: knowledgeReviewSections.rightsSnapshotHash,
        versionContentHash: knowledgeReviewSections.versionContentHash,
        sectionHash: knowledgeReviewSections.sectionHash
      },
      decision: {
        decision: knowledgeSectionDecisions.decision,
        sectionHash: knowledgeSectionDecisions.sectionHash,
        reviewerId: knowledgeSectionDecisions.reviewerId,
        note: knowledgeSectionDecisions.note,
        revision: knowledgeSectionDecisions.revision
      }
    })
    .from(knowledgeReviewSections)
    .leftJoin(
      knowledgeSectionDecisions,
      eq(knowledgeSectionDecisions.sectionId, knowledgeReviewSections.id)
    )
    .where(eq(knowledgeReviewSections.versionId, versionId))
    .orderBy(asc(knowledgeReviewSections.sectionIndex));

  return rows.map((row) =>
    mapStoredKnowledgeReviewSection({
      section: row.section,
      decision: row.decision?.decision ? row.decision : null
    })
  );
}

export class DrizzleKnowledgeSectionReviewRepository implements KnowledgeSectionReviewRepository {
  async getTarget(
    documentId: string,
    versionId?: string
  ): Promise<KnowledgeSectionReviewTarget | null> {
    const [document] = await db
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId))
      .limit(1);
    if (!document?.currentVersionId) return null;
    if (versionId && versionId !== document.currentVersionId) return null;

    const [version] = await db
      .select()
      .from(knowledgeVersions)
      .where(eq(knowledgeVersions.id, document.currentVersionId))
      .limit(1);
    if (!version || version.documentId !== documentId) return null;

    const [source] = document.sourceId
      ? await db
          .select()
          .from(knowledgeSources)
          .where(eq(knowledgeSources.id, document.sourceId))
          .limit(1)
      : [];
    const editorRows = await db
      .select({
        actorUserId: auditLogs.actorUserId,
        metadata: auditLogs.metadata
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.targetType, "knowledge_document"),
          eq(auditLogs.targetId, documentId),
          inArray(auditLogs.action, [
            "knowledge.draft.create",
            "knowledge.draft.update"
          ])
        )
      );
    const editorUserIds = [
      version.createdBy,
      ...editorRows
        .filter((row) => row.metadata.versionId === version.id)
        .map((row) => row.actorUserId)
    ].filter((value): value is string => Boolean(value));

    return {
      documentId,
      documentStatus: document.status,
      currentVersionId: document.currentVersionId,
      editorUserIds: [...new Set(editorUserIds)],
      source: source
        ? {
            id: source.id,
            sourceTier: source.sourceTier,
            enabled: source.enabled,
            deletedAt: source.deletedAt,
            canonicalUrl: source.canonicalUrl,
            publisher: source.publisher,
            metadata: source.metadata
          }
        : null,
      version: {
        id: version.id,
        content: version.content,
        contentHash: version.contentHash,
        citationMetadata: version.citationMetadata,
        metadata: version.metadata,
        createdBy: version.createdBy,
        status: version.status
      }
    };
  }

  listSections(versionId: string): Promise<StoredKnowledgeReviewSection[]> {
    return listSectionsWith(db, versionId);
  }

  async insertRequiredSections(
    target: KnowledgeSectionReviewTarget,
    sections: KnowledgeReviewSection[]
  ): Promise<StoredKnowledgeReviewSection[]> {
    await db
      .insert(knowledgeReviewSections)
      .values(
        sections.map((section) => ({
          versionId: section.versionId,
          sectionIndex: section.sectionIndex,
          contentZh: section.contentZh,
          officialText: section.officialText,
          pageStart: section.pageStart,
          pageEnd: section.pageEnd,
          rightsSnapshot: section.rightsSnapshot,
          rightsSnapshotHash: section.rightsSnapshotHash,
          versionContentHash: section.versionContentHash,
          sectionHash: section.sectionHash
        }))
      )
      .onConflictDoNothing({
        target: [
          knowledgeReviewSections.versionId,
          knowledgeReviewSections.sectionIndex
        ]
      });
    return this.listSections(target.version.id);
  }

  async getSection(
    documentId: string,
    versionId: string,
    sectionId: string
  ): Promise<StoredKnowledgeReviewSection | null> {
    const target = await this.getTarget(documentId, versionId);
    if (!target) return null;
    const rows = await db
      .select({
        section: {
          id: knowledgeReviewSections.id,
          versionId: knowledgeReviewSections.versionId,
          sectionIndex: knowledgeReviewSections.sectionIndex,
          contentZh: knowledgeReviewSections.contentZh,
          officialText: knowledgeReviewSections.officialText,
          pageStart: knowledgeReviewSections.pageStart,
          pageEnd: knowledgeReviewSections.pageEnd,
          rightsSnapshot: knowledgeReviewSections.rightsSnapshot,
          rightsSnapshotHash: knowledgeReviewSections.rightsSnapshotHash,
          versionContentHash: knowledgeReviewSections.versionContentHash,
          sectionHash: knowledgeReviewSections.sectionHash
        },
        decision: {
          decision: knowledgeSectionDecisions.decision,
          sectionHash: knowledgeSectionDecisions.sectionHash,
          reviewerId: knowledgeSectionDecisions.reviewerId,
          note: knowledgeSectionDecisions.note,
          revision: knowledgeSectionDecisions.revision
        }
      })
      .from(knowledgeReviewSections)
      .leftJoin(
        knowledgeSectionDecisions,
        eq(knowledgeSectionDecisions.sectionId, knowledgeReviewSections.id)
      )
      .where(
        and(
          eq(knowledgeReviewSections.id, sectionId),
          eq(knowledgeReviewSections.versionId, versionId)
        )
      )
      .limit(1);
    const row = rows[0];
    return row
      ? mapStoredKnowledgeReviewSection({
          section: row.section,
          decision: row.decision?.decision ? row.decision : null
        })
      : null;
  }

  async writeDecision(input: {
    documentId: string;
    versionId: string;
    sectionId: string;
    sectionHash: string;
    expectedRevision: number;
    decision: "approved" | "rejected" | "changes_requested";
    note?: string;
    reviewerId: string;
  }): Promise<StoredKnowledgeReviewSection> {
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(knowledgeSectionDecisions)
        .where(eq(knowledgeSectionDecisions.sectionId, input.sectionId))
        .limit(1)
        .for("update");
      const revision = current?.revision ?? 0;
      if (revision !== input.expectedRevision) {
        throw new ApiError(
          409,
          "KNOWLEDGE_SECTION_REVISION_CONFLICT",
          "该段落决定已被其他审核人修改，请刷新后重试。"
        );
      }
      const now = new Date();
      if (current) {
        const [updated] = await tx
          .update(knowledgeSectionDecisions)
          .set({
            sectionHash: input.sectionHash,
            decision: input.decision,
            note: input.note ?? null,
            reviewerId: input.reviewerId,
            revision: revision + 1,
            decidedAt: now,
            updatedAt: now
          })
          .where(
            and(
              eq(knowledgeSectionDecisions.sectionId, input.sectionId),
              eq(knowledgeSectionDecisions.revision, input.expectedRevision)
            )
          )
          .returning({ id: knowledgeSectionDecisions.id });
        if (!updated) {
          throw new ApiError(
            409,
            "KNOWLEDGE_SECTION_REVISION_CONFLICT",
            "该段落决定已被其他审核人修改，请刷新后重试。"
          );
        }
      } else {
        const [created] = await tx
          .insert(knowledgeSectionDecisions)
          .values({
            sectionId: input.sectionId,
            sectionHash: input.sectionHash,
            decision: input.decision,
            note: input.note ?? null,
            reviewerId: input.reviewerId,
            revision: 1,
            decidedAt: now,
            updatedAt: now
          })
          .onConflictDoNothing({
            target: knowledgeSectionDecisions.sectionId
          })
          .returning({ id: knowledgeSectionDecisions.id });
        if (!created) {
          throw new ApiError(
            409,
            "KNOWLEDGE_SECTION_REVISION_CONFLICT",
            "该段落决定已被其他审核人修改，请刷新后重试。"
          );
        }
      }
      await tx.insert(auditLogs).values({
        actorUserId: input.reviewerId,
        actorRole: "knowledge_reviewer",
        action: "knowledge.section.decision",
        targetType: "knowledge_review_section",
        targetId: input.sectionId,
        metadata: {
          documentId: input.documentId,
          versionId: input.versionId,
          sectionHash: input.sectionHash,
          decision: input.decision,
          noteProvided: Boolean(input.note)
        },
        createdAt: now
      });
    });
    const section = await this.getSection(
      input.documentId,
      input.versionId,
      input.sectionId
    );
    if (!section) {
      throw new ApiError(409, "KNOWLEDGE_SECTION_CHANGED", "审核段落已变化。");
    }
    return section;
  }

  async completeReview(input: {
    documentId: string;
    versionId: string;
    contentHash: string;
    reviewerId: string;
    reviewedAt: Date;
    sectionCount: number;
    ingestionMode: "full_text" | "metadata_only";
    nextDocumentStatus: "review";
    nextVersionStatus: "review";
  }): Promise<void> {
    await db.transaction(async (tx) => {
      const [version] = await tx
        .select()
        .from(knowledgeVersions)
        .where(eq(knowledgeVersions.id, input.versionId))
        .limit(1)
        .for("update");
      if (
        !version ||
        version.documentId !== input.documentId ||
        version.contentHash !== input.contentHash
      ) {
        throw new ApiError(
          409,
          "KNOWLEDGE_REVIEW_CONFLICT",
          "知识内容或版本已变化，请刷新后重试。"
        );
      }
      const [document] = await tx
        .select({ currentVersionId: knowledgeDocuments.currentVersionId })
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, input.documentId))
        .limit(1)
        .for("update");
      if (document?.currentVersionId !== input.versionId) {
        throw new ApiError(
          409,
          "KNOWLEDGE_VERSION_CHANGED",
          "当前知识版本已变化，请刷新后重试。"
        );
      }
      await tx
        .update(knowledgeVersions)
        .set({
          status: input.nextVersionStatus,
          metadata: {
            ...version.metadata,
            reviewStatus: "approved",
            embeddingStatus:
              input.ingestionMode === "full_text" ? "queued" : "not_applicable",
            review: {
              status: "approved",
              mode: "section",
              reviewedBy: input.reviewerId,
              reviewedAt: input.reviewedAt.toISOString(),
              contentHash: input.contentHash,
              sectionCount: input.sectionCount
            }
          },
          updatedAt: input.reviewedAt
        })
        .where(eq(knowledgeVersions.id, input.versionId));
      await tx
        .update(knowledgeDocuments)
        .set({ status: input.nextDocumentStatus, updatedAt: input.reviewedAt })
        .where(eq(knowledgeDocuments.id, input.documentId));
      if (input.ingestionMode === "full_text") {
        await tx
          .insert(backgroundTasks)
          .values({
            id: crypto.randomUUID(),
            type: "knowledge_ingestion",
            status: "queued",
            priority: 10,
            idempotencyKey: `knowledge-embedding:${input.versionId}:${input.contentHash}:section-review`,
            payload: {
              stage: "embedding_pending",
              documentId: input.documentId,
              versionId: input.versionId,
              review: {
                status: "approved",
                reviewedBy: input.reviewerId,
                reviewedAt: input.reviewedAt.toISOString(),
                contentHash: input.contentHash
              }
            },
            attempts: 0,
            maxAttempts: 3,
            runAt: input.reviewedAt,
            createdByUserId: input.reviewerId,
            createdAt: input.reviewedAt,
            updatedAt: input.reviewedAt
          })
          .onConflictDoNothing({ target: backgroundTasks.idempotencyKey });
      }
      await tx.insert(auditLogs).values({
        actorUserId: input.reviewerId,
        actorRole: "knowledge_reviewer",
        action: "knowledge.section_review.complete",
        targetType: "knowledge_document",
        targetId: input.documentId,
        metadata: {
          versionId: input.versionId,
          contentHash: input.contentHash,
          sectionCount: input.sectionCount,
          published: false
        },
        createdAt: input.reviewedAt
      });
    });
  }
}

export const knowledgeSectionReviewRepository =
  new DrizzleKnowledgeSectionReviewRepository();
