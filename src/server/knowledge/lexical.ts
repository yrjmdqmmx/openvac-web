const DOMAIN_TERMS = [
  "涡轮分子泵",
  "油封旋片泵",
  "平均自由程",
  "有效抽速",
  "抽气速度",
  "极限压力",
  "工作压力",
  "目标压力",
  "抽空时间",
  "单位换算",
  "分子流",
  "黏滞流",
  "前级泵",
  "真空泵",
  "离子泵",
  "旋片泵",
  "气体通量",
  "气载",
  "放气",
  "漏气",
  "流导",
  "抽速",
  "真空",
  "压力",
  "选泵",
  "选型",
  "返油",
  "过热",
  "异响",
  "介质"
] as const;

const QUESTION_FILLERS =
  /(?:请问|请帮我|帮我|我想知道|想知道|是什么|什么是|为什么|怎么样|怎么办|如何|怎么|能否|可以吗|可以|是否|请|一下|呢|吗|啊|呀)/gu;

export function extractLexicalTerms(input: string, limit = 12): string[] {
  const normalized = input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return [];

  const terms: string[] = [];
  const add = (value: string) => {
    const term = value.trim();
    if (term.length < 2 || terms.includes(term)) return;
    terms.push(term);
  };

  for (const term of DOMAIN_TERMS) {
    if (normalized.includes(term)) add(term);
  }

  for (const token of normalized.split(/\s+/u)) {
    const compact = token.replace(QUESTION_FILLERS, "").trim();
    if (/^[a-z0-9][a-z0-9._/+%-]*$/iu.test(compact)) {
      add(compact);
    } else if (/^[\p{Script=Han}]{2,12}$/u.test(compact)) {
      add(compact);
    }
  }

  return terms.slice(0, Math.max(1, Math.min(limit, 20)));
}

export const POSTGRES_LEXICAL_RETRIEVAL_SQL = `
WITH terms AS (
  SELECT DISTINCT term
  FROM unnest($1::text[]) AS term
  WHERE length(term) >= 2
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
  WHERE kv.status = 'published'
    AND kd.status = 'published'
    AND kd.current_version_id = kv.id
    AND (ks.id IS NULL OR (ks.enabled = TRUE AND ks.deleted_at IS NULL))
),
ranked AS (
  SELECT
    e.id,
    count(DISTINCT t.term)::double precision
      / greatest((SELECT count(*) FROM terms), 1)::double precision AS score
  FROM eligible e
  JOIN terms t
    ON strpos(lower(e.title || ' ' || e.content), lower(t.term)) > 0
  GROUP BY e.id
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
  ranked.score
FROM ranked
JOIN eligible e ON e.id = ranked.id
ORDER BY ranked.score DESC, e.id
LIMIT 8
`.trim();
