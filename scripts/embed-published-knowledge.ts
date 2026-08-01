import { sqlClient } from "../src/server/db";
import {
  assertValidKnowledgeEmbeddings,
  isPublishedEmbeddingCandidate,
  type PublishedEmbeddingCandidate
} from "../src/server/knowledge/published-embedding";
import { getEmbeddingProvider } from "../src/server/providers";

type SqlRow = Record<string, unknown>;

const requestedLimit = Number(
  process.argv
    .find((argument) => argument.startsWith("--limit="))
    ?.slice("--limit=".length) ?? 500
);

if (
  !Number.isInteger(requestedLimit) ||
  requestedLimit < 1 ||
  requestedLimit > 5_000
) {
  throw new Error("--limit must be an integer from 1 to 5000.");
}

try {
  const rows = await sqlClient.unsafe(
    `
      SELECT
        kc.id AS chunk_id,
        kc.version_id,
        kc.content,
        ks.source_tier,
        ks.metadata AS source_metadata,
        kv.metadata AS version_metadata,
        kv.citation_metadata
      FROM knowledge_chunk kc
      JOIN knowledge_version kv ON kv.id = kc.version_id
      JOIN knowledge_document kd ON kd.id = kv.document_id
      JOIN knowledge_source ks ON ks.id = kd.source_id
      WHERE
        kc.embedding IS NULL
        AND kv.status = 'published'
        AND kd.status = 'published'
        AND kd.current_version_id = kv.id
        AND ks.enabled = TRUE
        AND ks.deleted_at IS NULL
      ORDER BY kv.id, kc.chunk_index
      LIMIT $1
    `,
    [requestedLimit]
  );
  const candidates = rows.map(mapCandidate);
  const eligible = candidates.filter(isPublishedEmbeddingCandidate);
  const skipped = candidates.length - eligible.length;

  if (eligible.length === 0) {
    console.log(
      JSON.stringify(
        { selected: candidates.length, embedded: 0, skipped },
        null,
        2
      )
    );
  } else {
    const embeddings = getEmbeddingProvider();
    const result = await embeddings.embed(
      eligible.map((candidate) => candidate.content)
    );
    assertValidKnowledgeEmbeddings(result, eligible.length);

    await sqlClient.begin(async (transaction) => {
      for (const [index, candidate] of eligible.entries()) {
        const vector = result.vectors[index];
        const updated = await transaction.unsafe(
          `
            UPDATE knowledge_chunk kc
            SET
              embedding = $2::vector(1024),
              embedding_model = $3,
              embedded_at = NOW()
            FROM knowledge_version kv, knowledge_document kd, knowledge_source ks
            WHERE
              kc.id = $1
              AND kc.version_id = $4
              AND kc.embedding IS NULL
              AND kv.id = kc.version_id
              AND kv.status = 'published'
              AND kd.id = kv.document_id
              AND kd.status = 'published'
              AND kd.current_version_id = kv.id
              AND ks.id = kd.source_id
              AND ks.enabled = TRUE
              AND ks.deleted_at IS NULL
              AND kv.citation_metadata ->> 'ingestionMode' = 'full_text'
              AND kv.metadata ->> 'reviewStatus' = 'approved'
              AND (
                (
                  ks.source_tier = 'open_license'
                  AND ks.metadata ->> 'rightsReviewed' = 'true'
                )
                OR (
                  ks.source_tier = 'internal'
                  AND ks.metadata ->> 'commercialAiRightsConfirmed' = 'true'
                )
              )
            RETURNING kc.id
          `,
          [
            candidate.chunkId,
            `[${vector?.join(",")}]`,
            result.model,
            candidate.versionId
          ]
        );
        if (updated.length !== 1) {
          throw new Error(
            `Knowledge chunk ${candidate.chunkId} changed during embedding backfill.`
          );
        }
      }

      for (const versionId of new Set(
        eligible.map((candidate) => candidate.versionId)
      )) {
        await transaction.unsafe(
          `
            UPDATE knowledge_version kv
            SET
              metadata = kv.metadata || jsonb_build_object(
                'embeddingStatus', CASE
                  WHEN EXISTS (
                    SELECT 1
                    FROM knowledge_chunk pending
                    WHERE pending.version_id = kv.id
                      AND pending.embedding IS NULL
                  ) THEN 'partial'
                  ELSE 'completed'
                END,
                'embeddingModel', $2::text,
                'embeddedChunkCount', (
                  SELECT COUNT(*)::int
                  FROM knowledge_chunk kc
                  WHERE kc.version_id = kv.id AND kc.embedding IS NOT NULL
                )
              ),
              updated_at = NOW()
            WHERE kv.id = $1 AND kv.status = 'published'
          `,
          [versionId, result.model]
        );
      }
    });

    console.log(
      JSON.stringify(
        {
          selected: candidates.length,
          embedded: eligible.length,
          skipped,
          model: result.model,
          dimensions: result.dimensions
        },
        null,
        2
      )
    );
  }
} finally {
  await sqlClient.end({ timeout: 5 });
}

function mapCandidate(row: SqlRow): PublishedEmbeddingCandidate {
  return {
    chunkId: requiredString(row.chunk_id, "chunk_id"),
    versionId: requiredString(row.version_id, "version_id"),
    content: requiredString(row.content, "content"),
    sourceTier: requiredString(row.source_tier, "source_tier"),
    sourceMetadata: recordValue(row.source_metadata),
    versionMetadata: recordValue(row.version_metadata),
    citationMetadata: recordValue(row.citation_metadata)
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Embedding candidate is missing ${label}.`);
  }
  return value;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}
