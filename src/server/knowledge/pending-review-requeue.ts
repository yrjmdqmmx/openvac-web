import { sqlClient } from "@/server/db";

export interface PendingReviewRequeueSql {
  unsafe(
    query: string,
    parameters?: unknown[]
  ): Promise<Array<Record<string, unknown>>>;
  begin<T>(
    handler: (transaction: PendingReviewRequeueSql) => Promise<T>
  ): Promise<T>;
}

export type PendingReviewRequeueCandidate = {
  documentId: string;
  externalKey: string | null;
  title: string;
  inputVersionId: string;
  inputContentHash: string;
  runId?: string;
};

export type PendingReviewRequeueResult = {
  mode: "dry-run" | "apply";
  eligible: number;
  created: number;
  alreadyQueued: number;
  candidates: PendingReviewRequeueCandidate[];
};

const pendingCandidateSql = `
  SELECT
    kd.id AS document_id,
    kd.external_key,
    kd.title,
    kv.id AS input_version_id,
    kv.content_hash AS input_content_hash
  FROM knowledge_document kd
  JOIN knowledge_version kv ON kv.id = kd.current_version_id
  LEFT JOIN knowledge_review_run r
    ON r.input_version_id = kv.id
    AND r.input_content_hash = kv.content_hash
    AND r.prompt_version = 'codex_automation_v1'
    AND r.phase = 'initial'
  WHERE
    kd.current_version_id = kv.id
    AND kd.status IN ('review', 'processing')
    AND kv.metadata ->> 'reviewStatus' = 'required'
    AND kv.content_hash ~ '^[0-9a-f]{64}$'
    AND length(trim(kv.content)) > 0
    AND r.id IS NULL
  ORDER BY kd.created_at ASC, kd.id ASC
`;

export class PendingKnowledgeReviewRequeueService {
  constructor(
    private readonly sql: PendingReviewRequeueSql = sqlClient as unknown as PendingReviewRequeueSql
  ) {}

  async run(input: { apply: boolean }): Promise<PendingReviewRequeueResult> {
    if (!input.apply) {
      const rows = await this.sql.unsafe(pendingCandidateSql);
      const candidates = rows.map(mapCandidate);
      return {
        mode: "dry-run",
        eligible: candidates.length,
        created: 0,
        alreadyQueued: 0,
        candidates
      };
    }

    return this.sql.begin(async (transaction) => {
      await transaction.unsafe(
        "SELECT pg_advisory_xact_lock(hashtext('openvac.knowledge.pending_review.requeue.v1'))"
      );
      const rows = await transaction.unsafe(`
        WITH eligible AS (
          ${pendingCandidateSql}
        ), inserted AS (
          INSERT INTO knowledge_review_run (
            phase,
            status,
            input_version_id,
            input_content_hash,
            model,
            prompt_version,
            structured_report,
            attempts,
            created_at,
            updated_at
          )
          SELECT
            'initial',
            'queued',
            eligible.input_version_id,
            eligible.input_content_hash,
            'gpt-5.5-codex',
            'codex_automation_v1',
            '{}'::jsonb,
            0,
            NOW(),
            NOW()
          FROM eligible
          ON CONFLICT (
            input_version_id,
            input_content_hash,
            prompt_version,
            phase
          ) DO NOTHING
          RETURNING id, input_version_id, input_content_hash
        )
        SELECT
          eligible.document_id,
          eligible.external_key,
          eligible.title,
          eligible.input_version_id,
          eligible.input_content_hash,
          inserted.id AS run_id
        FROM eligible
        JOIN inserted
          ON inserted.input_version_id = eligible.input_version_id
          AND inserted.input_content_hash = eligible.input_content_hash
        ORDER BY eligible.document_id ASC
      `);
      const candidates = rows.map(mapCandidate);
      return {
        mode: "apply",
        eligible: candidates.length,
        created: candidates.length,
        alreadyQueued: 0,
        candidates
      };
    });
  }
}

export function parsePendingReviewRequeueArgs(argv: string[]): {
  apply: boolean;
} {
  let apply = false;
  for (const argument of argv) {
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { apply };
}

function mapCandidate(
  row: Record<string, unknown>
): PendingReviewRequeueCandidate {
  return {
    documentId: requiredString(row.document_id, "document_id"),
    externalKey: typeof row.external_key === "string" ? row.external_key : null,
    title: requiredString(row.title, "title"),
    inputVersionId: requiredString(row.input_version_id, "input_version_id"),
    inputContentHash: requiredString(
      row.input_content_hash,
      "input_content_hash"
    ),
    ...(typeof row.run_id === "string" ? { runId: row.run_id } : {})
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Pending review query returned an invalid ${field}.`);
  }
  return value;
}
