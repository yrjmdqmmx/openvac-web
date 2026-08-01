import { afterEach, describe, expect, it, vi } from "vitest";

import type { LeasedModelingJob, ModelingWorkerRepository } from "./types";
import { ModelingWorker, type ModelingJobProcessorPort } from "./worker";

describe("ModelingWorker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks a claimed cancellation without invoking the engine", async () => {
    const job = leasedJob({
      cancelRequestedAt: new Date("2026-08-01T00:00:10.000Z")
    });
    const repository = fakeRepository(job);
    const processor: ModelingJobProcessorPort = {
      process: vi.fn(async () => undefined)
    };
    const worker = new ModelingWorker({
      repository,
      processor,
      workerId: "worker-1",
      leaseMs: 60_000,
      heartbeatMs: 15_000
    });

    await expect(worker.runOnce()).resolves.toBe("cancelled");
    expect(processor.process).not.toHaveBeenCalled();
    expect(repository.markCancelled).toHaveBeenCalledOnce();
  });

  it("converts processor exceptions into a terminal failed job", async () => {
    const job = leasedJob();
    const repository = fakeRepository(job);
    const processor: ModelingJobProcessorPort = {
      process: vi.fn(async () => {
        throw new Error("kernel crashed");
      })
    };
    const worker = new ModelingWorker({
      repository,
      processor,
      workerId: "worker-1",
      leaseMs: 60_000,
      heartbeatMs: 15_000
    });

    await expect(worker.runOnce()).resolves.toBe("failed");
    expect(repository.markFailed).toHaveBeenCalledWith(job, expect.any(Error));
  });

  it("does no work when the globally serialized queue is empty", async () => {
    const repository = fakeRepository(null);
    const processor: ModelingJobProcessorPort = {
      process: vi.fn(async () => undefined)
    };
    const worker = new ModelingWorker({ repository, processor });

    await expect(worker.runOnce()).resolves.toBe("idle");
    expect(repository.claimNext).toHaveBeenCalledTimes(1);
    expect(processor.process).not.toHaveBeenCalled();
  });

  it("runs bounded artifact cleanup periodically before claiming CAD work", async () => {
    const calls: string[] = [];
    let now = 100;
    const repository = fakeRepository(null);
    vi.mocked(repository.claimNext).mockImplementation(async () => {
      calls.push("job-claim");
      return null;
    });
    const artifactCleaner = {
      cleanupBatch: vi.fn(async () => {
        calls.push("artifact-cleanup");
      })
    };
    const worker = new ModelingWorker({
      repository,
      processor: { process: vi.fn(async () => undefined) },
      artifactCleaner,
      artifactCleanupIntervalMs: 1_000,
      now: () => now
    });

    await expect(worker.runOnce()).resolves.toBe("idle");
    now = 500;
    await expect(worker.runOnce()).resolves.toBe("idle");
    now = 1_100;
    await expect(worker.runOnce()).resolves.toBe("idle");

    expect(artifactCleaner.cleanupBatch).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      "artifact-cleanup",
      "job-claim",
      "job-claim",
      "artifact-cleanup",
      "job-claim"
    ]);
  });

  it("waits for processor cleanup before completing a running cancellation", async () => {
    vi.useFakeTimers();
    const job = leasedJob();
    const repository = fakeRepository(job);
    vi.mocked(repository.renewLease).mockResolvedValue("cancel_requested");
    let finishCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let processorAborted = false;
    const processor: ModelingJobProcessorPort = {
      process: vi.fn(
        async (_job, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                processorAborted = true;
                void cleanupGate.then(() => reject(signal.reason));
              },
              { once: true }
            );
          })
      )
    };
    const worker = new ModelingWorker({
      repository,
      processor,
      leaseMs: 100,
      heartbeatMs: 10
    });

    const outcome = worker.runOnce();
    await vi.advanceTimersByTimeAsync(10);
    expect(processorAborted).toBe(true);
    expect(repository.markCancelled).not.toHaveBeenCalled();

    finishCleanup();
    await expect(outcome).resolves.toBe("cancelled");
    expect(repository.markCancelled).toHaveBeenCalledOnce();
  });
});

function fakeRepository(
  claimed: LeasedModelingJob | null
): ModelingWorkerRepository {
  return {
    claimExpiredArtifact: vi.fn(async () => null),
    completeExpiredArtifactCleanup: vi.fn(async () => undefined),
    failExpiredArtifactCleanup: vi.fn(async () => undefined),
    claimNext: vi.fn(async () => claimed),
    renewLease: vi.fn(async () => "active" as const),
    transition: vi.fn(async () => undefined),
    loadRevision: vi.fn(async () => {
      throw new Error("not used");
    }),
    loadSourceArtifact: vi.fn(async () => {
      throw new Error("not used");
    }),
    loadExistingAiPlan: vi.fn(async () => null),
    completeAiPlan: vi.fn(async () => ({
      status: "succeeded" as const,
      artifactIds: []
    })),
    complete: vi.fn(async () => ({
      status: "succeeded" as const,
      artifactIds: []
    })),
    completeImport: vi.fn(async () => ({
      status: "succeeded" as const,
      artifactIds: []
    })),
    markCancelled: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => "failed" as const)
  };
}

function leasedJob(
  overrides: Partial<LeasedModelingJob> = {}
): LeasedModelingJob {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
    revisionId: "22222222-2222-4222-8222-222222222222",
    planId: null,
    ownerId: "user-1",
    kind: "build",
    input: {},
    idempotencyKey: "job-build-1",
    progress: 1,
    workerId: "worker-1",
    leaseToken: "55555555-5555-4555-8555-555555555555",
    leaseExpiresAt: new Date("2026-08-01T00:01:00.000Z"),
    cancelRequestedAt: null,
    recovered: false,
    ...overrides
  };
}
