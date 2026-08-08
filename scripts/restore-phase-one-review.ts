import { createHash, randomUUID } from "node:crypto";

import { and, count, eq, max, sql } from "drizzle-orm";

import { db, sqlClient } from "../src/server/db";
import {
  auditLogs,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeReviewSections,
  knowledgeSectionDecisions,
  knowledgeSources,
  knowledgeVersions
} from "../src/server/db/schema";
import {
  PHASE_ONE_CANDIDATE_ENTRIES,
  PHASE_ONE_SOURCE_MANIFEST
} from "../src/server/knowledge/phase-one-catalog";
import {
  assertLegacyPhaseOneAdoption,
  assertPhaseOneReviewRestoreAuthorized,
  buildPhaseOneReviewRestorePlan
} from "../src/server/knowledge/phase-one-review-restore";
import { mergeSeedSourceMetadata } from "../src/server/knowledge/source-metadata";

const apply = process.argv.includes("--apply");
const adoptLegacy = process.argv.includes("--adopt-legacy");
assertPhaseOneReviewRestoreAuthorized({
  apply,
  confirmation: process.env.OPENVAC_KNOWLEDGE_RESTORE_CONFIRM,
  adoptLegacy,
  legacyConfirmation: process.env.OPENVAC_KNOWLEDGE_LEGACY_ADOPTION_CONFIRM
});

function stableDryRunId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

