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
import { getEmbeddingProvider } from "@/server/providers";
const DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS = 8_000;
const MAX_QUERY_EMBEDDING_TIMEOUT_MS = 15_000;

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
  input.onStage?.("正在检索 OpenVac 知识库…");
  const localResult = await collectLocalEvidence(input.question, input.signal);
  return {
    evidence: localResult.evidence,
    webSearched: false,
    retrievalMode: localResult.local.mode
  };
}

export async function collectLocalEvidence(
  question: string,
  signal?: AbortSignal
): Promise<{
  evidence: GroundingEvidence[];
  patentReferences: number;
  local: {
    mode: "hybrid" | "lexical" | "none";
    bestScore: number;
  };
}> {
  const patentReferences = await retrievePatentMetadataReferences(
    question,
    async (query, parameters) => {
      const rows = await sqlClient.unsafe(query, parameters as never[]);
      return [...rows] as Array<Record<string, unknown>>;
    }
  ).catch(() => []);
  const local = await retrieveLocal(question, signal);
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

  return {
    evidence: localEvidence,
    patentReferences: patentReferences.length,
    local: {
      mode: local.mode,
      bestScore: local.candidates[0]?.score ?? 0
    }
  };
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

async function retrieveLocal(
  question: string,
  signal?: AbortSignal
): Promise<{
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
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () =>
        timeoutController.abort(
          new DOMException("Query embedding timed out.", "TimeoutError")
        ),
      queryEmbeddingTimeoutMs()
    );
    const embeddingSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    let candidates: RetrievalCandidate[];
    try {
      candidates = await retriever.retrieve(
        question,
        {
          limit: 8,
          candidateLimit: 50,
          minimumScore: 0.01
        },
        embeddingSignal
      );
    } finally {
      clearTimeout(timeout);
    }
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

function queryEmbeddingTimeoutMs(): number {
  const configured = Number(process.env.AGENT_QUERY_EMBEDDING_TIMEOUT_MS);
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    return DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS;
  }
  return Math.min(configured, MAX_QUERY_EMBEDDING_TIMEOUT_MS);
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
