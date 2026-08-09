import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import {
  agentRuns,
  chatArtifactFiles,
  chatArtifacts,
  chatStorageAccounts,
  chatStorageDeletionJobs,
  conversations,
  conversationTurns,
  messages,
  quotaBucket,
  quotaLedger,
  user as users
} from "@/server/db/schema";
import { PostgresQuotaRepository } from "@/server/quota/repository";
import { QuotaService } from "@/server/quota/service";

import { recoverStaleAgentRuns } from "./retention";

const describeDatabase =
  process.env.RUN_DATABASE_TESTS === "true" ? describe : describe.skip;

const userIds: string[] = [];
const objectKeys: string[] = [];

afterEach(async () => {
  if (objectKeys.length > 0) {
    await db
      .delete(chatStorageDeletionJobs)
      .where(inArray(chatStorageDeletionJobs.objectKey, objectKeys));
  }
  if (userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, userIds));
    await db.delete(quotaBucket).where(inArray(quotaBucket.scopeKey, userIds));
  }
  userIds.length = 0;
  objectKeys.length = 0;
});

describeDatabase("durable agent run recovery", () => {
  it("continues after one settlement fault, releases artifacts, and retries to a verified release", async () => {
    const userId = `run-recovery-${randomUUID()}`;
    userIds.push(userId);
    await db.insert(users).values({
      id: userId,
      name: "Run recovery integration user",
      email: `${userId}@example.test`,
      emailVerified: true
    });

    const quota = new QuotaService(
      new PostgresQuotaRepository(),
      {
        answerDaily: 20,
        webSearchUserDaily: 5,
        webSearchGlobalDaily: 500,
        modelAttemptUserDaily: 30,
        modelAttemptGlobalDaily: 1_000
      },
      async () => 0
    );
    const goodClientRequestId = randomUUID();
    const goodReservation = await quota.reserve({
      userId,
      clientRequestId: goodClientRequestId,
      resource: "answer"
    });
    const badClientRequestId = randomUUID();
    const bad = await createStaleRun({
      userId,
      clientRequestId: badClientRequestId,
      answerQuotaLeaseId: randomUUID(),
      updatedAt: new Date(Date.now() - 20 * 60_000)
    });
    const good = await createStaleRun({
      userId,
      clientRequestId: goodClientRequestId,
      answerQuotaLeaseId: goodReservation.leaseId,
      updatedAt: new Date(Date.now() - 10 * 60_000)
    });

    await db.insert(chatStorageAccounts).values({
      userId,
      usedBytes: 100,
      reservedBytes: 50
    });
    const artifactId = randomUUID();
    await db.insert(chatArtifacts).values({
      id: artifactId,
      userId,
      conversationId: good.conversationId,
      messageId: good.assistantMessageId,
      sourceTurnId: good.turnId,
      kind: "diagnosis_report",
      title: "Interrupted report",
      status: "generating",
      spec: {
        schemaVersion: "openvac.artifact.v1",
        formats: ["pdf", "md"]
      }
    });
    const committedKey = artifactObjectKey(good.conversationId, artifactId);
    const reservedKey = artifactObjectKey(good.conversationId, artifactId);
    objectKeys.push(committedKey, reservedKey);
    await db.insert(chatArtifactFiles).values([
      {
        artifactId,
        format: "pdf",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
        sha256: "a".repeat(64),
        objectKey: committedKey,
        quotaState: "committed"
      },
      {
        artifactId,
        format: "md",
        filename: "report.md",
        mimeType: "text/markdown",
        sizeBytes: 50,
        sha256: "b".repeat(64),
        objectKey: reservedKey,
        quotaState: "reserved"
      }
    ]);

    const first = await recoverStaleAgentRuns({ userId });
    expect(first).toEqual({ recovered: 1, pending: 1 });

    const [goodRun] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, good.runId));
    expect(goodRun).toMatchObject({
      status: "failed",
      answerQuotaStatus: "released",
      settlementStatus: "completed",
      errorCode: "PROCESS_INTERRUPTED"
    });
    expect(
      await db
        .select()
        .from(chatArtifactFiles)
        .where(eq(chatArtifactFiles.artifactId, artifactId))
    ).toHaveLength(0);
    const [storage] = await db
      .select()
      .from(chatStorageAccounts)
      .where(eq(chatStorageAccounts.userId, userId));
    expect(storage).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    const jobs = await db
      .select()
      .from(chatStorageDeletionJobs)
      .where(inArray(chatStorageDeletionJobs.objectKey, objectKeys));
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.status === "queued")).toBe(true);

    const retryReservation = await quota.reserve({
      userId,
      clientRequestId: badClientRequestId,
      resource: "answer"
    });
    await db
      .update(agentRuns)
      .set({
        answerQuotaLeaseId: retryReservation.leaseId,
        updatedAt: new Date(Date.now() - 10 * 60_000)
      })
      .where(eq(agentRuns.id, bad.runId));

    await expect(recoverStaleAgentRuns({ userId })).resolves.toEqual({
      recovered: 1,
      pending: 0
    });
    const [badRun] = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, bad.runId));
    expect(badRun).toMatchObject({
      status: "failed",
      answerQuotaStatus: "released",
      settlementStatus: "completed"
    });
    const ledgers = await db
      .select({ status: quotaLedger.status })
      .from(quotaLedger)
      .where(eq(quotaLedger.actorUserId, userId));
    expect(ledgers.every((ledger) => ledger.status !== "reserved")).toBe(true);

    await expect(recoverStaleAgentRuns({ userId })).resolves.toEqual({
      recovered: 0,
      pending: 0
    });
    expect(
      await db
        .select()
        .from(chatStorageDeletionJobs)
        .where(inArray(chatStorageDeletionJobs.objectKey, objectKeys))
    ).toHaveLength(2);
  });
});

async function createStaleRun(input: {
  userId: string;
  clientRequestId: string;
  answerQuotaLeaseId: string;
  updatedAt: Date;
}) {
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const turnId = randomUUID();
  const runId = randomUUID();
  await db.insert(conversations).values({
    id: conversationId,
    userId: input.userId,
    title: "Interrupted run"
  });
  await db.insert(messages).values([
    {
      id: userMessageId,
      conversationId,
      userId: input.userId,
      sequence: 1,
      role: "user",
      status: "completed",
      content: "Create a report"
    },
    {
      id: assistantMessageId,
      conversationId,
      userId: input.userId,
      sequence: 2,
      role: "assistant",
      status: "streaming",
      content: ""
    }
  ]);
  await db.insert(conversationTurns).values({
    id: turnId,
    conversationId,
    userMessageId,
    ordinal: 1
  });
  await db.insert(agentRuns).values({
    id: runId,
    turnId,
    userId: input.userId,
    assistantMessageId,
    clientRequestId: input.clientRequestId,
    version: 1,
    model: "test-model",
    status: "running",
    answerQuotaLeaseId: input.answerQuotaLeaseId,
    answerQuotaStatus: "reserved",
    settlementStatus: "pending",
    startedAt: input.updatedAt,
    updatedAt: input.updatedAt
  });
  return { conversationId, userMessageId, assistantMessageId, turnId, runId };
}

function artifactObjectKey(conversationId: string, artifactId: string) {
  return (
    `private/chat-artifacts/abcdef0123456789abcdef01/${conversationId}/` +
    `${artifactId}/${randomUUID()}/report.bin`
  );
}
