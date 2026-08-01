import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  IdempotencyConflictError,
  type ModelingImportIntentRow,
  type ModelingRepository
} from "@/server/modeling/repository";
import type { ObjectStorage } from "@/server/providers/types";

const authMocks = vi.hoisted(() => ({ getSession: vi.fn() }));
const accountCleanupMocks = vi.hoisted(() => ({
  isUserDeletionInProgress: vi.fn()
}));

vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: authMocks.getSession } }
}));
vi.mock("@/server/auth/account-cleanup", () => accountCleanupMocks);

import {
  canonicalStepUploadIntent,
  createPrivateStepUpload,
  handleCompleteModelingImport,
  handlePresignModelingImport,
  verifyCompletedStepUpload
} from "./imports";
import {
  importCompleteSchema,
  importPresignSchema,
  STEP_IMPORT_MAX_BYTES
} from "./schemas";

const OWNER_ID = "user-1";
const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const CHECKSUM = "c".repeat(64);

function intentRow(
  overrides: Partial<ModelingImportIntentRow> = {}
): ModelingImportIntentRow {
  const canonical = canonicalStepUploadIntent({
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    filename: "housing.step",
    mimeType: "model/step",
    sizeBytes: 2_048,
    checksumSha256: CHECKSUM,
    idempotencyKey: "upload-step-0001"
  });
  return {
    id: "40000000-0000-4000-8000-000000000004",
    ...canonical,
    expiresAt: new Date("2026-08-01T00:15:00.000Z"),
    completionIdempotencyKey: null,
    importJobId: null,
    completedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides
  };
}

function baseStorage(overrides: Partial<ObjectStorage>): ObjectStorage {
  return {
    id: "test-storage",
    putPrivate: vi.fn(async ({ key }) => ({ key })),
    getPrivate: vi.fn(async () => new Uint8Array()),
    deletePrivate: vi.fn(async () => undefined),
    createPrivateDownloadUrl: vi.fn(async () => "https://oss.test/get"),
    ...overrides
  };
}

