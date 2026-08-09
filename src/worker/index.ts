import { pathToFileURL } from "node:url";

import {
  getDocumentParser,
  getEmbeddingProvider,
  getObjectStorage
} from "@/server/providers";

import { KnowledgeIngestionWorker } from "./knowledge-ingestion";
import { PostgresKnowledgeIngestionRepository } from "./postgres-repository";
import {
  ChatStorageWorker,
  PostgresChatStorageWorkerRepository
} from "./chat-storage";

export * from "./chat-storage";
export * from "./knowledge-ingestion";
export * from "./postgres-repository";
export * from "./types";

export function createKnowledgeWorker(): KnowledgeIngestionWorker {
  return new KnowledgeIngestionWorker({
    repository: new PostgresKnowledgeIngestionRepository(),
    parser: getDocumentParser(),
    embeddings: getEmbeddingProvider(),
    objectStorage: getObjectStorage(),
    concurrency: parsePositiveInteger(process.env.WORKER_CONCURRENCY, 2),
    leaseHeartbeatMs: parsePositiveInteger(
      process.env.WORKER_LEASE_HEARTBEAT_MS,
      60_000
    ),
    maxOcrPolls: parsePositiveInteger(process.env.WORKER_MAX_OCR_POLLS, 240),
    maxOcrAgeMs: parsePositiveInteger(
      process.env.WORKER_MAX_OCR_AGE_MS,
      2 * 60 * 60 * 1_000
    ),
    allowedDocumentHosts: parseAllowedHosts(
      process.env.ALIBABA_OCR_ALLOWED_DOCUMENT_HOSTS
    )
  });
}

export function createChatStorageWorker(): ChatStorageWorker {
  return new ChatStorageWorker({
    repository: new PostgresChatStorageWorkerRepository(),
    parser: getDocumentParser(),
    objectStorage: getObjectStorage(),
    concurrency: parsePositiveInteger(
      process.env.CHAT_STORAGE_WORKER_CONCURRENCY,
      1
    ),
    leaseHeartbeatMs: parsePositiveInteger(
      process.env.CHAT_STORAGE_WORKER_LEASE_HEARTBEAT_MS,
      60_000
    ),
    maxParserPolls: parsePositiveInteger(
      process.env.CHAT_STORAGE_WORKER_MAX_PARSER_POLLS,
      240
    ),
    maxParserAgeMs: parsePositiveInteger(
      process.env.CHAT_STORAGE_WORKER_MAX_PARSER_AGE_MS,
      2 * 60 * 60 * 1_000
    )
  });
}

export async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await Promise.all([
      createKnowledgeWorker().runUntilStopped(controller.signal),
      createChatStorageWorker().runUntilStopped(controller.signal)
    ]);
  } finally {
    controller.abort();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number
): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

const executedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (executedPath === import.meta.url) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unknown worker error";
    console.error(`[openvac-worker] ${message}`);
    process.exitCode = 1;
  });
}
