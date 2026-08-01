import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PostgresKnowledgeIngestionRepository,
  type WorkerSql
} from "./postgres-repository";
import type { EmbeddedKnowledgeChunk, KnowledgeIngestionJob } from "./types";

describe("Postgres knowledge ingestion review lifecycle", () => {
  it("moves OCR output and its document into review with a SHA-256 hash", async () => {
    const sql = new RecordingSql((query) =>
      query.includes("RETURNING id") || query.includes("FROM background_task")
        ? [{ id: "updated" }]
        : []
    );
    const repository = new PostgresKnowledgeIngestionRepository(sql);
    const content = "# OCR result\n1.0 mbar";

    await repository.saveParsedForReview(
      makeJob({ stage: "ocr_processing", parserJobId: "parser-1" }),
      {
        jobId: "parser-1",
        pages: [{ pageNumber: 1, markdown: content }]
      },
      content
    );

    const versionUpdate = sql.find("UPDATE knowledge_version");
    const documentUpdate = sql.find("UPDATE knowledge_document");
    const taskUpdate = sql.find("UPDATE background_task");
    const expectedHash = createHash("sha256")
      .update(content, "utf8")
      .digest("hex");

    expect(versionUpdate.query).toContain("status = 'review'");
    expect(versionUpdate.query).toContain("content_hash = $5");
    expect(versionUpdate.parameters?.[4]).toBe(expectedHash);
    expect(documentUpdate.query).toContain("status = 'review'");
    expect(JSON.parse(String(taskUpdate.parameters?.[1]))).toMatchObject({
      stage: "review_required",
      contentHash: expectedHash,
      manualReviewRequired: true
    });
  });

  it("loads only the reviewed full-text version matching the submitted hash", async () => {
    const content = "Human-reviewed content";
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    const sql = new RecordingSql((query) =>
      query.includes("FROM background_task")
        ? [{ id: "job-1" }]
        : [
            {
              document_id: "doc-1",
              version_id: "version-1",
              content,
              citation_metadata: { ingestionMode: "full_text" },
              source_tier: "open_license",
              source_enabled: true,
              source_deleted_at: null,
              canonical_url: "https://cds.cern.ch/record/2929324",
              publisher: "CERN",
              source_metadata: {
                rightsDecision: {
                  status: "approved",
                  scope: "full_text",
                  appliesToRecordUrl: "https://cds.cern.ch/record/2929324"
                }
              }
            }
          ]
    );
    const repository = new PostgresKnowledgeIngestionRepository(sql);

    const result = await repository.loadApprovedContent(
      makeJob({
        stage: "embedding_pending",
        review: approval(hash)
      })
    );

    expect(result?.content).toBe(content);
    const contentQuery = sql.find("FROM knowledge_version");
    expect(contentQuery.query).toContain("kv.status = 'review'");
    expect(contentQuery.query).toContain("kd.status = 'review'");
    expect(contentQuery.query).toContain(
      "JOIN knowledge_source ks ON ks.id = kd.source_id"
    );
    expect(contentQuery.query).toContain("kv.content_hash = $3");
    expect(contentQuery.query).toContain(
      "kv.metadata #>> '{review,contentHash}' = $3"
    );
    expect(contentQuery.query).toContain(
      "kv.citation_metadata ->> 'ingestionMode' = 'full_text'"
    );
    expect(contentQuery.parameters?.[2]).toBe(hash);
  });

  it("refuses reviewed content when source rights do not match the record URL", async () => {
    const content = "Human-reviewed content";
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    const sql = new RecordingSql((query) =>
      query.includes("FROM background_task")
        ? [{ id: "job-1" }]
        : [
            {
              document_id: "doc-1",
              version_id: "version-1",
              content,
              citation_metadata: { ingestionMode: "full_text" },
              source_tier: "open_license",
              source_enabled: true,
              source_deleted_at: null,
              canonical_url: "https://cds.cern.ch/record/2929324",
              publisher: "CERN",
              source_metadata: {
                rightsReviewed: true,
                rightsDecision: {
                  status: "approved",
                  scope: "full_text",
                  appliesToRecordUrl: "https://cds.cern.ch/record/other"
                }
              }
            }
          ]
    );
    const repository = new PostgresKnowledgeIngestionRepository(sql);

    await expect(
      repository.loadApprovedContent(
        makeJob({ stage: "embedding_pending", review: approval(hash) })
      )
    ).resolves.toBeNull();
  });

  it("preserves review while recording the reviewer hash after embedding", async () => {
    const content = "Human-reviewed content";
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    const sql = new RecordingSql((query) =>
      query.includes("RETURNING id") || query.includes("FROM background_task")
        ? [{ id: "updated" }]
        : []
    );
    const repository = new PostgresKnowledgeIngestionRepository(sql);

    await repository.saveEmbeddingsAndComplete(
      makeJob({
        stage: "embedding_processing",
        review: approval(hash)
      }),
      [embeddedChunk()]
    );

    const versionUpdate = sql.find("UPDATE knowledge_version");
    const documentUpdate = sql.find("UPDATE knowledge_document");
    const taskUpdate = sql.find("UPDATE background_task");
    const metadata = JSON.parse(
      String(versionUpdate.parameters?.[1])
    ) as Record<string, unknown>;

    expect(versionUpdate.query).toContain("content_hash = $3");
    expect(versionUpdate.query).toContain("status = 'review'");
    expect(versionUpdate.query).toContain("AND content_hash = $3");
    expect(versionUpdate.parameters?.[2]).toBe(hash);
    expect(metadata).toMatchObject({
      reviewStatus: "approved",
      embeddingStatus: "completed",
      embeddedChunkCount: 1,
      review: approval(hash)
    });
    expect(documentUpdate.query).toContain("status = 'review'");
    expect(JSON.parse(String(taskUpdate.parameters?.[1]))).toMatchObject({
      stage: "completed",
      readyToPublish: true
    });
  });
});

