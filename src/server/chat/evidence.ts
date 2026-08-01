import { sqlClient } from "@/server/db";
import { type GroundingEvidence, type Citation } from "@/server/agent";
import {
  HybridRetriever,
  PostgresHybridRetrievalRepository,
  type RetrievalCandidate
} from "@/server/knowledge/retrieval";
import {
  extractLexicalTerms,
  POSTGRES_LEXICAL_RETRIEVAL_SQL
} from "@/server/knowledge/lexical";
import { retrievePatentMetadataReferences } from "@/server/knowledge/metadata-reference";
import { SafeWebFetcher } from "@/server/knowledge/web-fetch";
import { getEmbeddingProvider, getWebSearchProvider } from "@/server/providers";
import {
  commitQuota,
  QuotaExceededError,
  releaseQuota,
  reserveWebSearchQuota
} from "@/server/quota";

const TIME_SENSITIVE =
  /(?:最新|目前|现在|当前|价格|库存|停产|在售|新型号|新版|更新|公告)/u;

type EvidenceResult = {
  evidence: GroundingEvidence[];
  webSearched: boolean;
  retrievalMode: "hybrid" | "lexical" | "none";
};

export async function collectEvidence(input: {
  question: string;
  userId: string;
  clientRequestId: string;
  signal?: AbortSignal;
  onStage?: (label: string) => void;
}): Promise<EvidenceResult> {
  input.onStage?.("正在检索已审核知识…");
  const patentReferences = await retrievePatentMetadataReferences(
    input.question,
    async (query, parameters) => {
      const rows = await sqlClient.unsafe(query, parameters as never[]);
      return [...rows] as Array<Record<string, unknown>>;
    }
  ).catch(() => []);
  const local = await retrieveLocal(input.question);
  const localEvidence = deduplicateEvidence([
    ...patentReferences.map((evidence) =>
      sanitizeGroundingEvidence(evidence, 2_200)
    ),
    ...local.candidates
      .filter((candidate) => candidate.citation)
      .slice(0, 6)
      .map((candidate) =>
        sanitizeGroundingEvidence(
          {
            citation: candidate.citation!,
            excerpt: candidate.content
          },
          2_200
        )
      )
  ]).slice(0, 6);

  const insufficient =
    (patentReferences.length === 0 &&
      (localEvidence.length < 2 ||
        (local.candidates[0]?.score ?? 0) < 0.016)) ||
    TIME_SENSITIVE.test(input.question);

  if (!insufficient || process.env.ALIBABA_WEB_SEARCH_ENABLED !== "true") {
    return {
      evidence: localEvidence,
      webSearched: false,
      retrievalMode: local.mode
    };
  }

  input.onStage?.("本地证据不足，正在检索权威站点…");
  let leaseId: string | undefined;
  let searchQuotaCommitted = false;
  try {
    const reservation = await reserveWebSearchQuota({
      userId: input.userId,
      clientRequestId: `${input.clientRequestId}:web`,
      metadata: { reason: "local_evidence_insufficient" }
    });
    leaseId = reservation.leaseId;
    if (reservation.idempotent || reservation.status !== "reserved") {
      return {
        evidence: localEvidence,
        webSearched: false,
        retrievalMode: local.mode
      };
    }

    // A search reservation measures an outbound paid attempt. Commit before
    // handing control to the provider so downstream failures cannot be used
    // to recycle the same global paid-search budget.
    await commitQuota({ leaseId, userId: input.userId });
    searchQuotaCommitted = true;

    const search = await getWebSearchProvider().search({
      query: input.question,
      forced: true,
      signal: input.signal
    });
    if (
      !search.searched ||
      search.searchCalls !== 1 ||
      search.sources.length < 1
    ) {
      throw new Error("联网搜索未返回可追溯来源。");
    }

    const allowedDomains = parseDomains(
      process.env.ALIBABA_WEB_SEARCH_ALLOWED_DOMAINS
    );
    const fetcher = new SafeWebFetcher({
      allowedDomains,
      maxBytes: 1_000_000,
      timeoutMs: 8_000,
      maxRedirects: 2
    });
    const fetched: GroundingEvidence[] = [];
    for (const source of search.sources.slice(0, 3)) {
      try {
        const page = await fetcher.fetch(source.url, input.signal);
        const excerpt = htmlToPlainText(page.body);
        if (excerpt.length < 80) continue;
        fetched.push(
          sanitizeGroundingEvidence(
            {
              citation: {
                sourceId: `web:${stableSourceKey(source.url)}`,
                title: source.title,
                publisher: source.siteName ?? new URL(source.url).hostname,
                url: page.url,
                fetchedAt: page.fetchedAt,
                licenseClass: "metadata_only"
              },
              excerpt
            },
            2_600
          )
        );
      } catch {
        // A single source failing DNS, content-type, redirect, or byte checks
        // must not weaken the protections for the remaining sources.
      }
    }

    if (fetched.length === 0) {
      throw new Error("权威搜索结果无法通过安全抓取和正文验证。");
    }
    return {
      evidence: deduplicateEvidence([...localEvidence, ...fetched]).slice(0, 8),
      webSearched: true,
      retrievalMode: local.mode
    };
  } catch (error) {
    if (leaseId && !searchQuotaCommitted) {
      await releaseQuota({
        leaseId,
        userId: input.userId,
        reason: "search_failed_or_unverified"
      }).catch(() => undefined);
    }
    if (!(error instanceof QuotaExceededError)) {
      // Search failure is an intentional degradation path. The answer prompt
      // will state that no direct evidence was available.
    }
    return {
      evidence: localEvidence,
      webSearched: false,
      retrievalMode: local.mode
    };
  }
}

