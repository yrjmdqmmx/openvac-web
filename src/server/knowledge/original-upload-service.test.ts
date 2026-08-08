import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { ApiError } from "@/server/api/errors";
import type { ObjectStorage, PrivateObjectStat } from "@/server/providers";

import {
  KnowledgeOriginalUploadService,
  sanitizeKnowledgeOriginalFilename,
  type KnowledgeOriginalUploadRepository
} from "./original-upload-service";

const documentId = "00000000-0000-4000-8000-000000000001";
const versionId = "00000000-0000-4000-8000-000000000002";
const sha256 = "a".repeat(64);
const actualBytes = new TextEncoder().encode("verified original bytes");
const actualSha256 = createHash("sha256").update(actualBytes).digest("hex");

describe("knowledge original upload initiation", () => {
  it("creates a processing draft and returns a header-bound private PUT", async () => {
    const repository = makeRepository();
    const storage = makeStorage();
    const service = new KnowledgeOriginalUploadService(repository, storage, {
      randomUUID: vi
        .fn()
        .mockReturnValueOnce(documentId)
        .mockReturnValueOnce(versionId)
    });

    const result = await service.initiate({
      title: "旋片泵说明书",
      description: "原始厂家资料",
      sourceUrl: "https://example.com/manual",
      filename: "../旋片泵 manual (2026).PDF",
      contentType: "application/pdf",
      sizeBytes: 1024,
      sha256,
      uploadedBy: "admin-1"
    });

    expect(result).toMatchObject({
      documentId,
      versionId,
      status: "processing",
      retentionPolicy: "retain_indefinitely",
      objectKey:
        `private/knowledge-originals/${documentId}/${versionId}/` +
        "manual-2026.pdf",
      upload: {
        method: "PUT",
        requiredHeaders: {
          "Content-Type": "application/pdf",
          "x-oss-forbid-overwrite": "true",
          "x-oss-meta-sha256": sha256,
          "x-oss-meta-size-bytes": "1024"
        }
      }
    });
    expect(repository.initiate).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId,
        versionId,
        title: "旋片泵说明书",
        description: "原始厂家资料",
        sourceUrl: "https://example.com/manual",
        originalFilename: "旋片泵 manual (2026).PDF",
        objectKey:
          `private/knowledge-originals/${documentId}/${versionId}/` +
          "manual-2026.pdf",
        retentionPolicy: "retain_indefinitely"
      })
    );
    expect(storage.createPrivateUploadUrl).toHaveBeenCalledWith({
      key:
        `private/knowledge-originals/${documentId}/${versionId}/` +
        "manual-2026.pdf",
      contentType: "application/pdf",
      contentLength: 1024,
      checksumSha256: sha256,
      metadata: {
        sha256,
        "size-bytes": "1024"
      },
      expiresSeconds: 900
    });
    expect(storage.deletePrivate).not.toHaveBeenCalled();
  });

  it.each([
    ["manual.exe", "application/octet-stream", 10, sha256],
    ["manual.pdf", "application/pdf", 50 * 1024 * 1024 + 1, sha256],
    ["manual.pdf", "application/pdf", 10, sha256.toUpperCase()]
  ])(
    "rejects unsupported, oversized, or non-lowercase-hash input",
    async (filename, contentType, sizeBytes, hash) => {
      const repository = makeRepository();
      const storage = makeStorage();
      const service = new KnowledgeOriginalUploadService(repository, storage);

      await expect(
        service.initiate({
          title: "Manual",
          filename,
          contentType,
          sizeBytes,
          sha256: hash,
          uploadedBy: "admin-1"
        })
      ).rejects.toBeInstanceOf(ApiError);
      expect(repository.initiate).not.toHaveBeenCalled();
      expect(storage.createPrivateUploadUrl).not.toHaveBeenCalled();
      expect(storage.deletePrivate).not.toHaveBeenCalled();
    }
  );

  it("sanitizes filenames without allowing path traversal", () => {
    expect(sanitizeKnowledgeOriginalFilename("../../manual final.PDF")).toBe(
      "manual-final.pdf"
    );
    expect(sanitizeKnowledgeOriginalFilename("..\\..\\manual.pdf")).toBe(
      "manual.pdf"
    );
  });

  it("fails closed before persistence when signed upload or stat is missing", async () => {
    const repository = makeRepository();
    const completeStorage = makeStorage();
    const missingSigner = {
      ...completeStorage,
      createPrivateUploadUrl: undefined
    } as ObjectStorage;
    const missingStat = {
      ...completeStorage,
      statPrivate: undefined
    } as ObjectStorage;

    for (const storage of [missingSigner, missingStat]) {
      const service = new KnowledgeOriginalUploadService(repository, storage);
      await expect(
        service.initiate({
          title: "Manual",
          filename: "manual.pdf",
          contentType: "application/pdf",
          sizeBytes: 10,
          sha256,
          uploadedBy: "admin-1"
        })
      ).rejects.toMatchObject({
        status: 503,
        code: "KNOWLEDGE_UPLOAD_UNAVAILABLE"
      });
    }

    expect(repository.initiate).not.toHaveBeenCalled();
    expect(completeStorage.deletePrivate).not.toHaveBeenCalled();
  });

  it("fails closed when the signed PUT does not forbid overwrite", async () => {
    const repository = makeRepository();
    const storage = makeStorage();
    vi.mocked(storage.createPrivateUploadUrl).mockImplementationOnce(
      async (request) => ({
        key: request.key,
        method: "PUT",
        url: "https://signed.test/upload",
        requiredHeaders: {
          "Content-Type": "application/pdf",
          "x-oss-meta-sha256": sha256
        },
        expiresAt: "2026-08-08T15:00:00.000Z"
      })
    );

    await expect(
      new KnowledgeOriginalUploadService(repository, storage).initiate({
        title: "Manual",
        filename: "manual.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        sha256,
        uploadedBy: "admin-1"
      })
    ).rejects.toMatchObject({
      status: 503,
      code: "KNOWLEDGE_UPLOAD_UNAVAILABLE"
    });
    expect(repository.initiate).not.toHaveBeenCalled();
    expect(storage.deletePrivate).not.toHaveBeenCalled();
  });
});

