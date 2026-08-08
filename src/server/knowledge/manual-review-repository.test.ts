import { describe, expect, it } from "vitest";

import { PostgresKnowledgeManualReviewRepository } from "./manual-review-repository";
import type { KnowledgeManualReviewSql } from "./manual-review-repository";

const target = {
  documentId: "00000000-0000-4000-8000-000000000001",
  expectedVersionId: "00000000-0000-4000-8000-000000000002",
  expectedContentHash: "a".repeat(64),
  actorId: "editor-1",
  actorRole: "knowledge_editor" as const,
  requestId: "request-1"
};

describe("PostgresKnowledgeManualReviewRepository", () => {
  it("rechecks current version, hash and source rights before manual approval", async () => {
    const sql = new RecordingSql([
      [authorizedTarget()],
      [authorizedSource()],
      [{ id: target.expectedVersionId }],
      [{ id: "task-1", status: "queued" }],
      [{}],
      [{}]
    ]);
    const repository = new PostgresKnowledgeManualReviewRepository(sql);

    await repository.resolve({
      ...target,
      action: "manual_approve_with_note",
      note: "已核对当前原件和来源权利。"
    });

    expect(sql.calls[0]?.query).toContain("kd.current_version_id = kv.id");
    expect(sql.calls[0]?.query).toContain("kv.content_hash = $3");
    expect(sql.calls[0]?.query).toContain("FOR UPDATE OF kd, kv");
    expect(sql.calls[0]?.parameters).toEqual([
      target.documentId,
      target.expectedVersionId,
      target.expectedContentHash
    ]);
    expect(sql.calls[1]?.query).toContain("FROM knowledge_source");
    expect(sql.calls[1]?.query).toContain("FOR UPDATE");
    expect(
      sql.calls.some((call) =>
        call.query.includes("knowledge.manual_review.approved")
      )
    ).toBe(true);
    expect(
      sql.calls.some((call) =>
        JSON.stringify(call.parameters).includes("已核对当前原件和来源权利。")
      )
    ).toBe(true);
  });

  it("fails closed when source rights no longer authorize the current record", async () => {
    const sql = new RecordingSql([
      [authorizedTarget()],
      [{ ...authorizedSource(), source_enabled: false }]
    ]);
    const repository = new PostgresKnowledgeManualReviewRepository(sql);

    await expect(
      repository.resolve({
        ...target,
        action: "manual_approve_with_note",
        note: "批准"
      })
    ).rejects.toMatchObject({ code: "KNOWLEDGE_SOURCE_RIGHTS_INVALID" });
    expect(sql.calls).toHaveLength(2);
  });

  it("never retries an old hash after the document moved to a newer version", async () => {
    const sql = new RecordingSql([[]]);
    const repository = new PostgresKnowledgeManualReviewRepository(sql);

    await expect(repository.retry(target)).rejects.toMatchObject({
      code: "KNOWLEDGE_REVIEW_CONFLICT"
    });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0]?.parameters).toEqual([
      target.documentId,
      target.expectedVersionId,
      target.expectedContentHash
    ]);
  });

  it("allows archiving a current failed upload even when no source was assigned", async () => {
    const sql = new RecordingSql([
      [{ ...authorizedTarget(), source_id: null }],
      [{}],
      [{}],
      [{}]
    ]);
    const repository = new PostgresKnowledgeManualReviewRepository(sql);

    await expect(
      repository.resolve({ ...target, action: "archive" })
    ).resolves.toMatchObject({ status: "archived" });
    expect(
      sql.calls.some((call) => call.query.includes("FROM knowledge_source"))
    ).toBe(false);
  });
});

class RecordingSql implements KnowledgeManualReviewSql {
  readonly calls: Array<{ query: string; parameters?: unknown[] }> = [];

  constructor(private readonly rows: Array<Array<Record<string, unknown>>>) {}

  async unsafe(query: string, parameters?: unknown[]) {
    this.calls.push({ query, parameters });
    return this.rows.shift() ?? [];
  }

  async begin<T>(
    handler: (transaction: KnowledgeManualReviewSql) => Promise<T>
  ): Promise<T> {
    return handler(this);
  }
}

function authorizedTarget(): Record<string, unknown> {
  return {
    document_id: target.documentId,
    version_id: target.expectedVersionId,
    version: 2,
    content: "current content",
    content_hash: target.expectedContentHash,
    citation_metadata: { ingestionMode: "full_text" },
    version_metadata: {},
    object_key: "private/knowledge-originals/document/version/manual.pdf",
    parser_version: "parser-v1",
    source_updated_at: null,
    created_by: "uploader-1",
    source_id: "source-1",
    source_tier: "internal",
    source_enabled: true,
    source_deleted_at: null,
    canonical_url: "https://example.com/manual.pdf",
    publisher: "Example",
    source_metadata: { commercialAiRightsConfirmed: true }
  };
}

function authorizedSource(): Record<string, unknown> {
  return {
    source_tier: "internal",
    source_enabled: true,
    source_deleted_at: null,
    canonical_url: "https://example.com/manual.pdf",
    publisher: "Example",
    source_metadata: { commercialAiRightsConfirmed: true }
  };
}
