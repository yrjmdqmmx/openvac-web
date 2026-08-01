import { createHash, randomUUID } from "node:crypto";

import core from "../knowledge/core/cern-vacuum-systems-2024.json";
import { and, eq, max } from "drizzle-orm";

import { db, sqlClient } from "../src/server/db";
import {
  knowledgeChunks,
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
    licenseUrl: core.source.licenseUrl,
    doi: core.source.doi,
    seededBy: "knowledge/core/cern-vacuum-systems-2024.json"
  },
  updatedAt: now
} as typeof knowledgeSources.$inferInsert;

try {
  const result = await db.transaction(async (tx) => {
    const [existingSource] = await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.canonicalUrl, core.source.canonicalUrl))
      .limit(1);
    const sourceId = existingSource?.id ?? randomUUID();

    if (existingSource) {
      await tx
        .update(knowledgeSources)
        .set(sourceValues)
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
        currentVersionId: knowledgeDocuments.currentVersionId
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
      status: "published",
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

    if (currentVersion?.contentHash === contentHash) {
      const currentMetadata = currentVersion.metadata ?? {};
      await tx
        .update(knowledgeVersions)
        .set({
          status: "published",
          content: canonicalContent,
          citationMetadata: core.citation,
          metadata: {
            ...currentMetadata,
            reviewStatus: "approved",
            embeddingStatus:
              typeof currentMetadata.embeddingStatus === "string"
                ? currentMetadata.embeddingStatus
                : "not_configured",
            seedVersion: 1
          },
          publishedAt: now,
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
        status: "published",
        parserVersion: "openvac-curated-v1",
        metadata: {
          reviewStatus: "approved",
          embeddingStatus: "not_configured",
          seedVersion: 1
        },
        publishedAt: now,
        createdAt: now,
        updatedAt: now
      });

      await tx.insert(knowledgeChunks).values(
        core.chunks.map((chunk, index) => ({
          id: randomUUID(),
          versionId,
          chunkIndex: index,
          content: `${chunk.content}\n关键词：${chunk.keywords.join("、")}`,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          sectionPath: chunk.sectionPath,
          metadata: {
            keywords: chunk.keywords,
            curatedTranslation: true,
            sourceLanguage: "en"
          },
          createdAt: now
        }))
      );
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
      chunks: core.chunks.length,
      unchanged: currentVersion?.contentHash === contentHash
    };
  });

  console.log(
    `Published core knowledge v${result.versionNumber}: ${result.chunks} chunks (${result.unchanged ? "refreshed" : "new version"}).`
  );
} finally {
  await sqlClient.end({ timeout: 5 });
}