describe("knowledge original upload completion", () => {
  it.each([
    { sizeBytes: 11 },
    { contentType: "image/png" },
    { metadata: { sha256: "b".repeat(64) } }
  ])("rejects a stored-object %s mismatch and never queues", async (patch) => {
    const repository = makeRepository();
    const storage = makeStorage(patch);
    const service = new KnowledgeOriginalUploadService(repository, storage);

    await expect(
      service.complete({ versionId, uploadedBy: "admin-1" })
    ).rejects.toMatchObject({
      status: 409,
      code: "KNOWLEDGE_UPLOAD_MISMATCH"
    });
    expect(repository.queuedCount()).toBe(0);
    expect(storage.deletePrivate).not.toHaveBeenCalled();
  });

  it("rejects forged matching metadata when the actual object bytes differ", async () => {
    const repository = makeRepository();
    const storage = makeStorage(
      { metadata: { sha256: actualSha256 } },
      new TextEncoder().encode("tampered bytes")
    );
    const service = new KnowledgeOriginalUploadService(repository, storage);

    await expect(
      service.complete({ versionId, uploadedBy: "admin-1" })
    ).rejects.toMatchObject({
      status: 409,
      code: "KNOWLEDGE_UPLOAD_MISMATCH"
    });
    expect(storage.statPrivate).toHaveBeenCalledOnce();
    expect(storage.getPrivate).toHaveBeenCalledOnce();
    expect(repository.queuedCount()).toBe(0);
    expect(storage.deletePrivate).not.toHaveBeenCalled();
  });

  it("queues OCR once with no governed source and returns the existing queue on replay", async () => {
    const repository = makeRepository();
    const storage = makeStorage();
    const service = new KnowledgeOriginalUploadService(repository, storage);

    const first = await service.complete({
      versionId,
      uploadedBy: "admin-1"
    });
    const second = await service.complete({
      versionId,
      uploadedBy: "admin-1"
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      documentId,
      versionId,
      taskId: "task-1",
      taskStatus: "queued",
      stage: "ocr_pending"
    });
    expect(repository.complete).toHaveBeenCalledTimes(2);
    expect(repository.queuedCount()).toBe(1);
    expect(storage.statPrivate).toHaveBeenCalledTimes(2);
    expect(storage.getPrivate).toHaveBeenCalledTimes(2);
    expect(storage.deletePrivate).not.toHaveBeenCalled();
  });
});

function makeRepository(): KnowledgeOriginalUploadRepository & {
  initiate: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  queuedCount(): number;
} {
  let queued: Awaited<
    ReturnType<KnowledgeOriginalUploadRepository["complete"]>
  > | null = null;
  let queuedCount = 0;
  const target = {
    documentId,
    versionId,
    objectKey: `private/knowledge-originals/${documentId}/${versionId}/manual.pdf`,
    originalFilename: "manual.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
    sha256: actualSha256,
    uploadedBy: "admin-1"
  };
  return {
    initiate: vi.fn(async (input) => ({
      documentId: input.documentId,
      versionId: input.versionId,
      objectKey: input.objectKey,
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      retentionPolicy: input.retentionPolicy,
      status: "processing" as const
    })),
    complete: vi.fn(async (_versionId, _uploadedBy, verify) => {
      await verify(target);
      if (queued) return queued;
      queuedCount += 1;
      queued = {
        taskId: "task-1",
        taskStatus: "queued" as const,
        documentId,
        versionId,
        stage: "ocr_pending" as const
      };
      return queued;
    }),
    queuedCount: () => queuedCount
  };
}

function makeStorage(
  statPatch: Partial<PrivateObjectStat> = {},
  body: Uint8Array = actualBytes
): ObjectStorage & {
  deletePrivate: ReturnType<typeof vi.fn>;
  createPrivateUploadUrl: ReturnType<typeof vi.fn>;
  statPrivate: ReturnType<typeof vi.fn>;
} {
  const key = `private/knowledge-originals/${documentId}/${versionId}/manual.pdf`;
  return {
    id: "storage",
    putPrivate: vi.fn(async () => ({ key })),
    getPrivate: vi.fn(async () => body),
    deletePrivate: vi.fn(async () => undefined),
    createPrivateDownloadUrl: vi.fn(async () => "https://signed.test/read"),
    createPrivateUploadUrl: vi.fn(async (request) => ({
      key: request.key,
      method: "PUT" as const,
      url: "https://signed.test/upload",
      requiredHeaders: {
        "Content-Type": request.contentType,
        "x-oss-forbid-overwrite": "true",
        "x-oss-meta-sha256": request.checksumSha256,
        "x-oss-meta-size-bytes": String(request.contentLength)
      },
      expiresAt: "2026-08-08T15:00:00.000Z"
    })),
    statPrivate: vi.fn(async () => ({
      key,
      sizeBytes: 10,
      contentType: "application/pdf",
      metadata: { sha256: actualSha256 },
      ...statPatch
    }))
  };
}
