import { sqlClient } from "../src/server/db";

type CountRow = { count: string | number };

async function count(query: string): Promise<number> {
  const rows = await sqlClient.unsafe<CountRow[]>(query);
  return Number(rows[0]?.count ?? 0);
}

try {
  const [
    patentSources,
    patentDocuments,
    patentChunks,
    patentEmbeddings,
    publishedChunksWithoutSource,
    restrictedPublishedChunks
  ] = await Promise.all([
    count(`
      SELECT COUNT(*) AS count
      FROM knowledge_source
      WHERE kind = 'patent'
        AND source_tier = 'metadata_only'
        AND enabled = TRUE
        AND deleted_at IS NULL
    `),
    count(`
      SELECT COUNT(*) AS count
      FROM knowledge_document kd
      JOIN knowledge_source ks ON ks.id = kd.source_id
      WHERE ks.kind = 'patent'
    `),
    count(`
      SELECT COUNT(*) AS count
      FROM knowledge_chunk kc
      JOIN knowledge_version kv ON kv.id = kc.version_id
      JOIN knowledge_document kd ON kd.id = kv.document_id
      JOIN knowledge_source ks ON ks.id = kd.source_id
      WHERE ks.kind = 'patent'
    `),
    count(`
      SELECT COUNT(*) AS count
      FROM knowledge_chunk kc
      JOIN knowledge_version kv ON kv.id = kc.version_id
      JOIN knowledge_document kd ON kd.id = kv.document_id
      JOIN knowledge_source ks ON ks.id = kd.source_id
      WHERE ks.kind = 'patent'
        AND kc.embedding IS NOT NULL
    `),
    count(`
      SELECT COUNT(*) AS count
      FROM knowledge_chunk kc
      JOIN knowledge_version kv ON kv.id = kc.version_id
      JOIN knowledge_document kd ON kd.id = kv.document_id
      LEFT JOIN knowledge_source ks ON ks.id = kd.source_id
      WHERE kv.status = 'published'
        AND kd.status = 'published'
        AND (ks.id IS NULL OR ks.deleted_at IS NOT NULL OR ks.enabled = FALSE)
    `),
    count(`
      SELECT COUNT(*) AS count
      FROM knowledge_chunk kc
      JOIN knowledge_version kv ON kv.id = kc.version_id
      JOIN knowledge_document kd ON kd.id = kv.document_id
      JOIN knowledge_source ks ON ks.id = kd.source_id
      WHERE kv.status = 'published'
        AND kd.status = 'published'
        AND (
          ks.source_tier IN ('metadata_only', 'manufacturer_metadata', 'standard_metadata')
          OR (
            ks.source_tier = 'open_license'
            AND NOT (
              ks.metadata -> 'rightsDecision' ->> 'status' = 'approved'
              AND ks.metadata -> 'rightsDecision' ->> 'scope' = 'full_text'
              AND ks.metadata -> 'rightsDecision' ->> 'appliesToRecordUrl' = ks.canonical_url
            )
          )
          OR (
            ks.source_tier = 'internal'
            AND NOT COALESCE((ks.metadata ->> 'commercialAiRightsConfirmed')::boolean, FALSE)
          )
        )
    `)
  ]);

  const report = {
    patentSources,
    patentDocuments,
    patentChunks,
    patentEmbeddings,
    publishedChunksWithoutSource,
    restrictedPublishedChunks
  };
  console.log(JSON.stringify(report, null, 2));

  if (
    patentSources < 2 ||
    patentDocuments < 2 ||
    patentChunks !== 0 ||
    patentEmbeddings !== 0 ||
    publishedChunksWithoutSource !== 0 ||
    restrictedPublishedChunks !== 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await sqlClient.end({ timeout: 5 });
}
