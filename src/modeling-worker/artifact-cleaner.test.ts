import { describe, expect, it, vi } from "vitest";

import { ModelingArtifactCleaner } from "./artifact-cleaner";
import type { LeasedArtifactCleanup, ModelingWorkerRepository } from "./types";

const PREVIEW = artifactLease({
  id: "10000000-0000-4000-8000-000000000001",
  kind: "preview",
  objectKey: "modeling/project/revision/job/preview.glb"
});
const EXPORT = artifactLease({
  id: "10000000-0000-4000-8000-000000000002",
  kind: "export",
  objectKey: "modeling/project/revision/job/model.step"
});

describe("ModelingArtifactCleaner", () => {
  it("deletes each private object before deleting its database row", async () => {
    const calls: string[] = [];
    const repository = cleanupRepository([PREVIEW, EXPORT, null], calls);
    const deletePrivate = vi.fn(async (key: string) => {
      calls.push(`oss:${key}`);
    });
    const cleaner = new ModelingArtifactCleaner({
      repository,
      objectStorage: { deletePrivate },
      workerId: "cleanup-worker-1",
      batchSize: 5
    });

    await expect(cleaner.cleanupBatch()).resolves.toEqual({
      claimed: 2,
      deleted: 2,
      failed: 0
    });
    expect(calls).toEqual([
      `oss:${PREVIEW.objectKey}`,
      `db:${PREVIEW.id}`,
      `oss:${EXPORT.objectKey}`,
      `db:${EXPORT.id}`
    ]);
    expect(repository.failExpiredArtifactCleanup).not.toHaveBeenCalled();
  });

  it("retains the database row and schedules a retry when OSS deletion fails", async () => {
    const repository = cleanupRepository([PREVIEW, null]);
    const error = new Error("OSS unavailable");
    const cleaner = new ModelingArtifactCleaner({
      repository,
      objectStorage: {
        deletePrivate: vi.fn(async () => {
          throw error;
        })
      },
      workerId: "cleanup-worker-1",
      retryDelayMs: 12_000
    });

    await expect(cleaner.cleanupBatch()).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      failed: 1
    });
    expect(repository.completeExpiredArtifactCleanup).not.toHaveBeenCalled();
    expect(repository.failExpiredArtifactCleanup).toHaveBeenCalledWith(
      PREVIEW,
      error,
      12_000
    );
  });

  it("retries idempotently when OSS succeeded but the DB delete was transient", async () => {
    const repository = cleanupRepository([PREVIEW, PREVIEW, null]);
    vi.mocked(repository.completeExpiredArtifactCleanup)
      .mockRejectedValueOnce(new Error("database restart"))
      .mockResolvedValueOnce(undefined);
    const deletePrivate = vi.fn(async () => undefined);
    const cleaner = new ModelingArtifactCleaner({
      repository,
      objectStorage: { deletePrivate },
      workerId: "cleanup-worker-1",
      batchSize: 1
    });

    await expect(cleaner.cleanupBatch()).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      failed: 1
    });
    await expect(cleaner.cleanupBatch()).resolves.toEqual({
      claimed: 1,
      deleted: 1,
      failed: 0
    });
    expect(deletePrivate).toHaveBeenCalledTimes(2);
    expect(repository.failExpiredArtifactCleanup).toHaveBeenCalledOnce();
  });
});

function artifactLease(
  overrides: Partial<LeasedArtifactCleanup> = {}
): LeasedArtifactCleanup {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    projectId: "20000000-0000-4000-8000-000000000001",
    kind: "preview",
    objectKey: "modeling/project/revision/job/preview.glb",
    leaseToken: "30000000-0000-4000-8000-000000000001",
    leaseOwner: "cleanup-worker-1",
    leaseExpiresAt: new Date("2026-08-01T00:01:00.000Z"),
    attempts: 1,
    ...overrides
  };
}

function cleanupRepository(
  claims: Array<LeasedArtifactCleanup | null>,
  calls: string[] = []
): ModelingWorkerRepository {
  return {
    claimExpiredArtifact: vi.fn(async () => claims.shift() ?? null),
    completeExpiredArtifactCleanup: vi.fn(async (artifact) => {
      calls.push(`db:${artifact.id}`);
    }),
    failExpiredArtifactCleanup: vi.fn(async () => undefined)
  } as unknown as ModelingWorkerRepository;
}
