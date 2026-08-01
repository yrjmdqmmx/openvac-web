import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db, sqlClient } from "../src/server/db";
import {
  knowledgeDocuments,
  knowledgeSources,
  knowledgeVersions
} from "../src/server/db/schema";
import {
  renderKnowledgeCandidate,
  type KnowledgeCandidate
} from "../src/server/knowledge/candidate-schema";
import { PHASE_ONE_CANDIDATE_ENTRIES } from "../src/server/knowledge/phase-one-catalog";

type SeedResult = {
  key: string;
  status: "created" | "unchanged" | "skipped";
  reason?: string;
};

async function seedCandidate(
  candidate: KnowledgeCandidate,
  seedPath: string
): Promise<SeedResult> {
  const now = new Date();
  const content = renderKnowledgeCandidate(candidate);
  const contentHash = createHash("sha256")
    .update(content, "utf8")
    .digest("hex");

  return db.transaction(async (tx) => {
    const [source] = await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.canonicalUrl, candidate.sourceCanonicalUrl))
      .limit(1);
    if (!source) {
      throw new Error(
        `Missing governed source for ${candidate.document.externalKey}; run knowledge:seed first.`
      );
    }

    const [existingDocument] = await tx
      .select({
        id: knowledgeDocuments.id,
        status: knowledgeDocuments.status,
        currentVersionId: knowledgeDocuments.currentVersionId
      })
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.sourceId, source.id),
          eq(knowledgeDocuments.externalKey, candidate.document.externalKey)
        )
      )
      .limit(1);

    if (existingDocument) {
      if (
        existingDocument.status !== "draft" ||
        !existingDocument.currentVersionId
      ) {
        return {
          key: candidate.document.externalKey,
          status: "skipped",
          reason: "human review workflow has already started"
        };
      }
      const [current] = await tx
        .select({ contentHash: knowledgeVersions.contentHash })
        .from(knowledgeVersions)
        .where(eq(knowledgeVersions.id, existingDocument.currentVersionId))
        .limit(1);
      if (current?.contentHash !== contentHash) {
        return {
          key: candidate.document.externalKey,
          status: "skipped",
          reason:
            "existing draft differs; refusing to overwrite possible human edits"
        };
      }
      return {
        key: candidate.document.externalKey,
        status: "unchanged"
      };
    }

    const documentId = randomUUID();
    const versionId = randomUUID();
    await tx.insert(knowledgeDocuments).values({
      id: documentId,
      sourceId: source.id,
      externalKey: candidate.document.externalKey,
      title: candidate.document.title,
      description: candidate.document.description,
      language: candidate.document.language,
      mimeType: candidate.document.mimeType,
      status: "draft",
      currentVersionId: null,
      tags: candidate.document.tags,
      metadata: {
        curationStatus: "ai_assisted_draft",
        sourceCandidatePath: seedPath,
        reviewRequirements: candidate.review.requirements,
        notRetrievableUntilHumanReviewAndPublication: true
      },
      createdAt: now,
      updatedAt: now
    });

    await tx.insert(knowledgeVersions).values({
      id: versionId,
      documentId,
      version: 1,
      contentHash,
      content,
      citationMetadata: candidate.citation,
      status: "draft",
      parserVersion: "openvac-reviewed-candidate-v1",
      metadata: {
        reviewStatus: "required",
        embeddingStatus:
          candidate.citation.ingestionMode === "full_text"
            ? "pending_review"
            : "not_applicable",
        curationStatus: "ai_assisted_draft",
        sourceCandidatePath: seedPath
      },
      createdAt: now,
      updatedAt: now
    });

    await tx
      .update(knowledgeDocuments)
      .set({ currentVersionId: versionId, updatedAt: now })
      .where(eq(knowledgeDocuments.id, documentId));

    return {
      key: candidate.document.externalKey,
      status: "created"
    };
  });
}

try {
  const results: SeedResult[] = [];
  for (const entry of PHASE_ONE_CANDIDATE_ENTRIES) {
    results.push(await seedCandidate(entry.value, entry.path));
  }
  for (const result of results) {
    console.log(
      `${result.status.toUpperCase()}: ${result.key}${result.reason ? ` (${result.reason})` : ""}`
    );
  }
} finally {
  await sqlClient.end({ timeout: 5 });
}
