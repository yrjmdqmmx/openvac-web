import { describe, expect, it, vi } from "vitest";

import type { ObjectStorage } from "@/server/providers";
import type { ArtifactSpec } from "@/types/chat-v3";

import {
  artifactRecordCreationFailureCode,
  ProductionArtifactStorage
} from "./artifact-runtime";
import {
  ChatArtifactStorageService,
  type ChatArtifactStorageRepository,
  type ChatArtifactView
} from "./artifact-storage";

const artifactId = "00000000-0000-4000-8000-000000000001";
const markdownFileId = "00000000-0000-4000-8000-000000000002";
const pdfFileId = "00000000-0000-4000-8000-000000000003";
const conversationId = "00000000-0000-4000-8000-000000000004";
const sourceTurnId = "00000000-0000-4000-8000-000000000005";
const runId = "00000000-0000-4000-8000-000000000006";
const assistantMessageId = "00000000-0000-4000-8000-000000000007";

describe("production artifact storage runtime", () => {
  it("validates, renders, persists every format, then atomically returns ready", async () => {
    const harness = makeHarness();
    const runtime = new ProductionArtifactStorage(harness.service, async () => [
      {
        format: "md",
        filename: "Pump diagnosis.md",
        contentType: "text/markdown; charset=utf-8",
        bytes: new TextEncoder().encode("# Diagnosis\n")
      },
      {
        format: "pdf",
        filename: "Pump diagnosis.pdf",
        contentType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-diagnosis")
      }
    ]);

    const result = await runtime.create(createInput());

    expect(result).toMatchObject({
      artifactId,
      userId: "user-1",
      conversationId,
      sourceTurnId,
      formats: ["md", "pdf"],
      status: "ready"
    });
    expect(harness.repository.createArtifact).toHaveBeenCalledTimes(1);
    expect(harness.repository.reserveFile).toHaveBeenCalledTimes(2);
    expect(harness.repository.commitFile).toHaveBeenCalledTimes(2);
    expect(harness.repository.completeArtifact).toHaveBeenCalledWith({
      artifactId,
      conversationId,
      userId: "user-1"
    });
    expect(harness.repository.failArtifact).not.toHaveBeenCalled();
  });

  it("marks failed and cleans an earlier committed object when a later write fails", async () => {
    const harness = makeHarness({ failPutAt: 2 });
    const runtime = new ProductionArtifactStorage(harness.service, async () => [
      {
        format: "md",
        filename: "Pump diagnosis.md",
        contentType: "text/markdown; charset=utf-8",
        bytes: new TextEncoder().encode("# Diagnosis\n")
      },
      {
        format: "pdf",
        filename: "Pump diagnosis.pdf",
        contentType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-diagnosis")
      }
    ]);

    await expect(runtime.create(createInput())).resolves.toMatchObject({
      artifactId,
      status: "failed",
      failureCode: "ARTIFACT_PERSIST_FAILED"
    });
    expect(harness.repository.abortFile).toHaveBeenCalledTimes(1);
    expect(harness.repository.failArtifact).toHaveBeenCalledWith({
      artifactId,
      conversationId,
      userId: "user-1"
    });
    expect(harness.storage.deletePrivate).toHaveBeenCalledTimes(1);
    expect(harness.repository.completeArtifact).not.toHaveBeenCalled();
  });

  it("never returns ready when repository finalization is not ready", async () => {
    const harness = makeHarness({ incompleteFinalize: true });
    const runtime = new ProductionArtifactStorage(harness.service, async () => [
      {
        format: "md",
        filename: "Pump diagnosis.md",
        contentType: "text/markdown; charset=utf-8",
        bytes: new TextEncoder().encode("# Diagnosis\n")
      },
      {
        format: "pdf",
        filename: "Pump diagnosis.pdf",
        contentType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-diagnosis")
      }
    ]);

    await expect(runtime.create(createInput())).resolves.toMatchObject({
      status: "failed",
      failureCode: "ARTIFACT_FINALIZE_FAILED"
    });
    expect(harness.repository.failArtifact).toHaveBeenCalledTimes(1);
  });

  it("cleans persisted files when the run signal aborts during rendering", async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    const runtime = new ProductionArtifactStorage(harness.service, async () => {
      controller.abort(new Error("run timed out"));
      return [
        {
          format: "md",
          filename: "Pump diagnosis.md",
          contentType: "text/markdown; charset=utf-8",
          bytes: new TextEncoder().encode("# Diagnosis\n")
        },
        {
          format: "pdf",
          filename: "Pump diagnosis.pdf",
          contentType: "application/pdf",
          bytes: new TextEncoder().encode("%PDF-diagnosis")
        }
      ];
    });

    await expect(
      runtime.create({ ...createInput(), signal: controller.signal })
    ).resolves.toMatchObject({
      artifactId,
      status: "failed",
      failureCode: "ARTIFACT_RUN_ABORTED"
    });
    expect(harness.repository.failArtifact).toHaveBeenCalledWith({
      artifactId,
      conversationId,
      userId: "user-1"
    });
    expect(harness.repository.reserveFile).not.toHaveBeenCalled();
    expect(harness.repository.completeArtifact).not.toHaveBeenCalled();
  });

  it("rejects non-strict specs before creating metadata", async () => {
    const harness = makeHarness();
    const renderer = vi.fn(async () => []);
    const runtime = new ProductionArtifactStorage(harness.service, renderer);
    const input = createInput() as unknown as Record<string, unknown>;
    input.spec = { ...(input.spec as object), internal: "must reject" };

    await expect(runtime.create(input as never)).rejects.toMatchObject({
      code: "INVALID_ARTIFACT_SPEC"
    });
    expect(renderer).not.toHaveBeenCalled();
    expect(harness.repository.createArtifact).not.toHaveBeenCalled();
  });

  it.each([
    ["NOT_FOUND", "ARTIFACT_SCOPE_MISMATCH"],
    ["23503", "ARTIFACT_SCOPE_MISMATCH"],
    ["42P01", "ARTIFACT_SCHEMA_UNAVAILABLE"],
    ["42501", "ARTIFACT_STORAGE_FORBIDDEN"],
    ["08006", "ARTIFACT_STORAGE_UNAVAILABLE"],
    ["57014", "ARTIFACT_RECORD_CREATE_TIMEOUT"],
    ["23514", "INVALID_ARTIFACT_SPEC"],
    ["UNEXPECTED", "ARTIFACT_RECORD_CREATE_FAILED"]
  ])("maps record creation error %s to safe code %s", (code, expected) => {
    expect(artifactRecordCreationFailureCode({ code })).toBe(expected);
  });

  it("surfaces a safe code when artifact metadata creation fails", async () => {
    const harness = makeHarness();
    vi.mocked(harness.repository.createArtifact).mockRejectedValueOnce({
      code: "42P01"
    });
    const runtime = new ProductionArtifactStorage(harness.service);

    await expect(runtime.create(createInput())).rejects.toMatchObject({
      code: "ARTIFACT_SCHEMA_UNAVAILABLE"
    });
  });
});

