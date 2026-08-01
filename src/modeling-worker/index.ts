import { pathToFileURL } from "node:url";

import { getModelingServiceClient } from "@/server/modeling/cad-client";
import { createModelingPlan } from "@/server/modeling/planner";
import { modelingRepository } from "@/server/modeling/repository";
import { getObjectStorage } from "@/server/providers";

import { ModelingJobProcessor } from "./processor";
import { ModelingArtifactCleaner } from "./artifact-cleaner";
import { PostgresModelingWorkerRepository } from "./repository";
import { ModelingWorker } from "./worker";

export * from "./processor";
export * from "./artifact-cleaner";
export * from "./repository";
export * from "./types";
export * from "./worker";

export function createModelingWorker(): ModelingWorker {
  const repository = new PostgresModelingWorkerRepository();
  const objectStorage = getObjectStorage();
  const processor = new ModelingJobProcessor({
    repository,
    planStore: modelingRepository,
    planner: createModelingPlan,
    cadClient: getModelingServiceClient(),
    objectStorage
  });
  const artifactCleaner = new ModelingArtifactCleaner({
    repository,
    objectStorage,
    leaseMs: positiveInteger(
      process.env.MODELING_ARTIFACT_CLEANUP_LEASE_MS,
      60_000
    ),
    retryDelayMs: positiveInteger(
      process.env.MODELING_ARTIFACT_CLEANUP_RETRY_MS,
      60_000
    ),
    batchSize: positiveInteger(
      process.env.MODELING_ARTIFACT_CLEANUP_BATCH_SIZE,
      20
    )
  });
  return new ModelingWorker({
    repository,
    processor,
    artifactCleaner,
    pollIntervalMs: positiveInteger(
      process.env.MODELING_WORKER_POLL_INTERVAL_MS,
      1_000
    ),
    leaseMs: positiveInteger(process.env.MODELING_WORKER_LEASE_MS, 60_000),
    heartbeatMs: positiveInteger(
      process.env.MODELING_WORKER_HEARTBEAT_MS,
      15_000
    ),
    artifactCleanupIntervalMs: positiveInteger(
      process.env.MODELING_ARTIFACT_CLEANUP_INTERVAL_MS,
      60_000
    )
  });
}

export async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await createModelingWorker().runUntilStopped(controller.signal);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const executedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (executedPath === import.meta.url) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unknown modeling worker error";
    console.error(`[openvac-modeling-worker] ${message}`);
    process.exitCode = 1;
  });
}