function request(body: unknown): Request {
  return new Request("https://openvac.test/api/modeling/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("STEP direct upload service", () => {
  beforeEach(() => {
    authMocks.getSession.mockReset();
    accountCleanupMocks.isUserDeletionInProgress.mockReset();
    accountCleanupMocks.isUserDeletionInProgress.mockResolvedValue(false);
    authMocks.getSession.mockResolvedValue({
      user: {
        id: OWNER_ID,
        email: "owner@example.com",
        name: "Owner",
        banned: false
      }
    });
  });

  it("creates an owner/project-scoped, repeatable signed upload", async () => {
    const createPrivateUploadUrl = vi.fn(async (request) => ({
      key: request.key,
      method: "PUT" as const,
      url: "https://oss.test/put",
      requiredHeaders: {
        "Content-Type": request.contentType,
        "Content-Length": String(request.contentLength)
      },
      expiresAt: "2026-08-01T00:15:00.000Z"
    }));
    const storage = baseStorage({ createPrivateUploadUrl });
    const input = {
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      filename: "housing.STP",
      mimeType: "model/step",
      sizeBytes: 2_048,
      checksumSha256: CHECKSUM,
      idempotencyKey: "upload-step-0001"
    };

    const first = await createPrivateStepUpload(input, storage);
    const replay = await createPrivateStepUpload(input, storage);

    expect(first.key).toBe(replay.key);
    expect(first.key).toMatch(
      new RegExp(
        `^modeling/${OWNER_ID}/${PROJECT_ID}/imports/[0-9a-f]{40}\\.step$`
      )
    );
    expect(createPrivateUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "model/step",
        contentLength: 2_048,
        checksumSha256: CHECKSUM,
        metadata: {
          "upload-kind": "modeling-step",
          "owner-id": OWNER_ID,
          "project-id": PROJECT_ID,
          "source-name": "housing.STP"
        }
      })
    );
  });

  it("verifies actual size and signed server-side metadata", async () => {
    const objectKey = `modeling/${OWNER_ID}/${PROJECT_ID}/imports/${"d".repeat(40)}.step`;
    const statPrivate = vi.fn(async () => ({
      key: objectKey,
      sizeBytes: 4_096,
      etag: '"etag-step"',
      contentType: "model/step",
      metadata: {
        sha256: CHECKSUM,
        "size-bytes": "4096",
        "upload-kind": "modeling-step",
        "owner-id": OWNER_ID,
        "project-id": PROJECT_ID,
        "source-name": "housing.step"
      }
    }));

    await expect(
      verifyCompletedStepUpload(
        {
          ownerId: OWNER_ID,
          projectId: PROJECT_ID,
          objectKey,
          sizeBytes: 4_096,
          checksumSha256: CHECKSUM
        },
        baseStorage({ statPrivate })
      )
    ).resolves.toMatchObject({
      objectKey,
      sizeBytes: 4_096,
      checksumSha256: CHECKSUM,
      contentType: "model/step",
      etag: '"etag-step"'
    });
  });

  it("rejects another project before inspecting storage", async () => {
    const statPrivate = vi.fn();
    await expect(
      verifyCompletedStepUpload(
        {
          ownerId: OWNER_ID,
          projectId: PROJECT_ID,
          objectKey: `modeling/${OWNER_ID}/another-project/imports/${"d".repeat(40)}.step`,
          sizeBytes: 4_096,
          checksumSha256: CHECKSUM
        },
        baseStorage({ statPrivate })
      )
    ).rejects.toMatchObject({ code: "INVALID_OBJECT_KEY", status: 422 });
    expect(statPrivate).not.toHaveBeenCalled();
  });

  it("rejects mismatched checksum metadata", async () => {
    const objectKey = `modeling/${OWNER_ID}/${PROJECT_ID}/imports/${"d".repeat(40)}.step`;
    await expect(
      verifyCompletedStepUpload(
        {
          ownerId: OWNER_ID,
          projectId: PROJECT_ID,
          objectKey,
          sizeBytes: 4_096,
          checksumSha256: CHECKSUM
        },
        baseStorage({
          statPrivate: vi.fn(async () => ({
            key: objectKey,
            sizeBytes: 4_096,
            contentType: "model/step",
            metadata: {
              sha256: "f".repeat(64),
              "size-bytes": "4096",
              "upload-kind": "modeling-step",
              "owner-id": OWNER_ID,
              "project-id": PROJECT_ID,
              "source-name": "housing.step"
            }
          }))
        })
      )
    ).rejects.toMatchObject({
      code: "UPLOAD_VERIFICATION_FAILED",
      status: 422
    });
  });

  it("rejects an unbound source name or unsupported stored content type", async () => {
    const objectKey = `modeling/${OWNER_ID}/${PROJECT_ID}/imports/${"d".repeat(40)}.step`;
    const stored = {
      key: objectKey,
      sizeBytes: 4_096,
      contentType: "text/plain",
      metadata: {
        sha256: CHECKSUM,
        "size-bytes": "4096",
        "upload-kind": "modeling-step",
        "owner-id": OWNER_ID,
        "project-id": PROJECT_ID
      }
    };

    await expect(
      verifyCompletedStepUpload(
        {
          ownerId: OWNER_ID,
          projectId: PROJECT_ID,
          objectKey,
          sizeBytes: 4_096,
          checksumSha256: CHECKSUM
        },
        baseStorage({ statPrivate: vi.fn(async () => stored) })
      )
    ).rejects.toMatchObject({
      code: "UPLOAD_VERIFICATION_FAILED",
      status: 422
    });
  });

  it("enforces the 50 MB STEP boundary in both request schemas", () => {
    const presign = {
      filename: "part.step",
      mimeType: "application/octet-stream" as const,
      sizeBytes: STEP_IMPORT_MAX_BYTES,
      checksumSha256: CHECKSUM,
      idempotencyKey: "upload-step-0001"
    };
    expect(importPresignSchema.safeParse(presign).success).toBe(true);
    expect(
      importPresignSchema.safeParse({
        ...presign,
        sizeBytes: STEP_IMPORT_MAX_BYTES + 1
      }).success
    ).toBe(false);
    expect(
      importCompleteSchema.safeParse({
        objectKey: "modeling/user/project/imports/object.step",
        sizeBytes: STEP_IMPORT_MAX_BYTES + 1,
        checksumSha256: CHECKSUM,
        idempotencyKey: "upload-step-0001"
      }).success
    ).toBe(false);
  });

  it("returns a usable signed upload contract from the API handler", async () => {
    const createPrivateUploadUrl = vi.fn(async (upload) => ({
      key: upload.key,
      method: "PUT" as const,
      url: "https://oss.test/put",
      requiredHeaders: { "Content-Type": upload.contentType },
      expiresAt: "2026-08-01T00:15:00.000Z"
    }));
    const reserveStepUploadIntent = vi.fn(async () => ({
      value: intentRow(),
      replayed: false
    }));
    const response = await handlePresignModelingImport(
      request({
        filename: "housing.step",
        mimeType: "model/step",
        sizeBytes: 2_048,
        checksumSha256: CHECKSUM,
        idempotencyKey: "upload-step-0001"
      }),
      PROJECT_ID,
      {
        getProject: vi.fn(async () => ({ id: PROJECT_ID })),
        reserveStepUploadIntent
      } as unknown as ModelingRepository,
      baseStorage({ createPrivateUploadUrl })
    );
    const body = (await response.json()) as {
      data: {
        upload: { key: string; method: string; url: string };
        constraints: { format: string; maxBytes: number };
      };
    };

    expect(response.status).toBe(200);
    expect(body.data.upload).toMatchObject({
      method: "PUT",
      url: "https://oss.test/put"
    });
    expect(body.data.upload.key).toContain(
      `modeling/${OWNER_ID}/${PROJECT_ID}/imports/`
    );
    expect(body.data.constraints).toEqual({
      format: "STEP",
      maxBytes: STEP_IMPORT_MAX_BYTES
    });
    expect(reserveStepUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        idempotencyKey: "upload-step-0001",
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        objectKey: body.data.upload.key,
        sourceName: "housing.step",
        mimeType: "model/step",
        sizeBytes: 2_048,
        checksumSha256: CHECKSUM,
        expiresAt: expect.any(Date)
      })
    );
  });

  it("returns 409 when the same persisted presign key is reused for another payload", async () => {
    const createPrivateUploadUrl = vi.fn();
    const response = await handlePresignModelingImport(
      request({
        filename: "different.step",
        mimeType: "model/step",
        sizeBytes: 9_999,
        checksumSha256: "d".repeat(64),
        idempotencyKey: "upload-step-0001"
      }),
      PROJECT_ID,
      {
        getProject: vi.fn(async () => ({ id: PROJECT_ID })),
        reserveStepUploadIntent: vi.fn(async () => {
          throw new IdempotencyConflictError("upload-step-0001");
        })
      } as unknown as ModelingRepository,
      baseStorage({ createPrivateUploadUrl })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" }
    });
    expect(createPrivateUploadUrl).not.toHaveBeenCalled();
  });

  it("can retry signing the same persisted object after a provider failure", async () => {
    const persisted = intentRow({
      expiresAt: new Date("2026-07-31T23:59:00.000Z")
    });
    const reserveStepUploadIntent = vi
      .fn()
      .mockResolvedValueOnce({ value: persisted, replayed: false })
      .mockResolvedValueOnce({ value: persisted, replayed: true });
    const createPrivateUploadUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockImplementationOnce(async (upload) => ({
        key: upload.key,
        method: "PUT" as const,
        url: "https://oss.test/retry",
        requiredHeaders: {},
        expiresAt: "2026-08-01T00:30:00.000Z"
      }));
    const repository = {
      getProject: vi.fn(async () => ({ id: PROJECT_ID })),
      reserveStepUploadIntent
    } as unknown as ModelingRepository;
    const body = {
      filename: "housing.step",
      mimeType: "model/step",
      sizeBytes: 2_048,
      checksumSha256: CHECKSUM,
      idempotencyKey: "upload-step-0001"
    };

    const failed = await handlePresignModelingImport(
      request(body),
      PROJECT_ID,
      repository,
      baseStorage({ createPrivateUploadUrl })
    );
    const retried = await handlePresignModelingImport(
      request(body),
      PROJECT_ID,
      repository,
      baseStorage({ createPrivateUploadUrl })
    );

    expect(failed.status).toBe(503);
    expect(retried.status).toBe(200);
    expect(retried.headers.get("idempotency-replayed")).toBe("true");
    await expect(retried.json()).resolves.toMatchObject({
      data: {
        upload: { key: persisted.objectKey, url: "https://oss.test/retry" },
        idempotentReplay: true
      }
    });
    expect(createPrivateUploadUrl).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ key: persisted.objectKey })
    );
  });

  it("rejects a forged completion before inspecting private storage", async () => {
    const statPrivate = vi.fn();
    const completeStepUploadIntent = vi.fn();
    const getStepUploadIntent = vi.fn(async () => null);
    const objectKey = `modeling/${OWNER_ID}/${PROJECT_ID}/imports/${"f".repeat(40)}.step`;
    const response = await handleCompleteModelingImport(
      request({
        objectKey,
        sizeBytes: 4_096,
        checksumSha256: CHECKSUM,
        idempotencyKey: "complete-step-forged"
      }),
      PROJECT_ID,
      {
        getProject: vi.fn(async () => ({
          id: PROJECT_ID,
          currentRevision: {
            id: "30000000-0000-4000-8000-000000000003"
          }
        })),
        getStepUploadIntent,
        completeStepUploadIntent
      } as unknown as ModelingRepository,
      baseStorage({ statPrivate })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "STEP_UPLOAD_INTENT_MISMATCH" }
    });
    expect(getStepUploadIntent).toHaveBeenCalledWith(
      OWNER_ID,
      PROJECT_ID,
      objectKey
    );
    expect(statPrivate).not.toHaveBeenCalled();
    expect(completeStepUploadIntent).not.toHaveBeenCalled();
  });

  it("verifies the upload and enqueues an import against the current revision", async () => {
    const objectKey = `modeling/${OWNER_ID}/${PROJECT_ID}/imports/${"e".repeat(40)}.step`;
    const completeStepUploadIntent = vi.fn(async () => ({
      value: {
        id: "20000000-0000-4000-8000-000000000002",
        projectId: PROJECT_ID,
        revisionId: "30000000-0000-4000-8000-000000000003",
        planId: null,
        kind: "import",
        status: "queued",
        progress: 0,
        input: {},
        output: {},
        cancelRequestedAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        startedAt: null,
        completedAt: null,
        updatedAt: new Date("2026-08-01T00:00:00.000Z")
      },
      replayed: false
    }));
    const response = await handleCompleteModelingImport(
      request({
        objectKey,
        sizeBytes: 4_096,
        checksumSha256: CHECKSUM,
        idempotencyKey: "complete-step-0001"
      }),
      PROJECT_ID,
      {
        getProject: vi.fn(async () => ({
          id: PROJECT_ID,
          currentRevision: {
            id: "30000000-0000-4000-8000-000000000003"
          }
        })),
        getStepUploadIntent: vi.fn(async () =>
          intentRow({ objectKey, sizeBytes: 4_096 })
        ),
        completeStepUploadIntent
      } as unknown as ModelingRepository,
      baseStorage({
        statPrivate: vi.fn(async () => ({
          key: objectKey,
          sizeBytes: 4_096,
          contentType: "model/step",
          metadata: {
            sha256: CHECKSUM,
            "size-bytes": "4096",
            "upload-kind": "modeling-step",
            "owner-id": OWNER_ID,
            "project-id": PROJECT_ID,
            "source-name": "housing.step"
          }
        }))
      })
    );
    const body = (await response.json()) as {
      data: {
        upload: {
          objectKey: string;
          checksumSha256: string;
          sizeBytes: number;
        };
        enqueued: boolean;
        job: { kind: string; status: string };
      };
    };

    expect(response.status).toBe(202);
    expect(body.data.upload).toMatchObject({
      objectKey,
      sourceName: "housing.step",
      checksumSha256: CHECKSUM,
      sizeBytes: 4_096
    });
    expect(body.data.enqueued).toBe(true);
    expect(body.data.job).toMatchObject({ kind: "import", status: "queued" });
    expect(completeStepUploadIntent).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      revisionId: "30000000-0000-4000-8000-000000000003",
      completionIdempotencyKey: "complete-step-0001",
      objectKey,
      sourceName: "housing.step",
      checksumSha256: CHECKSUM,
      sizeBytes: 4_096,
      mimeType: "model/step"
    });
  });
});
