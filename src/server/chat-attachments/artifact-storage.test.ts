import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ObjectStorage } from "@/server/providers";

import {
  ChatArtifactStorageService,
  type ChatArtifactStorageRepository,
  type ChatArtifactView
} from "./artifact-storage";

const artifactId = "00000000-0000-4000-8000-000000000001";
const fileId = "00000000-0000-4000-8000-000000000002";
const conversationId = "00000000-0000-4000-8000-000000000003";
const sourceTurnId = "00000000-0000-4000-8000-000000000004";
const spec = {
  schemaVersion: "openvac.artifact.v1" as const,
  kind: "diagnosis_report" as const,
  title: "Pump diagnosis",
  formats: ["pdf"] as ["pdf"],
  summary: "Diagnosis",
  sections: [],
  tables: [],
  sourceTurnId
};

describe("chat artifact storage", () => {
  it("creates only contract-valid metadata for an owned source turn", async () => {
    const repository = makeRepository();
    const service = makeService(repository, makeStorage());

    const result = await service.create({
      userId: "user-1",
      conversationId,
      spec
    });

    expect(result).toMatchObject({
      id: artifactId,
      conversationId,
      sourceTurnId,
      formats: ["pdf"],
      status: "generating"
    });
    expect(repository.createArtifact).toHaveBeenCalledWith({
      artifactId,
      userId: "user-1",
      conversationId,
      spec
    });
  });

  it("reserves combined quota before a no-overwrite private write and commits after stat", async () => {
    const repository = makeRepository();
    const bytes = new TextEncoder().encode("%PDF-private artifact");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const storage = makeStorage();
    vi.mocked(storage.statPrivate!).mockImplementationOnce(async (key) => ({
      key,
      sizeBytes: bytes.length,
      contentType: "application/pdf",
      metadata: {
        "artifact-id": artifactId,
        sha256: hash,
        "size-bytes": String(bytes.length)
      }
    }));
    const service = makeService(repository, storage, [fileId]);

    const result = await service.persistFile({
      artifactId,
      conversationId,
      userId: "user-1",
      format: "pdf" as const,
      filename: "Pump diagnosis.pdf",
      bytes
    });

    expect(result).not.toHaveProperty("objectKey");
    expect(repository.reserveFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId,
        artifactId,
        conversationId,
        sizeBytes: bytes.length,
        sha256: hash,
        objectKey: expect.stringMatching(/^private\/chat-artifacts\//u)
      })
    );
    expect(storage.putPrivate).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "application/pdf",
        forbidOverwrite: true,
        metadata: {
          "artifact-id": artifactId,
          sha256: hash,
          "size-bytes": String(bytes.length)
        }
      })
    );
    expect(repository.commitFile).toHaveBeenCalledWith({
      fileId,
      artifactId,
      userId: "user-1"
    });
    expect(repository.abortFile).not.toHaveBeenCalled();
  });

  it("releases reservation and queues cleanup when authoritative stat differs", async () => {
    const repository = makeRepository();
    const storage = makeStorage();
    vi.mocked(storage.statPrivate!).mockImplementationOnce(async (key) => ({
      key,
      sizeBytes: 999,
      contentType: "application/pdf",
      metadata: {}
    }));

    await expect(
      makeService(repository, storage, [fileId]).persistFile({
        artifactId,
        conversationId,
        userId: "user-1",
        format: "pdf",
        filename: "diagnosis.pdf",
        bytes: new TextEncoder().encode("%PDF-artifact")
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_STORAGE_MISMATCH" });
    expect(repository.abortFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId,
        artifactId,
        userId: "user-1"
      })
    );
    expect(repository.commitFile).not.toHaveBeenCalled();
  });

  it("rejects format-extension mismatches before reserving quota", async () => {
    const repository = makeRepository();
    await expect(
      makeService(repository, makeStorage(), [fileId]).persistFile({
        artifactId,
        conversationId,
        userId: "user-1",
        format: "pdf",
        filename: "diagnosis.docx",
        bytes: new Uint8Array([1])
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_FILE_INVALID" });
    expect(repository.reserveFile).not.toHaveBeenCalled();
  });
});

function makeService(
  repository: ChatArtifactStorageRepository,
  storage: ObjectStorage,
  ids = [artifactId, fileId]
) {
  const generatedIds = [...ids];
  return new ChatArtifactStorageService(repository, storage, {
    randomUUID: () => generatedIds.shift() ?? fileId
  });
}

function artifactView(): ChatArtifactView {
  return {
    id: artifactId,
    conversationId,
    sourceTurnId,
    kind: "diagnosis_report",
    title: "Pump diagnosis",
    formats: ["pdf"],
    status: "generating",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    readyAt: null
  };
}

function makeRepository(): ChatArtifactStorageRepository {
  return {
    createArtifact: vi.fn(async () => artifactView()),
    reserveFile: vi.fn(async () => undefined),
    commitFile: vi.fn(async () => ({
      id: fileId,
      artifactId,
      format: "pdf" as const,
      filename: "diagnosis.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      sha256: "a".repeat(64),
      createdAt: "2026-08-09T00:00:00.000Z"
    })),
    abortFile: vi.fn(async () => undefined)
  };
}

function makeStorage(): ObjectStorage {
  return {
    id: "test-storage",
    putPrivate: vi.fn(async (request) => ({ key: request.key })),
    getPrivate: vi.fn(),
    deletePrivate: vi.fn(async () => undefined),
    createPrivateDownloadUrl: vi.fn(),
    statPrivate: vi.fn(async (key) => ({
      key,
      sizeBytes: 1,
      contentType: "application/pdf",
      metadata: {}
    }))
  };
}
