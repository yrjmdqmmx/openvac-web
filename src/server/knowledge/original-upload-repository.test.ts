import { describe, expect, it, vi } from "vitest";

import {
  PostgresKnowledgeOriginalUploadRepository,
  type KnowledgeUploadSql
} from "./original-upload-repository";

const documentId = "00000000-0000-4000-8000-000000000001";
const versionId = "00000000-0000-4000-8000-000000000002";
const objectKey = `private/knowledge-originals/${documentId}/${versionId}/manual.pdf`;
const sha256 = "a".repeat(64);

describe("Postgres knowledge original upload repository", () => {
  it("persists a source-optional processing document, mirrored version key, and indefinite original", async () => {
    const sql = new RecordingSql(() => []);
    const repository = new PostgresKnowledgeOriginalUploadRepository(sql);

    await repository.initiate({
      documentId,
      versionId,
      title: "Manual",
      description: "Uploaded original",
      originalFilename: "manual.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      sha256,
      objectKey,
      uploadedBy: "admin-1",
      retentionPolicy: "retain_indefinitely"
    });

    const documentInsert = sql.find("INSERT INTO knowledge_document");
    const versionInsert = sql.find("INSERT INTO knowledge_version");
    const originalInsert = sql.find("INSERT INTO knowledge_original");
    expect(documentInsert.query).toContain("source_id");
    expect(documentInsert.parameters).toContain(null);
    expect(documentInsert.parameters).toContain("processing");
    expect(versionInsert.parameters).toContain(objectKey);
    expect(versionInsert.parameters).toContain("processing");
    expect(originalInsert.parameters).toContain("retain_indefinitely");
    expect(sql.calls.some((call) => /delete/iu.test(call.query))).toBe(false);
  });

  it("locks the owned current version, stats inside the lock, and idempotently queues OCR", async () => {
    let completionReads = 0;
    const sql = new RecordingSql((query) => {
      if (query.includes("FOR UPDATE OF kd, kv, ko")) {
        completionReads += 1;
        return [
          {
            document_id: documentId,
            version_id: versionId,
            object_key: objectKey,
            original_filename: "manual.pdf",
            mime_type: "application/pdf",
            size_bytes: 10,
            sha256,
            uploaded_by: "admin-1",
            task_id: completionReads === 1 ? null : "task-1",
            task_status: completionReads === 1 ? null : "queued"
          }
        ];
      }
      if (query.includes("INSERT INTO background_task")) {
        return [{ id: "task-1", status: "queued" }];
      }
      return [];
    });
    const repository = new PostgresKnowledgeOriginalUploadRepository(sql);
    const verify = vi.fn(async () => undefined);

    const first = await repository.complete(versionId, "admin-1", verify);
    const second = await repository.complete(versionId, "admin-1", verify);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      taskId: "task-1",
      taskStatus: "queued",
      stage: "ocr_pending"
    });
    expect(verify).toHaveBeenCalledTimes(2);
    const insert = sql.find("INSERT INTO background_task");
    expect(insert.parameters).toContain("knowledge_ingestion");
    expect(insert.parameters).toContain(
      `knowledge-ingestion:${versionId}:${sha256}`
    );
    expect(
      JSON.parse(
        String(
          insert.parameters?.find(
            (value) => typeof value === "string" && value.startsWith("{")
          )
        )
      )
    ).toEqual({
      stage: "ocr_pending",
      documentId,
      versionId,
      objectKey,
      filename: "manual.pdf"
    });
    expect(sql.calls.some((call) => /delete/iu.test(call.query))).toBe(false);
  });
});

type SqlCall = { query: string; parameters?: unknown[] };

class RecordingSql implements KnowledgeUploadSql {
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

  async begin<T>(
    handler: (transaction: KnowledgeUploadSql) => Promise<T>
  ): Promise<T> {
    return handler(this);
  }

  find(fragment: string): SqlCall {
    const call = this.calls.find((item) => item.query.includes(fragment));
    if (!call) throw new Error(`Missing SQL call containing: ${fragment}`);
    return call;
  }
}
