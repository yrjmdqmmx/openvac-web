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
  it("atomically links a later governed exact URL before rights checks and retry queueing", async () => {
    const sourceUrl = "https://example.com/manual.pdf";
    const sql = new RecordingSql([
      [
        {
          ...authorizedTarget(),
          source_id: null,
          citation_metadata: { ingestionMode: "full_text", sourceUrl }
        }
      ],
      [{ id: "source-1" }],
      [{ source_id: "source-1" }],
      [authorizedSource()],
      [{ id: "task-1", status: "queued" }],
      [{}]
    ]);
    const repository = new PostgresKnowledgeManualReviewRepository(sql);

    await expect(repository.retry(target)).resolves.toMatchObject({
      status: "queued",
      taskId: "task-1"
    });

    const sourceLookup = sql.calls[1];
    expect(sourceLookup?.query).toContain("canonical_url = $1");
    expect(sourceLookup?.query).toContain("enabled = TRUE");
    expect(sourceLookup?.query).toContain("deleted_at IS NULL");
    expect(sourceLookup?.query).toContain("FOR UPDATE");
    expect(sourceLookup?.parameters).toEqual([sourceUrl]);

    const linkUpdate = sql.calls[2];
    expect(linkUpdate?.query).toContain("UPDATE knowledge_document");
    expect(linkUpdate?.query).toContain("source_id IS NULL");
    expect(linkUpdate?.query).toContain("current_version_id = $3");
    expect(linkUpdate?.parameters).toEqual([
      target.documentId,
      "source-1",
      target.expectedVersionId
    ]);
    expect(sql.calls[3]?.parameters).toEqual(["source-1"]);
    expect(sql.calls[4]?.query).toContain("INSERT INTO knowledge_review_run");
    expect(
      sql.calls.some((call) =>
        call.query.includes("INSERT INTO knowledge_source")
      )
    ).toBe(false);
  });

  it("links a later governed exact URL before manual resolution verification", async () => {
    const sourceUrl = "https://example.com/manual.pdf";
    const sql = new RecordingSql([
      [
        {
          ...authorizedTarget(),
          source_id: null,
          citation_metadata: { ingestionMode: "full_text", sourceUrl }
        }
      ],
      [{ id: "source-1" }],
      [{ source_id: "source-1" }],
      [authorizedSource()],
      [{ id: "task-1", status: "queued" }],
      [{}]
    ]);
    const repository = new PostgresKnowledgeManualReviewRepository(sql);

    await expect(
      repository.resolve({
        ...target,
        action: "adopt_revision_and_retry",
        note: "来源已经加入白名单。"
      })
    ).resolves.toMatchObject({ status: "queued", taskId: "task-1" });

    expect(sql.calls[1]?.parameters).toEqual([sourceUrl]);
    expect(sql.calls[2]?.parameters).toEqual([
      target.documentId,
      "source-1",
      target.expectedVersionId
    ]);
    expect(sql.calls[3]?.parameters).toEqual(["source-1"]);
    expect(sql.calls[4]?.parameters?.[0]).toBe("verify");
  });

  it("fails closed when a later source URL is still unmatched and never queues", async () => {
    const sourceUrl = "https://example.com/not-governed.pdf";
    const sql = new RecordingSql([
      [
        {
          ...authorizedTarget(),
          source_id: null,
          citation_metadata: { ingestionMode: "full_text", sourceUrl }
        }
      ],
      []
    ]);
    const repository = new PostgresKnowledgeManualReviewRepository(sql);

    await expect(repository.retry(target)).rejects.toMatchObject({
      code: "KNOWLEDGE_SOURCE_RIGHTS_INVALID"
    });
    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[1]?.parameters).toEqual([sourceUrl]);
    expect(
      sql.calls.some((call) => call.query.includes("knowledge_review_run"))
    ).toBe(false);
    expect(
      sql.calls.some((call) =>
        call.query.includes("INSERT INTO knowledge_source")
      )
    ).toBe(false);
  });

  it("rejects a concurrent source-link change instead of queueing against stale state", async () => {
    const sourceUrl = "https://example.com/manual.pdf";
    const sql = new RecordingSql([
      [
        {
          ...authorizedTarget(),
          source_id: null,
          citation_metadata: { ingestionMode: "full_text", sourceUrl }
        }
      ],
      [{ id: "source-1" }],
      []
    ]);
    const repository = new PostgresKnowledgeManualReviewRepository(sql);

    await expect(repository.retry(target)).rejects.toMatchObject({
      code: "KNOWLEDGE_REVIEW_CONFLICT"
    });
    expect(sql.calls).toHaveLength(3);
    expect(
      sql.calls.some((call) => call.query.includes("knowledge_review_run"))
    ).toBe(false);
  });

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
