import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sqlClient } from "@/server/db";

import {
  PostgresKnowledgeIngestionRepository,
  type WorkerSql
} from "./postgres-repository";
import type { KnowledgeIngestionJob } from "./types";

const describeDatabase =
  process.env.RUN_DATABASE_TESTS === "true" ? describe : describe.skip;

describeDatabase(
  "knowledge worker failure persistence PostgreSQL integration",
  () => {
    it("requeues a retryable failure without an ambiguous operation_status parameter", async () => {
      const taskId = randomUUID();
      const leaseToken = randomUUID();
      const workerId = `worker-${randomUUID()}`;
      const retryAt = new Date(Date.now() + 60_000);
      const job: KnowledgeIngestionJob = {
        id: taskId,
        workerId,
        leaseToken,
        attempts: 1,
        maxAttempts: 3,
        payload: {
          stage: "embedding_pending",
          documentId: randomUUID(),
          versionId: randomUUID()
        }
      };

      try {
        await sqlClient.unsafe(
          `INSERT INTO background_task (
           id, type, status, payload, attempts, max_attempts, run_at,
           locked_at, locked_by, lease_token
         ) VALUES (
           $1, 'knowledge_ingestion', 'running', $2::jsonb, $3, $4, NOW(),
           NOW(), $5, $6::uuid
         )`,
          [
            taskId,
            JSON.stringify(job.payload),
            job.attempts,
            job.maxAttempts,
            workerId,
            leaseToken
          ]
        );

        const repository = new PostgresKnowledgeIngestionRepository(
          sqlClient as unknown as WorkerSql
        );
        await repository.markFailed(
          job,
          new Error("embedding failed"),
          retryAt
        );

        const [stored] = await sqlClient.unsafe(
          `SELECT status, last_error, locked_by, lease_token, completed_at
         FROM background_task
         WHERE id = $1`,
          [taskId]
        );
        expect(stored).toMatchObject({
          status: "queued",
          last_error: "Error: embedding failed",
          locked_by: null,
          lease_token: null,
          completed_at: null
        });
      } finally {
        await sqlClient.unsafe("DELETE FROM background_task WHERE id = $1", [
          taskId
        ]);
      }
    });

    it("requeues an OCR submission with a serializable retry timestamp", async () => {
      const taskId = randomUUID();
      const leaseToken = randomUUID();
      const workerId = `worker-${randomUUID()}`;
      const retryAt = new Date(Date.now() + 60_000);
      const job: KnowledgeIngestionJob = {
        id: taskId,
        workerId,
        leaseToken,
        attempts: 1,
        maxAttempts: 3,
        payload: {
          stage: "ocr_pending",
          documentId: randomUUID(),
          versionId: randomUUID()
        }
      };

      try {
        await insertRunningTask(job);

        const repository = new PostgresKnowledgeIngestionRepository(
          sqlClient as unknown as WorkerSql
        );
        await repository.markOcrSubmitted(job, "parser-job-1", retryAt);

        const [stored] = await sqlClient.unsafe(
          `SELECT status, payload, locked_by, lease_token
         FROM background_task
         WHERE id = $1`,
          [taskId]
        );
        expect(stored).toMatchObject({
          status: "queued",
          locked_by: null,
          lease_token: null,
          payload: {
            stage: "ocr_processing",
            parserJobId: "parser-job-1"
          }
        });
      } finally {
        await sqlClient.unsafe("DELETE FROM background_task WHERE id = $1", [
          taskId
        ]);
      }
    });
  }
);

async function insertRunningTask(job: KnowledgeIngestionJob) {
  await sqlClient.unsafe(
    `INSERT INTO background_task (
       id, type, status, payload, attempts, max_attempts, run_at,
       locked_at, locked_by, lease_token
     ) VALUES (
       $1, 'knowledge_ingestion', 'running', $2::jsonb, $3, $4, NOW(),
       NOW(), $5, $6::uuid
     )`,
    [
      job.id,
      JSON.stringify(job.payload),
      job.attempts,
      job.maxAttempts,
      job.workerId,
      job.leaseToken
    ]
  );
}
