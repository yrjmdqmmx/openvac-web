import { randomUUID } from "node:crypto";

import { StaleArtifactCleanupLeaseError } from "./repository";
import type {
  ModelingObjectStoragePort,
  ModelingWorkerRepository
} from "./types";

export interface ArtifactCleanupBatchResult {
  claimed: number;
  deleted: number;
  failed: number;
}

export interface ModelingArtifactCleanerOptions {
  repository: ModelingWorkerRepository;
  objectStorage: Pick<ModelingObjectStoragePort, "deletePrivate">;
  workerId?: string;
  leaseMs?: number;
  retryDelayMs?: number;
  batchSize?: number;
}

export class ModelingArtifactCleaner {
  private readonly repository: ModelingWorkerRepository;
  private readonly objectStorage: Pick<
    ModelingObjectStoragePort,
    "deletePrivate"
  >;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  private readonly batchSize: number;

  constructor(options: ModelingArtifactCleanerOptions) {
    this.repository = options.repository;
    this.objectStorage = options.objectStorage;
    this.workerId = options.workerId ?? `artifact-cleaner-${randomUUID()}`;
    this.leaseMs = positiveInteger(options.leaseMs ?? 60_000, "leaseMs");
    this.retryDelayMs = positiveInteger(
      options.retryDelayMs ?? 60_000,
      "retryDelayMs"
    );
    this.batchSize = positiveInteger(options.batchSize ?? 20, "batchSize");
  }

  async cleanupBatch(
    signal?: AbortSignal
  ): Promise<ArtifactCleanupBatchResult> {
    const result: ArtifactCleanupBatchResult = {
      claimed: 0,
      deleted: 0,
      failed: 0
    };
    for (let index = 0; index < this.batchSize; index += 1) {
      if (signal?.aborted) break;
      const artifact = await this.repository.claimExpiredArtifact(
        this.workerId,
        this.leaseMs
      );
      if (!artifact) break;
      result.claimed += 1;
      if (signal?.aborted) break;
      try {
        await this.objectStorage.deletePrivate(artifact.objectKey);
        await this.repository.completeExpiredArtifactCleanup(artifact);
        result.deleted += 1;
      } catch (cause) {
        const error = asError(cause);
        if (error instanceof StaleArtifactCleanupLeaseError) {
          continue;
        }
        try {
          await this.repository.failExpiredArtifactCleanup(
            artifact,
            error,
            this.retryDelayMs
          );
        } catch (releaseError) {
          if (!(releaseError instanceof StaleArtifactCleanupLeaseError)) {
            throw releaseError;
          }
        }
        result.failed += 1;
      }
    }
    return result;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("Unknown private artifact cleanup failure", { cause: value });
}
