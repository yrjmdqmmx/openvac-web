import type { GroundingEvidence } from "@/server/agent";

const MAX_PUBLICATION_NUMBERS = 4;
const EXPLICIT_PATENT_PUBLICATION_NUMBER =
  /(?<![A-Z0-9])(?:US[\s-]*\d{7,8}[\s-]*[A-Z]\d|CN[\s-]*\d{9}[\s-]*[A-Z])(?![A-Z0-9])/gu;

export type MetadataReferenceSqlExecutor = (
  query: string,
  parameters: readonly unknown[]
) => Promise<Array<Record<string, unknown>>>;

/**
 * This query is deliberately separate from chunk retrieval. Patent records are
 * metadata-only references: they may be cited only when the user supplied the
 * exact publication number, and must never enter lexical/vector retrieval.
 */
export const POSTGRES_PATENT_METADATA_REFERENCE_SQL = `
SELECT
  kd.id AS document_id,
  kv.id AS version_id,
  kd.title,
  kv.content,
  ks.id AS source_id,
  ks.publisher,
  ks.canonical_url,
  kv.citation_metadata,
  upper(kv.citation_metadata ->> 'publicationNumber') AS publication_number
FROM knowledge_version kv
JOIN knowledge_document kd ON kd.id = kv.document_id
JOIN knowledge_source ks ON ks.id = kd.source_id
WHERE upper(kv.citation_metadata ->> 'publicationNumber') = ANY($1::text[])
  AND kv.status = 'published'
  AND kd.status = 'published'
  AND kd.current_version_id = kv.id
  AND kv.citation_metadata ->> 'ingestionMode' = 'metadata_only'
  AND kv.citation_metadata ->> 'licenseClass' = 'metadata_only'
  AND kv.citation_metadata ->> 'evidenceLevel' = 'patentee_disclosure'
  AND kv.citation_metadata ->> 'independentPerformanceValidation' = 'false'
  AND char_length(btrim(kv.citation_metadata ->> 'summaryAuthorship')) > 0
  AND char_length(btrim(kv.citation_metadata ->> 'legalStatusDisclaimer')) > 0
  AND CASE
    WHEN jsonb_typeof(kv.citation_metadata -> 'claimLocators') = 'array'
      THEN jsonb_array_length(kv.citation_metadata -> 'claimLocators') > 0
    ELSE FALSE
  END
  AND CASE
    WHEN jsonb_typeof(kv.citation_metadata -> 'figureLocators') = 'array'
      THEN jsonb_array_length(kv.citation_metadata -> 'figureLocators') > 0
    ELSE FALSE
  END
  AND CASE
    WHEN jsonb_typeof(kv.citation_metadata -> 'technicalUseWarnings') = 'array'
      THEN jsonb_array_length(kv.citation_metadata -> 'technicalUseWarnings') >= 2
    ELSE FALSE
  END
  AND kv.metadata ->> 'reviewStatus' = 'approved'
  AND kv.metadata #>> '{review,status}' = 'approved'
  AND ks.kind = 'patent'
  AND ks.source_tier = 'metadata_only'
  AND kd.mime_type LIKE '%patent-metadata%'
  AND ks.enabled = TRUE
  AND ks.deleted_at IS NULL
  AND ks.canonical_url ~ '^https://[^/?#[:space:]@]+([/?#]|$)'
  AND btrim(ks.publisher) <> ''
  AND ks.metadata #>> '{rightsDecision,status}' = 'approved'
  AND ks.metadata #>> '{rightsDecision,scope}' = 'metadata_only'
  AND ks.metadata #>> '{rightsDecision,appliesToRecordUrl}' = ks.canonical_url
  AND char_length(btrim(kv.content)) BETWEEN 40 AND 6000
ORDER BY array_position($1::text[], upper(kv.citation_metadata ->> 'publicationNumber')),
  kd.id
LIMIT 4
`.trim();

export function extractPatentPublicationNumbers(question: string): string[] {
  const normalized = question.normalize("NFKC").toUpperCase();
  const publicationNumbers: string[] = [];

  for (const match of normalized.matchAll(EXPLICIT_PATENT_PUBLICATION_NUMBER)) {
    const publicationNumber = match[0].replace(/[\s-]+/gu, "");
    if (!publicationNumbers.includes(publicationNumber)) {
      publicationNumbers.push(publicationNumber);
    }
    if (publicationNumbers.length >= MAX_PUBLICATION_NUMBERS) break;
  }

  return publicationNumbers;
}

export async function retrievePatentMetadataReferences(
  question: string,
  execute: MetadataReferenceSqlExecutor
): Promise<GroundingEvidence[]> {
  const publicationNumbers = extractPatentPublicationNumbers(question);
  if (publicationNumbers.length === 0) return [];

  const requested = new Set(publicationNumbers);
  const rows = await execute(POSTGRES_PATENT_METADATA_REFERENCE_SQL, [
    publicationNumbers
  ]);

  return rows.flatMap((row) => {
    const evidence = mapMetadataReferenceRow(row, requested);
    return evidence ? [evidence] : [];
  });
}

function mapMetadataReferenceRow(
  row: Record<string, unknown>,
  requested: ReadonlySet<string>
): GroundingEvidence | undefined {
  const publicationNumber = requiredString(
    row.publication_number
  )?.toUpperCase();
  const sourceId = requiredString(row.source_id);
  const versionId = requiredString(row.version_id);
  const title = requiredString(row.title);
  const content = requiredString(row.content);
  const publisher = requiredString(row.publisher);
  const url = requiredHttpsUrl(row.canonical_url);
  const citationMetadata = objectValue(row.citation_metadata);
  const fetchedAt = validDateString(
    citationMetadata?.bibliographicVerifiedAt ?? citationMetadata?.fetchedAt
  );

  if (
    !publicationNumber ||
    !requested.has(publicationNumber) ||
    !sourceId ||
    !versionId ||
    !title ||
    !content ||
    !publisher ||
    !url ||
    !fetchedAt
  ) {
    return undefined;
  }

  return {
    citation: {
      sourceId: `${sourceId}:metadata:${versionId}`,
      title,
      publisher,
      url,
      pageOrSection: `专利公开号 ${publicationNumber}（元数据摘要）`,
      fetchedAt,
      licenseClass: "metadata_only"
    },
    excerpt: content
  };
}

function requiredString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function requiredHttpsUrl(value: unknown): string | undefined {
  const raw = requiredString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function validDateString(value: unknown): string | undefined {
  const raw = requiredString(value);
  if (!raw || Number.isNaN(Date.parse(raw))) return undefined;
  return raw;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
