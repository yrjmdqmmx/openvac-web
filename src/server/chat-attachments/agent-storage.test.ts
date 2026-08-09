import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  type AttachmentAccessScope,
  AttachmentToolService
} from "@/server/agent/attachment-tools";
import type { DocumentParser, ObjectStorage } from "@/server/providers";

import {
  type AgentAttachmentSql,
  PostgresAgentAttachmentStorage
} from "./agent-storage";

const scope: AttachmentAccessScope = {
  userId: "user-a",
  conversationId: "00000000-0000-4000-8000-000000000001",
  messageId: "00000000-0000-4000-8000-000000000002",
  attachmentId: "00000000-0000-4000-8000-000000000003"
};

describe("PostgresAgentAttachmentStorage authorization", () => {
  it("returns null without touching OSS when ownership or the active message-bound turn fails", async () => {
    const sql = makeSql([]);
    const objectStorage = makeObjectStorage(new Uint8Array([1]));
    const storage = new PostgresAgentAttachmentStorage(sql, objectStorage);

    await expect(storage.getAuthorizedAttachment(scope)).resolves.toBeNull();

    expect(sql.unsafe).toHaveBeenCalledWith(
      expect.stringMatching(/attachment\.message_id = \$4/u),
      [scope.attachmentId, scope.userId, scope.conversationId, scope.messageId]
    );
    const query = vi.mocked(sql.unsafe).mock.calls[0]?.[0] ?? "";
    expect(query).toMatch(/conversation\.status = 'active'/u);
    expect(query).toMatch(/active_run\.status IN \('pending', 'running'\)/u);
    expect(query).toMatch(/user_message\.role = 'user'/u);
    expect(objectStorage.getPrivate).not.toHaveBeenCalled();
  });

  it("rejects a malformed scope result instead of trusting the SQL client", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const sql = makeSql([imageRow(bytes, { user_id: "user-b" })]);
    const objectStorage = makeObjectStorage(bytes);
    const storage = new PostgresAgentAttachmentStorage(sql, objectStorage);

    await expect(storage.getAuthorizedAttachment(scope)).rejects.toMatchObject({
      code: "ATTACHMENT_STORAGE_INVALID"
    });
    expect(objectStorage.getPrivate).not.toHaveBeenCalled();
  });
});

