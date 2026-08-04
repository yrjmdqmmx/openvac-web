import { createHash, randomUUID } from "node:crypto";

import { sqlClient } from "../src/server/db";
import { renderKnowledgeCandidate } from "../src/server/knowledge/candidate-schema";
import { PHASE_ONE_CANDIDATE_ENTRIES } from "../src/server/knowledge/phase-one-catalog";
import {
  buildPendingReviewActivationMetadata,
  buildProvisionalKnowledgeChunks
} from "../src/server/knowledge/provisional-activation";
import {
  assertKnowledgeSourceAuthorized,
  isKnowledgeSourceTier,
  type KnowledgeSourceTier
} from "../src/server/knowledge/source-policy";
import { assertValidKnowledgeEmbeddings } from "../src/server/knowledge/published-embedding";
import { getEmbeddingProvider } from "../src/server/providers";

type ExistingDocument = {
  documentId: string;
  documentStatus: string;
  versionId: string | null;
  versionNumber: number | null;
  versionStatus: string | null;
  contentHash: string | null;
  metadata: Record<string, unknown>;
  chunkCount: number;
  embeddedChunkCount: number;
  embeddingModel?: string;
};

const activatedAt = new Date();
const activatedAtSql = activatedAt.toISOString();
const legacyKnowledgeReplacements = [
  {
    legacyExternalKey: "cern-2024-003-vacuum-systems",
    replacementExternalKey: "cern-2024-003-vacuum-systems-governed-v2"
  }
] as const;

