import { createHash, randomUUID } from "node:crypto";

import coreVacuumSystems from "../knowledge/core/cern-vacuum-systems-2024.json";
import superconducting from "../knowledge/candidates/cern-vacuum-superconducting-devices-2014.json";
import cnPatent from "../knowledge/candidates/patent-cn221568833u.metadata.json";
import usPatent from "../knowledge/candidates/patent-us7674096b2.metadata.json";
import { and, eq } from "drizzle-orm";

import { db, sqlClient } from "../src/server/db";
import {
  knowledgeDocuments,
  knowledgeSources,
  knowledgeVersions
} from "../src/server/db/schema";
import {
  parseKnowledgeCandidate,
  renderKnowledgeCandidate,
  type KnowledgeCandidate
} from "../src/server/knowledge/candidate-schema";

const governedCoreCandidate = {
  sourceCanonicalUrl: coreVacuumSystems.source.canonicalUrl,
  document: {
    ...coreVacuumSystems.document,
    externalKey: `${coreVacuumSystems.document.externalKey}-governed-v2`,
    title: "II.8 — Vacuum systems（正式复核候选版）",
    description:
      "旧预发布种子的正式治理迁移副本；内容和页码必须由真人复核并留下内容哈希后，才能替代旧版本进入检索。"
  },
  citation: coreVacuumSystems.citation,
  review: {
    status: "required" as const,
    requirements: [
      "逐条核对中文表述与 CERN 原文页码",
      "核对压力、抽速、流导、单位和公式适用条件",
      "确认未把教学示例或特定设备参数推广为通用性能",
      "由真空行业专家批准后才允许替代旧种子版本"
    ]
  },
  sections: coreVacuumSystems.chunks
};

const candidates = [
  {
    path: "knowledge/core/cern-vacuum-systems-2024.json#governed-v2",
    value: governedCoreCandidate
  },
  {
    path: "knowledge/candidates/cern-vacuum-superconducting-devices-2014.json",
    value: superconducting
  },
  {
    path: "knowledge/candidates/patent-us7674096b2.metadata.json",
    value: usPatent
  },
  {
    path: "knowledge/candidates/patent-cn221568833u.metadata.json",
    value: cnPatent
  }
];

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
  for (const entry of candidates) {
    results.push(
      await seedCandidate(parseKnowledgeCandidate(entry.value), entry.path)
    );
  }
  for (const result of results) {
    console.log(
      `${result.status.toUpperCase()}: ${result.key}${result.reason ? ` (${result.reason})` : ""}`
    );
  }
} finally {
  await sqlClient.end({ timeout: 5 });
}