describe("PostgresAgentAttachmentStorage document chunks", () => {
  it("does not download a document and returns DB chunk ids with page numbers", async () => {
    const sql = makeSql(
      [documentRow()],
      [
        {
          ...chunkScopeRow(),
          chunk_id: "10000000-0000-4000-8000-000000000001",
          content: "Pump evidence on page seven.",
          locator: { type: "page", page: 7 }
        },
        {
          ...chunkScopeRow(),
          chunk_id: "10000000-0000-4000-8000-000000000002",
          content: "A chunk without a page locator.",
          locator: { type: "text", lineStart: 1 }
        }
      ]
    );
    const objectStorage = makeObjectStorage(new Uint8Array([9]));
    const storage = new PostgresAgentAttachmentStorage(sql, objectStorage);

    const attachment = await storage.getAuthorizedAttachment(scope);
    const chunks = await storage.getParsedChunks(scope);

    expect(attachment).toEqual({
      userId: scope.userId,
      conversationId: scope.conversationId,
      messageId: scope.messageId,
      attachmentId: scope.attachmentId,
      kind: "document",
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      status: "ready"
    });
    expect(chunks).toEqual([
      {
        chunkId: "10000000-0000-4000-8000-000000000001",
        attachmentId: scope.attachmentId,
        text: "Pump evidence on page seven.",
        pageNumber: 7
      },
      {
        chunkId: "10000000-0000-4000-8000-000000000002",
        attachmentId: scope.attachmentId,
        text: "A chunk without a page locator."
      }
    ]);
    expect(objectStorage.getPrivate).not.toHaveBeenCalled();
  });

  it("returns an empty present cache when a ready document has no chunks", async () => {
    const storage = new PostgresAgentAttachmentStorage(
      makeSql([
        { ...chunkScopeRow(), chunk_id: null, content: null, locator: null }
      ]),
      makeObjectStorage(new Uint8Array())
    );

    await expect(storage.getParsedChunks(scope)).resolves.toEqual([]);
  });

  it("searches and opens a chunk beyond the first 256 without loading the document", async () => {
    const lateChunkContent = `第 301 页的分子泵轴承诊断证据。${"诊断记录。".repeat(1_200)}`;
    const lateChunk = {
      ...chunkScopeRow(),
      chunk_id: "10000000-0000-4000-8000-000000000301",
      content: lateChunkContent,
      locator: { type: "page", page: 301 },
      has_chunks: true
    };
    const sql = makeSql(
      [documentRow()],
      [lateChunk],
      [documentRow()],
      [lateChunk]
    );
    const objectStorage = makeObjectStorage(new Uint8Array([9]));
    const service = new AttachmentToolService({
      storage: new PostgresAgentAttachmentStorage(sql, objectStorage)
    });

    const search = await service.search({
      ...scope,
      allowedAttachmentIds: [scope.attachmentId],
      query: "分子泵轴承"
    });
    const opened = await service.open({
      ...scope,
      allowedAttachmentIds: [scope.attachmentId],
      chunkId: lateChunk.chunk_id
    });

    expect(search.matches).toEqual([
      expect.objectContaining({
        chunkId: lateChunk.chunk_id,
        pageNumber: 301
      })
    ]);
    expect(opened).toMatchObject({
      chunkId: lateChunk.chunk_id,
      pageNumber: 301
    });
    expect(search.matches[0]!.excerpt.length).toBeLessThan(
      lateChunkContent.length
    );
    expect(opened.excerpt.length).toBeLessThan(lateChunkContent.length);
    expect(opened.excerpt).not.toBe(lateChunkContent);
    expect(sql.unsafe).toHaveBeenCalledTimes(4);
    expect(vi.mocked(sql.unsafe).mock.calls[1]?.[0]).toMatch(
      /LEFT JOIN LATERAL[\s\S]+LIMIT \$7/u
    );
    expect(vi.mocked(sql.unsafe).mock.calls[1]?.[1]?.at(-1)).toBe(64);
    expect(vi.mocked(sql.unsafe).mock.calls[3]?.[0]).toMatch(
      /candidate\.id = \$5/u
    );
    expect(objectStorage.getPrivate).not.toHaveBeenCalled();
  });

  it("fails before DocMind fallback when worker-owned chunks are missing", async () => {
    const storage = new PostgresAgentAttachmentStorage(
      makeSql(
        [documentRow()],
        [
          {
            ...chunkScopeRow(),
            chunk_id: null,
            content: null,
            locator: null,
            has_chunks: false
          }
        ]
      ),
      makeObjectStorage(new Uint8Array())
    );
    const parser = makeDocumentParser();
    const service = new AttachmentToolService({ storage, parser });

    await expect(
      service.search({
        ...scope,
        allowedAttachmentIds: [scope.attachmentId],
        query: "pump"
      })
    ).rejects.toMatchObject({ code: "DOCUMENT_PARSE_FAILED" });
    expect(parser.submit).not.toHaveBeenCalled();
  });

  it("is read-only so a web request cannot replace worker-owned chunks", async () => {
    const sql = makeSql([]);
    const storage = new PostgresAgentAttachmentStorage(
      sql,
      makeObjectStorage(new Uint8Array())
    );

    await expect(storage.putParsedChunks(scope, [])).rejects.toMatchObject({
      code: "ATTACHMENT_STORAGE_READ_ONLY"
    });
    expect(sql.unsafe).not.toHaveBeenCalled();
  });
});

