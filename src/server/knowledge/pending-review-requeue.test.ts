import { describe, expect, it } from "vitest";

import {
  PendingKnowledgeReviewRequeueService,
  parsePendingReviewRequeueArgs,
  type PendingReviewRequeueSql
} from "./pending-review-requeue";

const versionId = "00000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);

describe("PendingKnowledgeReviewRequeueService", () => {
  it("defaults to a read-only dry run and discovers current review-required versions", async () => {
    const sql = new RecordingSql((query) =>
      query.includes("SELECT")
        ? [
            {
              document_id: "00000000-0000-4000-8000-000000000002",
              external_key: "cern-2024-003-vacuum-systems-governed-v2",
              title: "Vacuum systems",
              input_version_id: versionId,
              input_content_hash: hash
            }
          ]
        : []
    );

    const result = await new PendingKnowledgeReviewRequeueService(sql).run({
      apply: false
    });

    expect(result).toEqual({
      mode: "dry-run",
      eligible: 1,
      created: 0,
      alreadyQueued: 0,
      candidates: [
        expect.objectContaining({
          externalKey: "cern-2024-003-vacuum-systems-governed-v2",
          inputVersionId: versionId,
          inputContentHash: hash
        })
      ]
    });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0]?.query).toContain("kd.current_version_id = kv.id");
    expect(sql.calls[0]?.query).toContain(
      "kv.metadata ->> 'reviewStatus' = 'required'"
    );
    expect(sql.calls[0]?.query).toContain("r.id IS NULL");
    expect(sql.calls[0]?.query).not.toContain(
      "INSERT INTO knowledge_review_run"
    );
  });

  it("idempotently creates only initial codex_automation_v1 runs bound to the current version and hash", async () => {
    const sql = new RecordingSql((query) => {
      if (query.includes("INSERT INTO knowledge_review_run")) {
        return [
          {
            document_id: "00000000-0000-4000-8000-000000000002",
            external_key: "cern-2024-003-vacuum-systems-governed-v2",
            title: "Vacuum systems",
            input_version_id: versionId,
            input_content_hash: hash,
            run_id: "00000000-0000-4000-8000-000000000003"
          }
        ];
      }
      return [];
    });

    const result = await new PendingKnowledgeReviewRequeueService(sql).run({
      apply: true
    });

    expect(result).toMatchObject({ mode: "apply", eligible: 1, created: 1 });
    expect(sql.begins).toBe(1);
    expect(sql.calls[0]?.query).toContain("pg_advisory_xact_lock");
    const insert = sql.find("INSERT INTO knowledge_review_run");
    expect(insert.query).toContain("'initial'");
    expect(insert.query).toContain("'queued'");
    expect(insert.query).toContain("'gpt-5.5-codex'");
    expect(insert.query).toContain("'codex_automation_v1'");
    expect(insert.query).toContain("kv.id");
    expect(insert.query).toContain("kv.content_hash");
    expect(insert.query).toContain("ON CONFLICT");
    expect(insert.query).not.toMatch(/approved|completed_at|risk|decision/u);
  });
});

describe("parsePendingReviewRequeueArgs", () => {
  it("requires the explicit --apply flag before writes", () => {
    expect(parsePendingReviewRequeueArgs([])).toEqual({ apply: false });
    expect(parsePendingReviewRequeueArgs(["--apply"])).toEqual({ apply: true });
    expect(() => parsePendingReviewRequeueArgs(["--unknown"])).toThrow(
      "Unknown argument"
    );
  });
});

type Call = { query: string; parameters?: unknown[] };

class RecordingSql implements PendingReviewRequeueSql {
  readonly calls: Call[] = [];
  begins = 0;

  constructor(
    private readonly response: (
      query: string,
      parameters?: unknown[]
    ) => Array<Record<string, unknown>>
  ) {}

  async unsafe(query: string, parameters?: unknown[]) {
    const normalized = query.trim();
    this.calls.push({ query: normalized, parameters });
    return this.response(normalized, parameters);
  }

  async begin<T>(
    handler: (transaction: PendingReviewRequeueSql) => Promise<T>
  ): Promise<T> {
    this.begins += 1;
    return handler(this);
  }

  find(fragment: string): Call {
    const call = this.calls.find((entry) => entry.query.includes(fragment));
    if (!call) throw new Error(`Missing SQL call containing ${fragment}`);
    return call;
  }
}