if (!apply) {
  const preview = buildPhaseOneReviewRestorePlan({
    candidates: PHASE_ONE_CANDIDATE_ENTRIES,
    sources: PHASE_ONE_SOURCE_MANIFEST,
    sourceIdForUrl: (url) => `dry-run-source-${stableDryRunId(url)}`,
    versionIdForDocument: (externalKey, contentHash) =>
      `dry-run-version-${stableDryRunId(`${externalKey}:${contentHash}`)}`
  });
  console.log(
    JSON.stringify(
      {
        mode: "dry-run",
        documents: preview.documents.length,
        sections: preview.documents.reduce(
          (total, document) => total + document.sections.length,
          0
        ),
        decisions: 0,
        chunks: 0,
        next: "Re-run with --apply and the explicit confirmation environment variable."
      },
      null,
      2
    )
  );
} else {
  try {
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('openvac.phase_one.review.restore.v1'))`
      );
      const now = new Date();
      const sourceIds = new Map<string, string>();
      const effectiveSources: Array<{
        canonicalUrl: string;
        publisher: string;
        sourceTier: string;
        enabled: boolean;
        deletedAt?: Date | string | null;
        rightsDecision?: Record<string, unknown>;
      }> = [];

      for (const source of PHASE_ONE_SOURCE_MANIFEST) {
        const [existing] = await tx
          .select()
          .from(knowledgeSources)
          .where(eq(knowledgeSources.canonicalUrl, source.canonicalUrl))
          .limit(1);
        const sourceId = existing?.id ?? randomUUID();
        const metadata = mergeSeedSourceMetadata(existing?.metadata, {
          sourceKey: source.sourceKey,
          seededBy: "knowledge/source-manifest.json",
          rightsReviewed: source.rightsReviewed === true,
          ...("officialPublishedPdfBinaryRequired" in source &&
          source.officialPublishedPdfBinaryRequired === true
            ? { officialPublishedPdfBinaryRequired: true }
            : {}),
          ...(source.rightsDecision
            ? { rightsDecision: source.rightsDecision }
            : {})
        });
        const values = {
          kind: source.kind,
          name: source.name,
          publisher: source.publisher,
          canonicalUrl: source.canonicalUrl,
          baseUrl: source.baseUrl,
          sourceTier: source.sourceTier,
          licensePolicy: source.licensePolicy,
          trustLevel: source.trustLevel,
          enabled: source.enabled,
          notes: source.notes,
          metadata,
          updatedAt: now
        } as typeof knowledgeSources.$inferInsert;

        if (existing) {
          await tx
            .update(knowledgeSources)
            .set({ metadata, updatedAt: now })
            .where(eq(knowledgeSources.id, sourceId));
        } else {
          await tx.insert(knowledgeSources).values({
            id: sourceId,
            ...values,
            createdAt: now
          });
        }
        sourceIds.set(source.canonicalUrl, sourceId);
        const effectiveMetadata = metadata;
        const rightsDecision = effectiveMetadata.rightsDecision;
        effectiveSources.push({
          canonicalUrl: existing
            ? (existing.canonicalUrl ?? source.canonicalUrl)
            : source.canonicalUrl,
          publisher: existing ? (existing.publisher ?? "") : source.publisher,
          sourceTier: existing ? existing.sourceTier : source.sourceTier,
          enabled: existing ? existing.enabled : source.enabled,
          deletedAt: existing?.deletedAt ?? null,
          ...(rightsDecision && typeof rightsDecision === "object"
            ? { rightsDecision: rightsDecision as Record<string, unknown> }
            : {})
        });
      }

      const versionIds = new Map(
        PHASE_ONE_CANDIDATE_ENTRIES.map((entry) => [
          entry.value.document.externalKey,
          randomUUID()
        ])
      );
      const plan = buildPhaseOneReviewRestorePlan({
        candidates: PHASE_ONE_CANDIDATE_ENTRIES,
        sources: effectiveSources,
        sourceIdForUrl: (url) => {
          const sourceId = sourceIds.get(url);
          if (!sourceId) throw new Error(`Missing restored source: ${url}`);
          return sourceId;
        },
        versionIdForDocument: (externalKey) => {
          const versionId = versionIds.get(externalKey);
          if (!versionId) throw new Error(`Missing version ID: ${externalKey}`);
          return versionId;
        }
      });

      const results: Array<{
        externalKey: string;
        outcome: "created" | "new_review_version" | "unchanged";
        version: number;
        sections: number;
      }> = [];

      for (const item of plan.documents) {
        const restoreKey = `phase-one-review-v1:${item.contentHash}`;
        const [existingDocument] = await tx
          .select()
          .from(knowledgeDocuments)
          .where(
            and(
              eq(knowledgeDocuments.sourceId, item.sourceId),
              eq(knowledgeDocuments.externalKey, item.externalKey)
            )
          )
          .limit(1);
        const documentId = existingDocument?.id ?? randomUUID();
        const [currentVersion] = existingDocument?.currentVersionId
          ? await tx
              .select()
              .from(knowledgeVersions)
              .where(
                eq(knowledgeVersions.id, existingDocument.currentVersionId)
              )
              .limit(1)
          : [];
        const currentMetadata = currentVersion?.metadata ?? {};
        const [currentSectionCount, currentDecisionCount, currentChunkCount] =
          currentVersion
            ? await Promise.all([
                tx
                  .select({ value: count() })
                  .from(knowledgeReviewSections)
                  .where(
                    eq(knowledgeReviewSections.versionId, currentVersion.id)
                  ),
                tx
                  .select({ value: count() })
                  .from(knowledgeSectionDecisions)
                  .innerJoin(
                    knowledgeReviewSections,
                    eq(
                      knowledgeSectionDecisions.sectionId,
                      knowledgeReviewSections.id
                    )
                  )
                  .where(
                    eq(knowledgeReviewSections.versionId, currentVersion.id)
                  ),
                tx
                  .select({ value: count() })
                  .from(knowledgeChunks)
                  .where(eq(knowledgeChunks.versionId, currentVersion.id))
              ]).then(([sections, decisions, chunks]) => [
                Number(sections[0]?.value ?? 0),
                Number(decisions[0]?.value ?? 0),
                Number(chunks[0]?.value ?? 0)
              ])
            : [0, 0, 0];

        if (
          currentVersion?.contentHash === item.contentHash &&
          currentMetadata.reviewRestoreKey === restoreKey
        ) {
          if (currentSectionCount !== item.sections.length) {
            throw new Error(
              `Restored review section count changed for ${item.externalKey}.`
            );
          }
          if (currentDecisionCount !== 0 || currentChunkCount !== 0) {
            throw new Error(
              `Human review or retrieval data already exists for ${item.externalKey}; restore stopped without changes.`
            );
          }
          results.push({
            externalKey: item.externalKey,
            outcome: "unchanged",
            version: currentVersion.version,
            sections: item.sections.length
          });
          continue;
        }

        if (currentMetadata.reviewRestoreKey) {
          throw new Error(
            `Restored review version changed for ${item.externalKey}; restore stopped without overwriting the human workflow.`
          );
        }

        if (existingDocument) {
          if (!currentVersion) {
            throw new Error(
              `Existing document ${item.externalKey} has no current version; restore stopped without changes.`
            );
          }
          assertLegacyPhaseOneAdoption({
            enabled: adoptLegacy,
            externalKey: item.externalKey,
            expectedContentHash: item.contentHash,
            expectedChunkCount:
              item.citationMetadata.ingestionMode === "full_text"
                ? item.sections.length
                : 0,
            documentStatus: existingDocument.status,
            versionStatus: currentVersion.status,
            versionContentHash: currentVersion.contentHash,
            versionPublishedAt: currentVersion.publishedAt,
            metadata: currentMetadata,
            sectionCount: currentSectionCount,
            decisionCount: currentDecisionCount,
            chunkCount: currentChunkCount
          });
        }

        const [latestVersion] = await tx
          .select({ value: max(knowledgeVersions.version) })
          .from(knowledgeVersions)
          .where(eq(knowledgeVersions.documentId, documentId));
        const versionNumber = Number(latestVersion?.value ?? 0) + 1;
        const versionId = item.sections[0]?.versionId;
        if (!versionId) {
          throw new Error(
            `No review sections generated for ${item.externalKey}.`
          );
        }

        if (!existingDocument) {
          await tx.insert(knowledgeDocuments).values({
            id: documentId,
            sourceId: item.sourceId,
            externalKey: item.externalKey,
            title: item.title,
            description: item.description,
            language: item.language,
            mimeType: item.mimeType,
            status: "review",
            currentVersionId: null,
            tags: item.tags,
            metadata: item.documentMetadata,
            createdAt: now,
            updatedAt: now
          });
        }

        await tx.insert(knowledgeVersions).values({
          id: versionId,
          documentId,
          version: versionNumber,
          contentHash: item.contentHash,
          content: item.content,
          citationMetadata: item.citationMetadata,
          status: "review",
          parserVersion: "openvac-normalized-review-v1",
          metadata: {
            ...item.metadata,
            reviewRestoreKey: restoreKey
          },
          createdAt: now,
          updatedAt: now
        });
        await tx.insert(knowledgeReviewSections).values(
          item.sections.map((section) => ({
            versionId,
            sectionIndex: section.sectionIndex,
            contentZh: section.contentZh,
            officialText: section.officialText,
            pageStart: section.pageStart,
            pageEnd: section.pageEnd,
            rightsSnapshot: section.rightsSnapshot,
            rightsSnapshotHash: section.rightsSnapshotHash,
            versionContentHash: section.versionContentHash,
            sectionHash: section.sectionHash,
            createdAt: now,
            updatedAt: now
          }))
        );
        await tx
          .update(knowledgeDocuments)
          .set({
            title: item.title,
            description: item.description,
            language: item.language,
            mimeType: item.mimeType,
            status: "review",
            currentVersionId: versionId,
            tags: item.tags,
            metadata: {
              ...(existingDocument?.metadata ?? {}),
              ...item.documentMetadata,
              reviewRestoreKey: restoreKey
            },
            updatedAt: now
          })
          .where(eq(knowledgeDocuments.id, documentId));
        await tx.insert(auditLogs).values({
          actorRole: "system",
          action: "knowledge.phase_one.restore_review",
          targetType: "knowledge_document",
          targetId: documentId,
          requestId: restoreKey,
          before: existingDocument
            ? { currentVersionId: existingDocument.currentVersionId }
            : null,
          after: {
            currentVersionId: versionId,
            version: versionNumber,
            contentHash: item.contentHash,
            reviewSections: item.sections.length,
            decisions: 0,
            chunks: 0
          },
          metadata: {
            externalKey: item.externalKey,
            sourceCanonicalUrl: item.sourceCanonicalUrl
          },
          createdAt: now
        });
        results.push({
          externalKey: item.externalKey,
          outcome: existingDocument ? "new_review_version" : "created",
          version: versionNumber,
          sections: item.sections.length
        });
      }

      return results;
    });

    console.log(
      JSON.stringify(
        {
          mode: "applied",
          documents: outcome.length,
          sections: outcome.reduce((total, item) => total + item.sections, 0),
          decisions: 0,
          chunks: 0,
          results: outcome
        },
        null,
        2
      )
    );
  } finally {
    await sqlClient.end({ timeout: 5 });
  }
}