describe("PostgresAgentAttachmentStorage image integrity", () => {
  it("downloads an authorized private image and verifies its size and SHA-256", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const objectStorage = makeObjectStorage(bytes);
    const storage = new PostgresAgentAttachmentStorage(
      makeSql([imageRow(bytes)]),
      objectStorage
    );

    const attachment = await storage.getAuthorizedAttachment(scope);

    expect(attachment).toMatchObject({
      ...scope,
      kind: "image",
      filename: "gauge.png",
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      status: "ready",
      bytes
    });
    expect(objectStorage.getPrivate).toHaveBeenCalledWith(
      "private/chat-attachments/user/conversation/gauge.png"
    );
  });

  it("rejects a private image whose bytes do not match the committed hash", async () => {
    const expected = new Uint8Array([1, 2, 3]);
    const replaced = new Uint8Array([3, 2, 1]);
    const storage = new PostgresAgentAttachmentStorage(
      makeSql([imageRow(expected)]),
      makeObjectStorage(replaced)
    );

    await expect(storage.getAuthorizedAttachment(scope)).rejects.toMatchObject({
      code: "ATTACHMENT_INTEGRITY_MISMATCH"
    });
  });

  it.each([
    ["an oversized DB declaration", { size_bytes: 25 * 1024 * 1024 + 1 }],
    ["a disallowed MIME type", { mime_type: "image/svg+xml" }]
  ])("rejects %s before reading OSS", async (_label, override) => {
    const bytes = new Uint8Array([1]);
    const objectStorage = makeObjectStorage(bytes);
    const storage = new PostgresAgentAttachmentStorage(
      makeSql([imageRow(bytes, override)]),
      objectStorage
    );

    await expect(storage.getAuthorizedAttachment(scope)).rejects.toMatchObject({
      code: "ATTACHMENT_STORAGE_INVALID"
    });
    expect(objectStorage.getPrivate).not.toHaveBeenCalled();
  });

  it("rejects an image whose downloaded size differs from the committed size", async () => {
    const declared = new Uint8Array([1, 2, 3]);
    const storage = new PostgresAgentAttachmentStorage(
      makeSql([imageRow(declared)]),
      makeObjectStorage(new Uint8Array([1, 2]))
    );

    await expect(storage.getAuthorizedAttachment(scope)).rejects.toMatchObject({
      code: "ATTACHMENT_INTEGRITY_MISMATCH"
    });
  });
});

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    ...attachmentScopeRow(),
    kind: "document",
    original_filename: "report.pdf",
    mime_type: "application/pdf",
    size_bytes: 1024,
    sha256: "a".repeat(64),
    object_key: "private/chat-attachments/user/conversation/report.pdf",
    ...overrides
  };
}

function imageRow(bytes: Uint8Array, overrides: Record<string, unknown> = {}) {
  return {
    ...attachmentScopeRow(),
    kind: "image",
    original_filename: "gauge.png",
    mime_type: "image/png",
    size_bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    object_key: "private/chat-attachments/user/conversation/gauge.png",
    ...overrides
  };
}

function attachmentScopeRow() {
  return {
    attachment_id: scope.attachmentId,
    user_id: scope.userId,
    conversation_id: scope.conversationId,
    message_id: scope.messageId
  };
}

function chunkScopeRow() {
  return { ...attachmentScopeRow(), kind: "document" };
}

function makeSql(
  ...responses: Array<Array<Record<string, unknown>>>
): AgentAttachmentSql & {
  unsafe: ReturnType<typeof vi.fn>;
} {
  return {
    unsafe: vi.fn(async () => responses.shift() ?? [])
  };
}

function makeObjectStorage(bytes: Uint8Array): ObjectStorage {
  return {
    id: "test-storage",
    putPrivate: vi.fn(),
    getPrivate: vi.fn(async () => new Uint8Array(bytes)),
    deletePrivate: vi.fn(),
    createPrivateDownloadUrl: vi.fn()
  };
}

function makeDocumentParser(): DocumentParser & {
  submit: ReturnType<typeof vi.fn>;
} {
  return {
    id: "should-not-run",
    submit: vi.fn(async () => ({ jobId: "should-not-run" })),
    getStatus: vi.fn(async () => ({
      jobId: "should-not-run",
      status: "pending" as const
    })),
    getResult: vi.fn(async () => ({ jobId: "should-not-run", pages: [] }))
  };
}
