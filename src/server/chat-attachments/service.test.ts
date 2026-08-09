import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/server/api/errors";
import type { ObjectStorage } from "@/server/providers";

import {
  ChatAttachmentService,
  sanitizeChatAttachmentFilename,
  type ChatAttachmentRepository,
  type ChatAttachmentTarget,
  type ChatAttachmentView
} from "./service";

const attachmentId = "00000000-0000-4000-8000-000000000001";
const conversationId = "00000000-0000-4000-8000-000000000002";
const messageId = "00000000-0000-4000-8000-000000000003";
const now = new Date("2026-08-09T04:00:00.000Z");

describe("chat attachment initiation", () => {
  it.each([
    ["manual.pdf", "application/pdf"],
    [
      "manual.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ],
    [
      "table.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ],
    ["table.csv", "text/csv"],
    ["notes.txt", "text/plain"],
    ["notes.md", "text/markdown"],
    ["photo.jpg", "image/jpeg"],
    ["diagram.png", "image/png"]
  ])("accepts supported %s uploads", async (filename, mimeType) => {
    const repository = makeRepository();
    const storage = makeStorage();
    const service = makeService(repository, storage);

    const result = await service.initiate({
      conversationId,
      filename,
      mimeType,
      sizeBytes: 123,
      sha256: "a".repeat(64),
      userId: "user-sensitive-id"
    });

    expect(result.upload).toMatchObject({
      method: "PUT",
      requiredHeaders: {
        "x-oss-object-acl": "private",
        "x-oss-forbid-overwrite": "true",
        "x-oss-meta-attachment-id": attachmentId,
        "x-oss-meta-size-bytes": "123",
        "x-oss-meta-sha256": "a".repeat(64)
      }
    });
    expect(result.upload.key).toMatch(
      new RegExp(
        `^private/chat-attachments/[a-f0-9]{24}/${conversationId}/${attachmentId}/`
      )
    );
    expect(result.upload.key).not.toContain("user-sensitive-id");
    expect(repository.initiate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: attachmentId,
        conversationId,
        filename,
        mimeType,
        declaredSizeBytes: 123,
        uploadExpiresAt: new Date("2026-08-09T04:15:00.000Z"),
        orphanExpiresAt: new Date("2026-08-10T04:00:00.000Z")
      })
    );
  });

  it.each([
    ["manual.exe", "application/pdf", 10, "a".repeat(64)],
    ["manual.pdf", "image/png", 10, "a".repeat(64)],
    ["manual.pdf", "application/pdf", 25 * 1024 * 1024 + 1, "a".repeat(64)],
    ["photo.jpg", "image/jpeg", 10 * 1024 * 1024 + 1, "a".repeat(64)],
    ["diagram.png", "image/png", 10 * 1024 * 1024 + 1, "a".repeat(64)],
    ["manual.pdf", "application/pdf", 10, "A".repeat(64)]
  ])(
    "rejects invalid upload metadata",
    async (filename, mimeType, size, hash) => {
      const repository = makeRepository();
      const storage = makeStorage();
      const service = makeService(repository, storage);

      await expect(
        service.initiate({
          conversationId,
          filename,
          mimeType,
          sizeBytes: size,
          sha256: hash,
          userId: "user-1"
        })
      ).rejects.toBeInstanceOf(ApiError);
      expect(repository.initiate).not.toHaveBeenCalled();
      expect(storage.createPrivateUploadUrl).not.toHaveBeenCalled();
    }
  );

  it("fails closed if OSS does not bind private ACL and overwrite protection", async () => {
    const repository = makeRepository();
    const storage = makeStorage();
    vi.mocked(storage.createPrivateUploadUrl!).mockImplementationOnce(
      async (request) => ({
        key: request.key,
        method: "PUT",
        url: "https://oss.test/upload",
        requiredHeaders: { "Content-Type": request.contentType },
        expiresAt: "2026-08-09T04:15:00.000Z"
      })
    );

    await expect(
      makeService(repository, storage).initiate({
        conversationId,
        filename: "manual.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        sha256: "a".repeat(64),
        userId: "user-1"
      })
    ).rejects.toMatchObject({ code: "ATTACHMENT_STORAGE_UNAVAILABLE" });
    expect(repository.initiate).not.toHaveBeenCalled();
  });

  it.each([
    ["photo.jpg", "image/jpeg", 10 * 1024 * 1024],
    ["manual.pdf", "application/pdf", 25 * 1024 * 1024]
  ])(
    "accepts the exact %s size boundary",
    async (filename, mimeType, sizeBytes) => {
      const repository = makeRepository();
      const storage = makeStorage();

      await expect(
        makeService(repository, storage).initiate({
          conversationId,
          filename,
          mimeType,
          sizeBytes,
          sha256: "a".repeat(64),
          userId: "user-1"
        })
      ).resolves.toMatchObject({ sizeBytes });
    }
  );

  it("sanitizes display filenames without path traversal", () => {
    expect(sanitizeChatAttachmentFilename("../../Pump manual (终版).PDF")).toBe(
      "Pump-manual.pdf"
    );
  });
});

