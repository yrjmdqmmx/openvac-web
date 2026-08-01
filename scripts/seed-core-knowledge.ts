import { createHash, randomUUID } from "node:crypto";

import core from "../knowledge/core/cern-vacuum-systems-2024.json";
import { and, eq, max } from "drizzle-orm";

import { db, sqlClient } from "../src/server/db";
import {
  knowledgeDocuments,
  knowledgeSources,
  knowledgeVersions
} from "../src/server/db/schema";

const now = new Date();
const sourceValues = {
  kind: core.source.kind,
  name: core.source.name,
  publisher: core.source.publisher,
  canonicalUrl: core.source.canonicalUrl,
  baseUrl: core.source.baseUrl,
  sourceTier: core.source.sourceTier,
  licensePolicy: core.source.licensePolicy,
  trustLevel: core.source.trustLevel,
  enabled: true,
  notes: "Official CERN record and PDF reviewed. Published under CC BY 4.0.",
  metadata: {
    sourceKey: core.source.sourceKey,
    rightsReviewed: true,
    rightsDecision: core.source.rightsDecision,
    licenseUrl: core.source.licenseUrl,
    doi: core.source.doi,
    seededBy: "knowledge/core/cern-vacuum-systems-2024.json"
  },
  updatedAt: now
} as typeof knowledgeSources.$inferInsert;

try {
  const result = await db.transaction(async (tx) => {
    const [existingSource] = await tx
      .select({ id: knowledgeSources.id, metadata: knowledgeSources.metadata })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.canonicalUrl, core.source.canonicalUrl))
      .limit(1);
    const sourceId = existingSource?.id ?? randomUUID();

    if (existingSource) {
      await tx
        .update(knowledgeSources)
        .set({
          ...sourceValues,
          metadata: {
            ...(sourceValues.metadata ?? {}),
            ...(existingSource.metadata ?? {})
          }
        })
        .where(eq(knowledgeSources.id, sourceId));
    } else {
      await tx.insert(knowledgeSources).values({
        id: sourceId,
        ...sourceValues,
        createdAt: now
      });
    }

    const [existingDocument] = await tx
      .select({
        id: knowledgeDocuments.id,
        currentVersionId: knowledgeDocuments.currentVersionId,
        status: knowledgeDocuments.status
      })
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.sourceId, sourceId),
          eq(knowledgeDocuments.externalKey, core.document.externalKey)
        )
      )
      .limit(1);
    const documentId = existingDocument?.id ?? randomUUID();

    const documentValues = {
      sourceId,
      externalKey: core.document.externalKey,
      title: core.document.title,
      description: core.document.description,
      language: core.document.language,
      mimeType: core.document.mimeType,
      status: existingDocument?.status ?? "draft",
      tags: core.document.tags,
      metadata: {
        attribution:
          "Vincent Baglin and Roberto Kersevan, Vacuum systems, CERN, 2024",
        doi: core.source.doi,
        license: core.source.licensePolicy,
        curatedTranslation: true,
        expertReviewRequiredForEngineeringDecision: true
      },
      updatedAt: now
    } as typeof knowledgeDocuments.$inferInsert;

    if (existingDocument) {
      await tx
        .update(knowledgeDocuments)
        .set(documentValues)
        .where(eq(knowledgeDocuments.id, documentId));
    } else {
      await tx.insert(knowledgeDocuments).values({
        id: documentId,
        ...documentValues,
        currentVersionId: null,
        createdAt: now
      });
    }

    const canonicalContent = core.chunks
      .map(
        (chunk) =>
          `${chunk.sectionPath.join(" > ")}\n${chunk.content}\n关键词：${chunk.keywords.join("、")}`
      )
      .join("\n\n");
    const contentHash = createHash("sha256")
      .update(canonicalContent, "utf8")
      .digest("hex");

    const [currentVersion] = existingDocument?.currentVersionId
      ? await tx
          .select({
            id: knowledgeVersions.id,
            contentHash: knowledgeVersions.contentHash,
            version: knowledgeVersions.version,
            status: knowledgeVersions.status,
            metadata: knowledgeVersions.metadata
          })
          .from(knowledgeVersions)
          .where(eq(knowledgeVersions.id, existingDocument.currentVersionId))
          .limit(1)
      : [];
    const [latestVersion] = await tx
      .select({ value: max(knowledgeVersions.version) })
      .from(knowledgeVersions)
      .where(eq(knowledgeVersions.documentId, documentId));
    const versionId =
      currentVersion?.contentHash === contentHash
        ? currentVersion.id
        : randomUUID();
    const versionNumber =
      currentVersion?.contentHash === contentHash
        ? currentVersion.version
        : Number(latestVersion?.value ?? 0) + 1;

    if (existingDocument && currentVersion?.contentHash !== contentHash) {
      throw new Error(
        "Core knowledge content changed. Refusing to bypass the draft and human-review workflow."
      );
    }

    if (currentVersion?.contentHash === contentHash) {
      const currentMetadata = currentVersion.metadata ?? {};
      await tx
        .update(knowledgeVersions)
        .set({
          status: currentVersion.status,
          content: canonicalContent,
          citationMetadata: core.citation,
          metadata: {
            ...currentMetadata,
            reviewStatus:
              typeof currentMetadata.reviewStatus === "string"
                ? currentMetadata.reviewStatus
                : "required",
            embeddingStatus:
              typeof currentMetadata.embeddingStatus === "string"
                ? currentMetadata.embeddingStatus
                : "not_configured",
            seedVersion: 1,
            legacySeed: true,
            humanTechnicalReviewRequired: true
          },
          updatedAt: now
        })
        .where(eq(knowledgeVersions.id, versionId));
    } else {
      await tx.insert(knowledgeVersions).values({
        id: versionId,
        documentId,
        version: versionNumber,
        contentHash,
        content: canonicalContent,
        citationMetadata: core.citation,
        status: "draft",
        parserVersion: "openvac-curated-v1",
        metadata: {
          reviewStatus: "required",
          embeddingStatus: "pending_review",
          seedVersion: 1,
          legacySeed: true,
          humanTechnicalReviewRequired: true
        },
        createdAt: now,
        updatedAt: now
      });
    }

    await tx
      .update(knowledgeDocuments)
      .set({
        ...documentValues,
        currentVersionId: versionId
      })
      .where(eq(knowledgeDocuments.id, documentId));

    return {
      sourceId,
      documentId,
      versionId,
      versionNumber,
      chunks: currentVersion?.status === "published" ? core.chunks.length : 0,
      status: currentVersion?.status ?? "draft",
      unchanged: currentVersion?.contentHash === contentHash
    };
  });

  console.log(
    `${result.status === "published" ? "Refreshed published" : "Seeded review-required"} core knowledge v${result.versionNumber}: ${result.chunks} retrievable chunks (${result.unchanged ? "unchanged" : "new draft"}).`
  );
} finally {
  await sqlClient.end({ timeout: 5 });
}
