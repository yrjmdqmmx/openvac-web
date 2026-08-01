import { randomUUID } from "node:crypto";

import {
  ModelingCancellationRequestedError,
  StaleModelingLeaseError
} from "./repository";
import { ModelingCancellationAfterCompletionError } from "./processor";
import type {
  LeasedModelingJob,
  ModelingWorkerOutcome,
  ModelingWorkerRepository
} from "./types";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

export interface ModelingWorkerOptions {
  repository: ModelingWorkerRepository;
  processor: ModelingJobProcessorPort;
  artifactCleaner?: ModelingArtifactCleanerPort;
  workerId?: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  artifactCleanupIntervalMs?: number;
  now?: () => number;
}

export interface ModelingJobProcessorPort {
  process(job: LeasedModelingJob, signal: AbortSignal): Promise<void>;
}

export interface ModelingArtifactCleanerPort {
  cleanupBatch(signal?: AbortSignal): Promise<unknown>;
}

export class ModelingWorker {
  private readonly repository: ModelingWorkerRepository;
  private readonly processor: ModelingJobProcessorPort;
  private readonly artifactCleaner?: ModelingArtifactCleanerPort;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly artifactCleanupIntervalMs: number;
  private readonly now: () => number;
  private nextArtifactCleanupAt = 0;

  constructor(options: ModelingWorkerOptions) {
    this.repository = options.repository;
    this.processor = options.processor;
    this.artifactCleaner = options.artifactCleaner;
    this.workerId = options.workerId ?? `openvac-modeling-${randomUUID()}`;
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs"
    );
    this.leaseMs = positiveInteger(
      options.leaseMs ?? DEFAULT_LEASE_MS,
      "leaseMs"
    );
    this.heartbeatMs = positiveInteger(
      options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      "heartbeatMs"
    );
    this.artifactCleanupIntervalMs = positiveInteger(
      options.artifactCleanupIntervalMs ?? 60_000,
      "artifactCleanupIntervalMs"
    );
    this.now = options.now ?? Date.now;
    if (this.heartbeatMs >= this.leaseMs) {
      throw new TypeError("heartbeatMs must be shorter than leaseMs.");
    }
  }

  /**
   * There is intentionally no local concurrency option. Combined with the
   * repository's advisory-lock claim gate, every deployment has global CAD
   * kernel concurrency one.
   */
  async runOnce(signal?: AbortSignal): Promise<ModelingWorkerOutcome> {
    if (signal?.aborted) {
      return "interrupted";
    }
    const now = this.now();
    if (this.artifactCleaner && now >= this.nextArtifactCleanupAt) {
      this.nextArtifactCleanupAt = now + this.artifactCleanupIntervalMs;
      await this.artifactCleaner.cleanupBatch(signal);
      if (signal?.aborted) return "interrupted";
    }
    const job = await this.repository.claimNext(this.workerId, this.leaseMs);
    if (!job) {
      return "idle";
    }
    if (job.cancelRequestedAt) {
      try {
        await this.repository.markCancelled(job, "用户已请求取消任务。");
      } catch (error) {
        if (!(error instanceof StaleModelingLeaseError)) {
          throw error;
        }
      }
      return "cancelled";
    }

    try {
      await this.withLeaseHeartbeat(job, signal);
      return "completed";
    } catch (cause) {
      const error = asError(cause);
      if (error instanceof ModelingCancellationAfterCompletionError) {
        return "cancelled";
      }
      // Providers may wrap AbortError, so the process-level stop signal is the
      // authoritative reason to leave this lease recoverable instead of
      // turning a graceful shutdown into a terminal task failure.
      if (signal?.aborted) {
        return "interrupted";
      }
      if (error instanceof ModelingWorkerStoppingError) {
        return "interrupted";
      }
      if (error instanceof StaleModelingLeaseError) {
        return "interrupted";
      }
      if (error instanceof ModelingCancellationRequestedError) {
        try {
          await this.repository.markCancelled(job, "用户已请求取消任务。");
        } catch (markError) {
          if (!(markError instanceof StaleModelingLeaseError)) {
            throw markError;
          }
        }
        return "cancelled";
      }
      try {
        return await this.repository.markFailed(job, error);
      } catch (markError) {
        if (markError instanceof StaleModelingLeaseError) {
          return "interrupted";
        }
        throw markError;
      }
    }
  }

  async runUntilStopped(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const outcome = await this.runOnce(signal);
      if (outcome === "interrupted" && signal.aborted) {
        return;
      }
      if (outcome === "idle") {
        await abortableDelay(this.pollIntervalMs, signal);
      }
    }
  }

  private async withLeaseHeartbeat(
    job: LeasedModelingJob,
    outerSignal?: AbortSignal
  ): Promise<void> {
    const operationController = new AbortController();
    const heartbeatStop = new AbortController();
    const stopOperation = () =>
      operationController.abort(new ModelingWorkerStoppingError());
    outerSignal?.addEventListener("abort", stopOperation, { once: true });

    let operationSettled = false;
    const operation = this.processor
      .process(job, operationController.signal)
      .finally(() => {
        operationSettled = true;
      });
    const heartbeat = this.heartbeatLoop(
      job,
      operationController,
      heartbeatStop.signal
    ).catch((error: unknown) => {
      // A successful terminal transition clears the lease. Ignore a renewal
      // that happened to finish immediately after that commit.
      if (operationSettled && error instanceof StaleModelingLeaseError) {
        return never();
      }
      operationController.abort(error);
      throw error;
    });

    try {
      await Promise.race([operation, heartbeat]);
    } finally {
      heartbeatStop.abort();
      outerSignal?.removeEventListener("abort", stopOperation);
      // A heartbeat can observe cancellation or a stale lease before an OSS
      // call and its compensating cleanup have settled. Do not return to the
      // claim loop (or write a terminal state) while that processor attempt is
      // still running in the background.
      await Promise.allSettled([operation, heartbeat]);
    }
  }

  private async heartbeatLoop(
    job: LeasedModelingJob,
    operationController: AbortController,
    stopSignal: AbortSignal
  ): Promise<never> {
    while (await abortableDelay(this.heartbeatMs, stopSignal)) {
      const renewal = await this.repository.renewLease(job, this.leaseMs);
      if (renewal === "cancel_requested") {
        const error = new ModelingCancellationRequestedError(job.id);
        operationController.abort(error);
        throw error;
      }
    }
    return never();
  }
}

export class ModelingWorkerStoppingError extends Error {
  constructor() {
    super("Modeling worker is stopping; the lease will be recovered.");
    this.name = "ModelingWorkerStoppingError";
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function never(): never {
  throw new ModelingWorkerStoppingError();
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("Unknown modeling worker failure", { cause: value });
}