describe("chat attachment completion and access", () => {
  it.each([
    ["application/pdf", new TextEncoder().encode("%PDF-1.7 private")],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      new TextEncoder().encode("PK\u0003\u0004 word/document.xml")
    ],
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      new TextEncoder().encode("PK\u0003\u0004 xl/workbook.xml")
    ],
    ["text/csv", new TextEncoder().encode("name,value\npump,10")],
    ["text/plain", new TextEncoder().encode("plain private text")],
    ["text/markdown", new TextEncoder().encode("# Private markdown")],
    ["image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0x01])],
    ["image/png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])]
  ])("accepts authoritative bytes for %s", async (mimeType, bytes) => {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const image = mimeType.startsWith("image/");
    const target = makeTarget({
      kind: image ? "image" : "document",
      mimeType,
      sizeBytes: bytes.length,
      sha256: hash,
      declaredSizeBytes: bytes.length
    });
    const repository = makeRepository(target);
    const storage = makeStorage({ target, bytes });

    await expect(
      makeService(repository, storage).complete({
        attachmentId,
        userId: "user-1"
      })
    ).resolves.toMatchObject({ status: "processing" });
    expect(repository.completeVerified).toHaveBeenCalledOnce();
  });

  it("verifies real bytes, object metadata, MIME, and commits quota", async () => {
    const bytes = new TextEncoder().encode("verified attachment");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const target = makeTarget({
      sha256: hash,
      declaredSizeBytes: bytes.length
    });
    const repository = makeRepository(target);
    const storage = makeStorage({ target, bytes });

    const result = await makeService(repository, storage).complete({
      attachmentId,
      userId: "user-1"
    });

    expect(result.status).toBe("processing");
    expect(repository.completeVerified).toHaveBeenCalledWith({
      attachmentId,
      userId: "user-1",
      sizeBytes: bytes.length,
      etag: "etag-1"
    });
    expect(repository.rejectCompletion).not.toHaveBeenCalled();
  });

  it.each([
    { actual: new TextEncoder().encode("tampered") },
    { contentType: "image/png" },
    { metadata: { sha256: "b".repeat(64) } },
    { sizeBytes: 1 }
  ])("rejects forged or mismatched stored objects: %j", async (patch) => {
    const bytes = new TextEncoder().encode("verified attachment");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const target = makeTarget({
      sha256: hash,
      declaredSizeBytes: bytes.length
    });
    const repository = makeRepository(target);
    const storage = makeStorage({
      target,
      bytes: patch.actual ?? bytes,
      statPatch: patch
    });

    await expect(
      makeService(repository, storage).complete({
        attachmentId,
        userId: "user-1"
      })
    ).rejects.toMatchObject({ code: "ATTACHMENT_UPLOAD_MISMATCH" });
    expect(repository.rejectCompletion).toHaveBeenCalledOnce();
    expect(repository.completeVerified).not.toHaveBeenCalled();
    if (!patch.actual) {
      expect(storage.getPrivate).not.toHaveBeenCalled();
    }
  });

  it("rejects a legacy image object above the effective 10 MiB provider limit", async () => {
    const declaredSizeBytes = 10 * 1024 * 1024 + 1;
    const target = makeTarget({
      kind: "image",
      mimeType: "image/jpeg",
      declaredSizeBytes,
      sizeBytes: declaredSizeBytes
    });
    const repository = makeRepository(target);
    const storage = makeStorage({ target });

    await expect(
      makeService(repository, storage).complete({
        attachmentId,
        userId: "user-1"
      })
    ).rejects.toMatchObject({ code: "ATTACHMENT_UPLOAD_MISMATCH" });
    expect(storage.getPrivate).not.toHaveBeenCalled();
  });

  it("returns only a five-minute HTTPS access URL for an owned committed object", async () => {
    const target = makeTarget({ quotaState: "committed", status: "ready" });
    const repository = makeRepository(target);
    const storage = makeStorage();

    const url = await makeService(repository, storage).createAccessUrl({
      attachmentId,
      userId: "user-1"
    });

    expect(url).toBe("https://oss.test/private-download");
    expect(storage.createPrivateDownloadUrl).toHaveBeenCalledWith(
      target.objectKey,
      300
    );
  });

  it("enforces five distinct attachments when binding a user message", async () => {
    const repository = makeRepository();
    const service = makeService(repository, makeStorage());
    const six = Array.from(
      { length: 6 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
    );

    await expect(
      service.bindToMessage({
        attachmentIds: six,
        conversationId,
        messageId,
        userId: "user-1"
      })
    ).rejects.toMatchObject({ code: "ATTACHMENT_BIND_INVALID" });
    await expect(
      service.bindToMessage({
        attachmentIds: [attachmentId, attachmentId],
        conversationId,
        messageId,
        userId: "user-1"
      })
    ).rejects.toMatchObject({ code: "ATTACHMENT_BIND_INVALID" });
    expect(repository.bindToMessage).not.toHaveBeenCalled();
  });

  it("delegates cancellation with the authenticated owner identity", async () => {
    const repository = makeRepository();
    await makeService(repository, makeStorage()).cancel({
      attachmentId,
      userId: "user-1"
    });
    expect(repository.deleteUnbound).toHaveBeenCalledWith(
      attachmentId,
      "user-1"
    );
  });
});

function makeService(
  repository: ChatAttachmentRepository,
  storage: ObjectStorage
) {
  return new ChatAttachmentService(
    repository,
    storage,
    { randomUUID: () => attachmentId },
    () => now
  );
}

function makeView(patch: Partial<ChatAttachmentView> = {}): ChatAttachmentView {
  return {
    id: attachmentId,
    conversationId,
    messageId: null,
    kind: "document",
    filename: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 123,
    status: "initiated",
    parseStatus: "queued",
    failureCode: null,
    failureMessage: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    readyAt: null,
    ...patch
  };
}

function makeTarget(
  patch: Partial<ChatAttachmentTarget> = {}
): ChatAttachmentTarget {
  return {
    ...makeView(),
    userId: "user-1",
    objectKey:
      `private/chat-attachments/abcdef0123456789abcdef01/${conversationId}/` +
      `${attachmentId}/notes.txt`,
    declaredSizeBytes: 123,
    sha256: "a".repeat(64),
    quotaState: "reserved",
    deletionStatus: "active",
    ...patch
  };
}

function makeRepository(target: ChatAttachmentTarget = makeTarget()) {
  return {
    initiate: vi.fn(async (input) =>
      makeView({
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.declaredSizeBytes,
        kind: input.kind
      })
    ),
    beginCompletion: vi.fn(async () => ({
      ...target,
      status: "scanning" as const,
      alreadyComplete: target.quotaState === "committed"
    })),
    completeVerified: vi.fn(async () =>
      makeView({ status: "processing", sizeBytes: target.declaredSizeBytes })
    ),
    resetCompletion: vi.fn(async () => undefined),
    rejectCompletion: vi.fn(async () => undefined),
    findOwned: vi.fn(async () => makeView()),
    findOwnedObject: vi.fn(async () => target),
    bindToMessage: vi.fn(async () => [makeView({ messageId })]),
    deleteUnbound: vi.fn(async () => undefined)
  } satisfies ChatAttachmentRepository;
}

function makeStorage(
  options: {
    target?: ChatAttachmentTarget;
    bytes?: Uint8Array;
    statPatch?: Record<string, unknown>;
  } = {}
): ObjectStorage {
  const target = options.target ?? makeTarget();
  const bytes = options.bytes ?? new TextEncoder().encode("unused");
  return {
    id: "test-storage",
    putPrivate: vi.fn(),
    getPrivate: vi.fn(async () => bytes),
    deletePrivate: vi.fn(async () => undefined),
    createPrivateDownloadUrl: vi.fn(
      async () => "https://oss.test/private-download"
    ),
    createPrivateUploadUrl: vi.fn(async (request) => ({
      key: request.key,
      method: "PUT" as const,
      url: "https://oss.test/upload",
      requiredHeaders: {
        "Content-Type": request.contentType,
        "x-oss-object-acl": "private",
        "x-oss-forbid-overwrite": "true",
        "x-oss-meta-attachment-id": request.metadata?.["attachment-id"] ?? "",
        "x-oss-meta-size-bytes": String(request.contentLength),
        "x-oss-meta-sha256": request.checksumSha256
      },
      expiresAt: "2026-08-09T04:15:00.000Z"
    })),
    statPrivate: vi.fn(async () => ({
      key: target.objectKey,
      sizeBytes: target.declaredSizeBytes,
      contentType: target.mimeType,
      etag: "etag-1",
      metadata: {
        "attachment-id": target.id,
        "size-bytes": String(target.declaredSizeBytes),
        sha256: target.sha256,
        ...(options.statPatch?.metadata as Record<string, string> | undefined)
      },
      ...options.statPatch
    }))
  };
}