try {
  const results = [];
  for (const entry of PHASE_ONE_CANDIDATE_ENTRIES) {
    const candidate = entry.value;
    const content = renderKnowledgeCandidate(candidate);
    const contentHash = createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
    const source = await loadAuthorizedSource(
      candidate.sourceCanonicalUrl,
      candidate.citation
    );
    const existing = await loadExistingDocument(
      source.id,
      candidate.document.externalKey
    );
    if (existing?.versionId && existing.contentHash !== contentHash) {
      throw new Error(
        `Refusing to replace changed knowledge content for ${candidate.document.externalKey}. Archive or review the existing version first.`
      );
    }

    const chunks = buildProvisionalKnowledgeChunks(candidate);
    const canReuseEmbeddings =
      chunks.length > 0 &&
      existing?.documentStatus === "published" &&
      existing.versionStatus === "published" &&
      existing.contentHash === contentHash &&
      existing.metadata.retrievalContentHash === contentHash &&
      existing.metadata.embeddingStatus === "completed" &&
      existing.chunkCount === chunks.length &&
      existing.embeddedChunkCount === chunks.length &&
      Boolean(existing.embeddingModel);
    const embeddingResult =
      chunks.length > 0 && !canReuseEmbeddings
        ? await getEmbeddingProvider().embed(
            chunks.map((chunk) => chunk.content)
          )
        : undefined;
    if (embeddingResult) {
      assertValidKnowledgeEmbeddings(embeddingResult, chunks.length);
    }

    const documentId = existing?.documentId ?? randomUUID();
    const versionId = existing?.versionId ?? randomUUID();
    const versionNumber = existing?.versionNumber ?? 1;
    const versionMetadata = buildPendingReviewActivationMetadata({
      existing: existing?.metadata,
      contentHash,
      embeddingStatus: chunks.length > 0 ? "completed" : "not_applicable",
      embeddingModel: embeddingResult?.model ?? existing?.embeddingModel,
      embeddedChunkCount: chunks.length,
      activatedAt,
      sourcePath: entry.path
    });

    await sqlClient.begin(async (transaction) => {
      if (!existing) {
        await transaction.unsafe(
          `
            INSERT INTO knowledge_document (
              id, source_id, external_key, title, description, language,
              mime_type, status, current_version_id, tags, metadata,
              created_at, updated_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, 'draft', NULL, $8::text[],
              $9::jsonb, $10, $10
            )
          `,
          [
            documentId,
            source.id,
            candidate.document.externalKey,
            candidate.document.title,
            candidate.document.description,
            candidate.document.language,
            candidate.document.mimeType,
            candidate.document.tags,
            JSON.stringify(documentMetadata(entry.path, contentHash)),
            activatedAtSql
          ]
        );
      }
      if (!existing?.versionId) {
        await transaction.unsafe(
          `
            INSERT INTO knowledge_version (
              id, document_id, version, content_hash, content,
              citation_metadata, status, parser_version, metadata,
              published_at, created_at, updated_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6::jsonb, 'published',
              'openvac-phase-one-provisional-v1', $7::jsonb, $8, $8, $8
            )
          `,
          [
            versionId,
            documentId,
            versionNumber,
            contentHash,
            content,
            JSON.stringify(candidate.citation),
            JSON.stringify(versionMetadata),
            activatedAtSql
          ]
        );
      } else {
        await transaction.unsafe(
          `
            UPDATE knowledge_version
            SET
              content_hash = $2,
              content = $3,
              citation_metadata = $4::jsonb,
              status = 'published',
              parser_version = 'openvac-phase-one-provisional-v1',
              metadata = $5::jsonb,
              published_at = COALESCE(published_at, $6),
              updated_at = $6
            WHERE id = $1
          `,
          [
            versionId,
            contentHash,
            content,
            JSON.stringify(candidate.citation),
            JSON.stringify(versionMetadata),
            activatedAtSql
          ]
        );
      }

      if (!canReuseEmbeddings) {
        await transaction.unsafe(
          "DELETE FROM knowledge_chunk WHERE version_id = $1",
          [versionId]
        );
        for (const [index, chunk] of chunks.entries()) {
          const vector = embeddingResult?.vectors[index];
          if (!vector || !embeddingResult) {
            throw new Error(
              `Missing embedding ${index} for ${candidate.document.externalKey}.`
            );
          }
          await transaction.unsafe(
            `
            INSERT INTO knowledge_chunk (
              id, version_id, chunk_index, content, page_start, page_end,
              section_path, metadata, embedding, embedding_model,
              embedded_at, created_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7::text[], $8::jsonb,
              $9::vector(1024), $10, $11, $11
            )
            `,
            [
              randomUUID(),
              versionId,
              index,
              chunk.content,
              chunk.pageStart ?? null,
              chunk.pageEnd ?? null,
              chunk.sectionPath,
              JSON.stringify(chunk.metadata),
              `[${vector.join(",")}]`,
              embeddingResult.model,
              activatedAtSql
            ]
          );
        }
      }

      await transaction.unsafe(
        `
          UPDATE knowledge_document
          SET
            source_id = $2,
            title = $3,
            description = $4,
            language = $5,
            mime_type = $6,
            status = 'published',
            current_version_id = $7,
            tags = $8::text[],
            metadata = metadata || $9::jsonb,
            updated_at = $10
          WHERE id = $1
        `,
        [
          documentId,
          source.id,
          candidate.document.title,
          candidate.document.description,
          candidate.document.language,
          candidate.document.mimeType,
          versionId,
          candidate.document.tags,
          JSON.stringify(documentMetadata(entry.path, contentHash)),
          activatedAtSql
        ]
      );
    });

    results.push({
      key: candidate.document.externalKey,
      mode: candidate.citation.ingestionMode,
      chunks: chunks.length,
      reviewStatus: versionMetadata.reviewStatus,
      embeddings:
        chunks.length === 0
          ? "not_applicable"
          : canReuseEmbeddings
            ? "reused"
            : "written",
      contentHash
    });
  }

  const archivedLegacyDocuments = await archiveLegacyKnowledgeDocuments();

  console.log(
    JSON.stringify(
      {
        activatedAt: activatedAt.toISOString(),
        documents: results.length,
        chunks: results.reduce((sum, result) => sum + result.chunks, 0),
        archivedLegacyDocuments,
        results
      },
      null,
      2
    )
  );
} finally {
  await sqlClient.end({ timeout: 5 });
}

async function archiveLegacyKnowledgeDocuments(): Promise<string[]> {
  const archived: string[] = [];
  for (const replacement of legacyKnowledgeReplacements) {
    const didArchive = await sqlClient.begin(async (transaction) => {
      const activeReplacement = await transaction.unsafe(
        `
          SELECT 1
          FROM knowledge_document kd
          JOIN knowledge_version kv ON kv.id = kd.current_version_id
          WHERE kd.external_key = $1
            AND kd.status = 'published'
            AND kv.status = 'published'
            AND kv.metadata->>'retrievalStatus' IN (
              'active_pending_review',
              'active_reviewed'
            )
            AND kv.metadata->>'retrievalContentHash' = kv.content_hash
          LIMIT 1
        `,
        [replacement.replacementExternalKey]
      );
      if (activeReplacement.length === 0) {
        throw new Error(
          `Refusing to archive ${replacement.legacyExternalKey} before ${replacement.replacementExternalKey} is active.`
        );
      }

      await transaction.unsafe(
        `
          UPDATE knowledge_version kv
          SET status = 'archived', updated_at = $2
          FROM knowledge_document kd
          WHERE kd.current_version_id = kv.id
            AND kd.external_key = $1
            AND kd.status = 'published'
            AND kv.status = 'published'
        `,
        [replacement.legacyExternalKey, activatedAtSql]
      );
      const archivedDocuments = await transaction.unsafe(
        `
          UPDATE knowledge_document
          SET status = 'archived', updated_at = $2
          WHERE external_key = $1
            AND status = 'published'
          RETURNING id
        `,
        [replacement.legacyExternalKey, activatedAtSql]
      );
      return archivedDocuments.length > 0;
    });
    if (didArchive) archived.push(replacement.legacyExternalKey);
  }
  return archived;
}

