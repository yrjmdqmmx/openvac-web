import type { Citation, LicenseClass } from "../agent/citations";
import type { EmbeddingProvider } from "../providers";
import { ProviderResponseError } from "../providers";

const DEFAULT_RRF_K = 60;
const DEFAULT_CANDIDATE_LIMIT = 40;
const DEFAULT_RESULT_LIMIT = 8;

export interface RankedRetrievalItem<T> {
  item: T;
  rank: number;
}

export interface FusedRetrievalItem<T> {
  item: T;
  score: number;
  vectorRank?: number;
  lexicalRank?: number;
}

export interface RetrievalCandidate {
  chunkId: string;
  documentId: string;
  versionId: string;
  title: string;
  content: string;
  pageStart?: number;
  pageEnd?: number;
  sectionPath: string[];
  score: number;
  vectorRank?: number;
  lexicalRank?: number;
  citation?: Citation;
}

export interface HybridSearchInput {
  query: string;
  embedding: number[];
  limit?: number;
  candidateLimit?: number;
  minimumScore?: number;
}

export interface HybridRetrievalRepository {
  search(input: HybridSearchInput): Promise<RetrievalCandidate[]>;
}

export interface HybridRetrieverOptions {
  embeddings: EmbeddingProvider;
  repository: HybridRetrievalRepository;
}

export class HybridRetriever {
  private readonly embeddings: EmbeddingProvider;
  private readonly repository: HybridRetrievalRepository;

  constructor(options: HybridRetrieverOptions) {
    this.embeddings = options.embeddings;
    this.repository = options.repository;
  }

  async retrieve(
    query: string,
    options: Omit<HybridSearchInput, "query" | "embedding"> = {}
  ): Promise<RetrievalCandidate[]> {
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }
    const result = await this.embeddings.embed([normalized]);
    const embedding = result.vectors[0];
    if (!embedding) {
      throw new ProviderResponseError(
        this.embeddings.id,
        "Embedding provider returned no query vector.",
        { retryable: true }
      );
    }
    return this.repository.search({
      query: normalized,
      embedding,
      ...options
    });
  }
}

export type HybridSqlExecutor = (
  query: string,
  parameters: readonly unknown[]
) => Promise<Array<Record<string, unknown>>>;

export class PostgresHybridRetrievalRepository implements HybridRetrievalRepository {
  private readonly execute: HybridSqlExecutor;

  constructor(execute: HybridSqlExecutor) {
    this.execute = execute;
  }

  async search(input: HybridSearchInput): Promise<RetrievalCandidate[]> {
    const limit = boundedInteger(input.limit, DEFAULT_RESULT_LIMIT, 1, 30);
    const candidateLimit = boundedInteger(
      input.candidateLimit,
      Math.max(DEFAULT_CANDIDATE_LIMIT, limit),
      limit,
      200
    );
    if (input.embedding.length !== 1024) {
      throw new ProviderResponseError(
        "hybrid-retrieval",
        "Hybrid retrieval requires a 1024-dimensional query embedding."
      );
    }
    if (input.embedding.some((value) => !Number.isFinite(value))) {
      throw new ProviderResponseError(
        "hybrid-retrieval",
        "Query embedding contains a non-finite value."
      );
    }

    const rows = await this.execute(POSTGRES_HYBRID_RETRIEVAL_SQL, [
      input.query,
      `[${input.embedding.join(",")}]`,
      candidateLimit,
      limit,
      input.minimumScore ?? 0
    ]);
    return rows.map(mapRetrievalRow);
  }
}

/**
 * Reciprocal-rank fusion keeps vector similarity and PostgreSQL full-text
 * search comparable without assuming their raw scores share a scale.
 *
 * The SQL intentionally searches published document + version pairs only and
 * requires enabled sources. It is designed for the singular table names in
 * OpenVac's Drizzle schema.
 */
export const POSTGRES_HYBRID_RETRIEVAL_SQL = `
WITH query_input AS (
  SELECT
    websearch_to_tsquery('simple', $1::text) AS text_query,
    $2::vector(1024) AS query_embedding
),
eligible AS (
  SELECT
    kc.id,
    kc.version_id,
    kc.content,
    kc.page_start,
    kc.page_end,
    kc.section_path,
    kd.id AS document_id,
    kd.title,
    ks.id AS source_id,
    ks.publisher,
    ks.canonical_url,
    ks.source_tier,
    kv.citation_metadata
  FROM knowledge_chunk kc
  JOIN knowledge_version kv ON kv.id = kc.version_id
  JOIN knowledge_document kd ON kd.id = kv.document_id
  LEFT JOIN knowledge_source ks ON ks.id = kd.source_id
  WHERE
    kc.embedding IS NOT NULL
    AND kv.status = 'published'
    AND kd.status = 'published'
    AND kd.current_version_id = kv.id
    AND (ks.id IS NULL OR (ks.enabled = TRUE AND ks.deleted_at IS NULL))
),
vector_matches AS (
  SELECT
    e.id,
    row_number() OVER (
      ORDER BY kc.embedding <=> qi.query_embedding, e.id
    ) AS vector_rank
  FROM eligible e
  JOIN knowledge_chunk kc ON kc.id = e.id
  CROSS JOIN query_input qi
  ORDER BY kc.embedding <=> qi.query_embedding, e.id
  LIMIT $3
),
lexical_matches AS (
  SELECT
    e.id,
    row_number() OVER (
      ORDER BY
        ts_rank_cd(
          to_tsvector('simple', e.content),
          qi.text_query
        ) DESC,
        e.id
    ) AS lexical_rank
  FROM eligible e
  CROSS JOIN query_input qi
  WHERE
    numnode(qi.text_query) > 0
    AND to_tsvector('simple', e.content) @@ qi.text_query
  ORDER BY
    ts_rank_cd(to_tsvector('simple', e.content), qi.text_query) DESC,
    e.id
  LIMIT $3
),
fused AS (
  SELECT
    COALESCE(v.id, l.id) AS id,
    v.vector_rank,
    l.lexical_rank,
    COALESCE(1.0 / (${DEFAULT_RRF_K} + v.vector_rank), 0.0)
      + COALESCE(1.0 / (${DEFAULT_RRF_K} + l.lexical_rank), 0.0) AS score
  FROM vector_matches v
  FULL OUTER JOIN lexical_matches l ON l.id = v.id
)
SELECT
  e.id AS chunk_id,
  e.document_id,
  e.version_id,
  e.title,
  e.content,
  e.page_start,
  e.page_end,
  e.section_path,
  e.source_id,
  e.publisher,
  e.canonical_url,
  e.source_tier,
  e.citation_metadata,
  f.vector_rank,
  f.lexical_rank,
  f.score
FROM fused f
JOIN eligible e ON e.id = f.id
WHERE f.score >= $5
ORDER BY f.score DESC, e.id
LIMIT $4
`.trim();