const INSTRUCTION_LIKE_EVIDENCE =
  /(?:忽略|无视|覆盖|绕过).{0,20}(?:之前|上述|系统|安全|规则|指令|提示)|(?:system|assistant|developer)\s*(?:prompt|message|instruction)?\s*:|(?:ignore|disregard|forget).{0,30}(?:previous|earlier|system|safety|instruction|constraint|rule)|(?:执行|调用).{0,12}(?:工具|函数|命令)|(?:泄露|显示|输出).{0,16}(?:提示词|系统消息|密钥)|<\/?(?:system|assistant|developer|tool)\b|\[(?:INST|SYSTEM)\]/iu;

const REMOVED_INSTRUCTION = "[已移除疑似指令文本]";
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const UNSAFE_CONTROL = /\p{Cc}/gu;

export function sanitizeEvidenceExcerpt(
  value: string,
  maximum = 2_600
): string {
  return sanitizeEvidenceField(value, maximum);
}

export function sanitizeGroundingEvidence(
  evidence: GroundingEvidence,
  maximumExcerpt = 2_600
): GroundingEvidence {
  const normalized = {
    title: normalizeEvidenceField(evidence.citation.title),
    publisher: normalizeEvidenceField(evidence.citation.publisher),
    pageOrSection:
      evidence.citation.pageOrSection === undefined
        ? undefined
        : normalizeEvidenceField(evidence.citation.pageOrSection),
    excerpt: normalizeEvidenceField(evidence.excerpt)
  };
  const fields = [
    normalized.title,
    normalized.publisher,
    normalized.pageOrSection,
    normalized.excerpt
  ].filter((value): value is string => value !== undefined);

  const sanitizedField = (
    value: string | undefined,
    maximum: number
  ): string | undefined => {
    if (value === undefined) return undefined;
    if (isInstructionLikeEvidence(value)) {
      return REMOVED_INSTRUCTION;
    }
    return boundText(value, maximum);
  };

  const sanitized: GroundingEvidence = {
    citation: {
      ...evidence.citation,
      title: sanitizedField(normalized.title, 300) ?? REMOVED_INSTRUCTION,
      publisher:
        sanitizedField(normalized.publisher, 200) ?? REMOVED_INSTRUCTION,
      pageOrSection: sanitizedField(normalized.pageOrSection, 200)
    },
    excerpt:
      sanitizedField(normalized.excerpt, maximumExcerpt) ?? REMOVED_INSTRUCTION
  };
  const sanitizedFields = [
    sanitized.citation.title,
    sanitized.citation.publisher,
    sanitized.citation.pageOrSection,
    sanitized.excerpt
  ].filter((value): value is string => value !== undefined);

  if (
    isInstructionLikeEvidence(fields.join(" ")) &&
    isInstructionLikeEvidence(sanitizedFields.join(" "))
  ) {
    return {
      citation: {
        ...sanitized.citation,
        title: REMOVED_INSTRUCTION,
        publisher: REMOVED_INSTRUCTION,
        pageOrSection:
          sanitized.citation.pageOrSection === undefined
            ? undefined
            : REMOVED_INSTRUCTION
      },
      excerpt: REMOVED_INSTRUCTION
    };
  }

  return sanitized;
}