async function loadAuthorizedSource(
  canonicalUrl: string,
  citationMetadata: Record<string, unknown>
): Promise<{
  id: string;
  sourceTier: KnowledgeSourceTier;
}> {
  const rows = await sqlClient.unsafe(
    `
      SELECT id, source_tier, enabled, deleted_at, canonical_url, publisher, metadata
      FROM knowledge_source
      WHERE canonical_url = $1
      LIMIT 1
    `,
    [canonicalUrl]
  );
  const row = rows[0];
  if (
    !row ||
    typeof row.id !== "string" ||
    !isKnowledgeSourceTier(row.source_tier)
  ) {
    throw new Error(
      `Missing governed source for ${canonicalUrl}; run pnpm knowledge:seed first.`
    );
  }
  assertKnowledgeSourceAuthorized(
    {
      sourceTier: row.source_tier,
      enabled: row.enabled === true,
      deletedAt:
        row.deleted_at instanceof Date || typeof row.deleted_at === "string"
          ? row.deleted_at
          : null,
      canonicalUrl:
        typeof row.canonical_url === "string" ? row.canonical_url : null,
      publisher: typeof row.publisher === "string" ? row.publisher : null,
      metadata: recordValue(row.metadata)
    },
    citationMetadata
  );
  return { id: row.id, sourceTier: row.source_tier };
}

async function loadExistingDocument(
  sourceId: string,
  externalKey: string
): Promise<ExistingDocument | undefined> {
  const rows = await sqlClient.unsafe(
    `
      SELECT
        kd.id AS document_id,
        kd.status AS document_status,
        kv.id AS version_id,
        kv.version AS version_number,
        kv.status AS version_status,
        kv.content_hash,
        kv.metadata,
        (
          SELECT count(*)::integer
          FROM knowledge_chunk kc
          WHERE kc.version_id = kv.id
        ) AS chunk_count,
        (
          SELECT count(*)::integer
          FROM knowledge_chunk kc
          WHERE kc.version_id = kv.id
            AND kc.embedding IS NOT NULL
            AND kc.embedded_at IS NOT NULL
        ) AS embedded_chunk_count,
        (
          SELECT min(kc.embedding_model)
          FROM knowledge_chunk kc
          WHERE kc.version_id = kv.id
            AND kc.embedding_model IS NOT NULL
        ) AS embedding_model
      FROM knowledge_document kd
      LEFT JOIN knowledge_version kv ON kv.id = kd.current_version_id
      WHERE kd.source_id = $1 AND kd.external_key = $2
      LIMIT 1
    `,
    [sourceId, externalKey]
  );
  const row = rows[0];
  if (!row || typeof row.document_id !== "string") return undefined;
  return {
    documentId: row.document_id,
    documentStatus: String(row.document_status),
    versionId: typeof row.version_id === "string" ? row.version_id : null,
    versionNumber:
      typeof row.version_number === "number" ? row.version_number : null,
    versionStatus:
      typeof row.version_status === "string" ? row.version_status : null,
    contentHash: typeof row.content_hash === "string" ? row.content_hash : null,
    metadata: recordValue(row.metadata),
    chunkCount: numericValue(row.chunk_count),
    embeddedChunkCount: numericValue(row.embedded_chunk_count),
    embeddingModel:
      typeof row.embedding_model === "string" ? row.embedding_model : undefined
  };
}

function documentMetadata(sourcePath: string, contentHash: string) {
  return {
    curationStatus: "ai_assisted_pending_human_review",
    sourceCandidatePath: sourcePath,
    provisionalRetrievalEnabled: true,
    retrievalContentHash: contentHash,
    humanTechnicalReviewRequired: true
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numericValue(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