export function reciprocalRankFusion<T>(
  vectorResults: RankedRetrievalItem<T>[],
  lexicalResults: RankedRetrievalItem<T>[],
  identify: (item: T) => string,
  k = DEFAULT_RRF_K
): FusedRetrievalItem<T>[] {
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error("RRF k must be a positive finite number.");
  }
  const fused = new Map<string, FusedRetrievalItem<T>>();

  const add = (
    entries: RankedRetrievalItem<T>[],
    kind: "vectorRank" | "lexicalRank"
  ) => {
    for (const entry of entries) {
      if (!Number.isInteger(entry.rank) || entry.rank < 1) {
        throw new Error("Retrieval ranks must be positive integers.");
      }
      const key = identify(entry.item);
      const current = fused.get(key) ?? {
        item: entry.item,
        score: 0
      };
      const previousRank = current[kind];
      if (previousRank === undefined || entry.rank < previousRank) {
        if (previousRank !== undefined) {
          current.score -= 1 / (k + previousRank);
        }
        current[kind] = entry.rank;
        current.score += 1 / (k + entry.rank);
      }
      fused.set(key, current);
    }
  };

  add(vectorResults, "vectorRank");
  add(lexicalResults, "lexicalRank");
  return [...fused.values()].sort(
    (left, right) =>
      right.score - left.score ||
      identify(left.item).localeCompare(identify(right.item))
  );
}

function mapRetrievalRow(row: Record<string, unknown>): RetrievalCandidate {
  const sourceId = stringValue(row.source_id);
  const canonicalUrl = stringValue(row.canonical_url);
  const metadata = recordValue(row.citation_metadata);
  const pageStart = numberValue(row.page_start);
  const pageEnd = numberValue(row.page_end);
  const sectionPath = Array.isArray(row.section_path)
    ? row.section_path.filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  const fetchedAt =
    stringValue(metadata.fetchedAt) ??
    stringValue(metadata.fetched_at) ??
    new Date(0).toISOString();
  const citation =
    sourceId && canonicalUrl
      ? {
          sourceId,
          title: stringValue(row.title) ?? "未命名来源",
          publisher: stringValue(row.publisher) ?? "来源发布者未标注",
          url: canonicalUrl,
          pageOrSection: citationLocation(pageStart, pageEnd, sectionPath),
          fetchedAt,
          licenseClass: mapLicenseClass(stringValue(row.source_tier))
        }
      : undefined;

  return {
    chunkId: requiredRowString(row, "chunk_id"),
    documentId: requiredRowString(row, "document_id"),
    versionId: requiredRowString(row, "version_id"),
    title: requiredRowString(row, "title"),
    content: requiredRowString(row, "content"),
    pageStart,
    pageEnd,
    sectionPath,
    score: numberValue(row.score) ?? 0,
    vectorRank: numberValue(row.vector_rank),
    lexicalRank: numberValue(row.lexical_rank),
    citation
  };
}

function citationLocation(
  pageStart?: number,
  pageEnd?: number,
  sectionPath: string[] = []
): string | undefined {
  const section = sectionPath.join(" > ");
  const pages =
    pageStart === undefined
      ? undefined
      : pageEnd && pageEnd !== pageStart
        ? `第 ${pageStart}-${pageEnd} 页`
        : `第 ${pageStart} 页`;
  return [section, pages].filter(Boolean).join("；") || undefined;
}

function mapLicenseClass(value?: string): LicenseClass {
  switch (value) {
    case "open_license":
      return "open";
    case "manufacturer_metadata":
    case "standard_metadata":
      return "metadata_only";
    case "internal":
      return "private_authorized";
    default:
      return "unknown";
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value)) {
    throw new Error("Retrieval limits must be integers.");
  }
  return Math.max(minimum, Math.min(maximum, value));
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredRowString(row: Record<string, unknown>, key: string): string {
  const value = stringValue(row[key]);
  if (!value) {
    throw new Error(`Hybrid retrieval row is missing ${key}.`);
  }
  return value;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