function createInput() {
  return {
    userId: "user-1",
    conversationId,
    turnId: sourceTurnId,
    runId,
    assistantMessageId,
    spec: artifactSpec()
  };
}

function artifactSpec(): ArtifactSpec {
  return {
    schemaVersion: "openvac.artifact.v1",
    kind: "diagnosis_report",
    title: "Pump diagnosis",
    formats: ["md", "pdf"],
    summary: "Diagnosis",
    sections: [
      {
        heading: "Conclusion",
        paragraphs: ["Inspect the pump inlet and seals."]
      }
    ],
    tables: [],
    sourceTurnId
  };
}

function artifactView(status: "generating" | "ready"): ChatArtifactView {
  return {
    id: artifactId,
    conversationId,
    sourceTurnId,
    kind: "diagnosis_report",
    title: "Pump diagnosis",
    formats: ["md", "pdf"],
    status,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:01.000Z",
    readyAt: status === "ready" ? "2026-08-09T00:00:01.000Z" : null
  };
}

function makeHarness(
  options: {
    failPutAt?: number;
    incompleteFinalize?: boolean;
  } = {}
) {
  const reservations = new Map<
    string,
    Parameters<ChatArtifactStorageRepository["reserveFile"]>[0]
  >();
  const objects = new Map<string, Parameters<ObjectStorage["putPrivate"]>[0]>();
  let putCount = 0;
  const repository: ChatArtifactStorageRepository = {
    createArtifact: vi.fn(async () => artifactView("generating")),
    reserveFile: vi.fn(async (input) => {
      reservations.set(input.fileId, input);
    }),
    commitFile: vi.fn(async ({ fileId }) => {
      const file = reservations.get(fileId);
      if (!file) throw new Error("missing reservation");
      return {
        id: fileId,
        artifactId,
        format: file.format,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        createdAt: "2026-08-09T00:00:00.000Z"
      };
    }),
    abortFile: vi.fn(async () => undefined),
    completeArtifact: vi.fn(async () =>
      artifactView(options.incompleteFinalize ? "generating" : "ready")
    ),
    failArtifact: vi.fn(async () => [...objects.keys()]),
    findRunArtifactIds: vi.fn(async () => []),
    findOwned: vi.fn(async () => artifactView("generating")),
    findOwnedFile: vi.fn(async () => null)
  };
  const storage: ObjectStorage = {
    id: "artifact-runtime-test",
    putPrivate: vi.fn(async (request) => {
      putCount += 1;
      if (putCount === options.failPutAt) throw new Error("put failed");
      objects.set(request.key, request);
      return { key: request.key };
    }),
    getPrivate: vi.fn(),
    deletePrivate: vi.fn(async (key) => {
      objects.delete(key);
    }),
    createPrivateDownloadUrl: vi.fn(),
    statPrivate: vi.fn(async (key) => {
      const object = objects.get(key);
      if (!object) throw new Error("missing object");
      const body =
        typeof object.body === "string"
          ? new TextEncoder().encode(object.body)
          : object.body;
      return {
        key,
        sizeBytes: body.byteLength,
        contentType: object.contentType,
        metadata: object.metadata ?? {}
      };
    })
  };
  const ids = [artifactId, markdownFileId, pdfFileId];
  const service = new ChatArtifactStorageService(repository, storage, {
    randomUUID: () => ids.shift() ?? pdfFileId
  });
  return { repository, storage, service };
}