type SqlCall = {
  query: string;
  parameters?: unknown[];
};

class RecordingSql implements WorkerSql {
  readonly calls: SqlCall[] = [];

  constructor(
    private readonly respond: (
      query: string,
      parameters?: unknown[]
    ) => Array<Record<string, unknown>>
  ) {}

  async unsafe(
    query: string,
    parameters?: unknown[]
  ): Promise<Array<Record<string, unknown>>> {
    const normalized = query.trim();
    this.calls.push({ query: normalized, parameters });
    return this.respond(normalized, parameters);
  }

  async begin<T>(handler: (transaction: WorkerSql) => Promise<T>): Promise<T> {
    return handler(this);
  }

  find(fragment: string): SqlCall {
    const call = this.calls.find((item) => item.query.includes(fragment));
    if (!call) {
      throw new Error(`Missing SQL call containing: ${fragment}`);
    }
    return call;
  }
}

function makeJob(
  patch: Partial<KnowledgeIngestionJob["payload"]>
): KnowledgeIngestionJob {
  return {
    id: "job-1",
    workerId: "worker-1",
    leaseToken: "00000000-0000-4000-8000-000000000001",
    attempts: 1,
    maxAttempts: 3,
    payload: {
      stage: "ocr_pending",
      documentId: "doc-1",
      versionId: "version-1",
      ...patch
    }
  };
}

function approval(contentHash: string) {
  return {
    status: "approved" as const,
    reviewedBy: "knowledge-editor-1",
    reviewedAt: "2026-07-31T08:00:00.000Z",
    contentHash
  };
}

function embeddedChunk(): EmbeddedKnowledgeChunk {
  return {
    chunkIndex: 0,
    content: "Human-reviewed content",
    sectionPath: ["Safety"],
    embedding: [0],
    embeddingModel: "text-embedding-v4",
    metadata: {}
  };
}