function sanitizeEvidenceField(value: string, maximum: number): string {
  const normalized = normalizeEvidenceField(value);
  return isInstructionLikeEvidence(normalized)
    ? REMOVED_INSTRUCTION
    : boundText(normalized, maximum);
}

function normalizeEvidenceField(value: string): string {
  return value
    .normalize("NFKC")
    .replace(DEFAULT_IGNORABLE, "")
    .replace(UNSAFE_CONTROL, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isInstructionLikeEvidence(value: string): boolean {
  return (
    INSTRUCTION_LIKE_EVIDENCE.test(value) ||
    INSTRUCTION_LIKE_EVIDENCE.test(value.replace(/\s+/gu, ""))
  );
}

async function retrieveLocal(question: string): Promise<{
  candidates: RetrievalCandidate[];
  mode: "hybrid" | "lexical" | "none";
}> {
  try {
    const repository = new PostgresHybridRetrievalRepository(
      async (query, parameters) => {
        const rows = await sqlClient.unsafe(query, parameters as never[]);
        return [...rows] as Array<Record<string, unknown>>;
      }
    );
    const retriever = new HybridRetriever({
      embeddings: getEmbeddingProvider(),
      repository
    });
    const candidates = await retriever.retrieve(question, {
      limit: 8,
      candidateLimit: 50,
      minimumScore: 0.01
    });
    return { candidates, mode: "hybrid" };
  } catch {
    try {
      return {
        candidates: await lexicalFallback(question),
        mode: "lexical"
      };
    } catch {
      return { candidates: [], mode: "none" };
    }
  }
}

async function lexicalFallback(
  question: string
): Promise<RetrievalCandidate[]> {
  const terms = extractLexicalTerms(question);
  if (terms.length === 0) return [];
  const rows = await sqlClient.unsafe(POSTGRES_LEXICAL_RETRIEVAL_SQL, [terms]);

  return [...rows].map((row) => {
    const record = row as Record<string, unknown>;
    const pageStart =
      typeof record.page_start === "number" ? record.page_start : undefined;
    const pageEnd =
      typeof record.page_end === "number" ? record.page_end : undefined;
    const sourceId =
      typeof record.source_id === "string" ? record.source_id : undefined;
    const chunkId = String(record.chunk_id);
    const url =
      typeof record.canonical_url === "string"
        ? record.canonical_url
        : undefined;
    const sourceTier =
      typeof record.source_tier === "string" ? record.source_tier : undefined;
    const citation: Citation | undefined =
      sourceId && url
        ? {
            sourceId: `${sourceId}:chunk:${chunkId}`,
            title: String(record.title),
            publisher: String(record.publisher || "来源发布者未标注"),
            url,
            pageOrSection:
              pageStart == null
                ? undefined
                : pageEnd && pageEnd !== pageStart
                  ? `第 ${pageStart}-${pageEnd} 页`
                  : `第 ${pageStart} 页`,
            fetchedAt: citationFetchedAt(record.citation_metadata),
            licenseClass:
              sourceTier === "open_license"
                ? "open"
                : sourceTier === "internal"
                  ? "private_authorized"
                  : "metadata_only"
          }
        : undefined;

    return {
      chunkId,
      documentId: String(record.document_id),
      versionId: String(record.version_id),
      title: String(record.title),
      content: String(record.content),
      pageStart,
      pageEnd,
      sectionPath: Array.isArray(record.section_path)
        ? (record.section_path as string[])
        : [],
      score: Number(record.score || 0),
      lexicalRank: undefined,
      citation
    };
  });
}

function citationFetchedAt(value: unknown): string | Date {
  if (typeof value !== "object" || value === null) return new Date(0);
  const fetchedAt = (value as Record<string, unknown>).fetchedAt;
  return typeof fetchedAt === "string" ? fetchedAt : new Date(0);
}

function parseDomains(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

function deduplicateEvidence(evidence: GroundingEvidence[]) {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    if (seen.has(item.citation.sourceId)) return false;
    seen.add(item.citation.sourceId);
    return true;
  });
}

function boundText(value: string, maximum: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum)}…`;
}

function htmlToPlainText(value: string) {
  return boundText(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu, " ")
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/&nbsp;/giu, " ")
      .replace(/&amp;/giu, "&")
      .replace(/&lt;/giu, "<")
      .replace(/&gt;/giu, ">")
      .replace(/&quot;/giu, '"')
      .replace(/&#39;/giu, "'"),
    12_000
  );
}

function stableSourceKey(url: string) {
  let hash = 2166136261;
  for (const char of url) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
