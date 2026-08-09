import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { ApiError } from "@/server/api/errors";
import { prepareUserDeletion } from "@/server/auth/account-cleanup";
import { db, sqlClient } from "@/server/db";
import {
  agentRuns,
  chatAttachments,
  chatStorageAccounts,
  chatStorageDeletionJobs,
  conversations,
  conversationTurns,
  messages,
  user as users
} from "@/server/db/schema";

import { enqueueConversationStorageDeletion } from "./deletion";
import { PostgresChatArtifactStorageRepository } from "./artifact-storage";
import { PostgresChatAttachmentRepository } from "./repository";
import { PostgresChatStorageWorkerRepository } from "@/worker/chat-storage";

const describeDatabase =
  process.env.RUN_DATABASE_TESTS === "true" ? describe : describe.skip;

describeDatabase("chat attachment repository integration", () => {
  const userIds: string[] = [];
  const objectKeys: string[] = [];

  afterEach(async () => {
    if (objectKeys.length > 0) {
      await db
        .delete(chatStorageDeletionJobs)
        .where(inArray(chatStorageDeletionJobs.objectKey, objectKeys));
    }
    for (const userId of userIds) {
      await db.delete(users).where(eq(users.id, userId));
    }
    userIds.length = 0;
    objectKeys.length = 0;
  });

  it("enforces ownership, atomically moves reserved quota, binds, and queues deletion", async () => {
    const ownerId = `attachment-owner-${randomUUID()}`;
    const otherId = `attachment-other-${randomUUID()}`;
    userIds.push(ownerId, otherId);
    await db.insert(users).values([
      {
        id: ownerId,
        name: "Owner",
        email: `${ownerId}@example.test`
      },
      {
        id: otherId,
        name: "Other",
        email: `${otherId}@example.test`
      }
    ]);
    const conversationId = randomUUID();
    await db.insert(conversations).values({
      id: conversationId,
      userId: ownerId,
      title: "Attachment integration"
    });
    const attachmentId = randomUUID();
    const objectKey =
      `private/chat-attachments/abcdef0123456789abcdef01/${conversationId}/` +
      `${attachmentId}/manual.pdf`;
    objectKeys.push(objectKey);
    const repository = new PostgresChatAttachmentRepository(sqlClient as never);

    await repository.initiate({
      id: attachmentId,
      userId: ownerId,
      conversationId,
      kind: "document",
      filename: "manual.pdf",
      mimeType: "application/pdf",
      declaredSizeBytes: 1_024,
      sha256: "a".repeat(64),
      objectKey,
      uploadExpiresAt: new Date(Date.now() + 15 * 60 * 1_000),
      orphanExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000)
    });

    const [reserved] = await db
      .select()
      .from(chatStorageAccounts)
      .where(eq(chatStorageAccounts.userId, ownerId));
    expect(reserved).toMatchObject({ usedBytes: 0, reservedBytes: 1_024 });
    await expect(
      repository.beginCompletion(attachmentId, otherId)
    ).rejects.toBeInstanceOf(ApiError);

    await repository.beginCompletion(attachmentId, ownerId);
    const completed = await repository.completeVerified({
      attachmentId,
      userId: ownerId,
      sizeBytes: 1_024,
      etag: "etag"
    });
    expect(completed).toMatchObject({
      status: "processing",
      parseStatus: "queued",
      sizeBytes: 1_024
    });
    const [committed] = await db
      .select()
      .from(chatStorageAccounts)
      .where(eq(chatStorageAccounts.userId, ownerId));
    expect(committed).toMatchObject({ usedBytes: 1_024, reservedBytes: 0 });
    const workerRepository = new PostgresChatStorageWorkerRepository(
      sqlClient as never
    );
    expect(
      await workerRepository.claimAttachmentParse("worker-before-bind")
    ).toBeNull();

    const messageId = randomUUID();
    await db.insert(messages).values({
      id: messageId,
      conversationId,
      userId: ownerId,
      sequence: 1,
      role: "user",
      content: "See attachment"
    });
    const bound = await repository.bindToMessage({
      attachmentIds: [attachmentId],
      conversationId,
      messageId,
      userId: ownerId
    });
    expect(bound[0]?.messageId).toBe(messageId);
    expect(
      await workerRepository.claimAttachmentParse("worker-after-bind")
    ).toMatchObject({ id: attachmentId, workerId: "worker-after-bind" });

    const deletion = await db.transaction((transaction) =>
      enqueueConversationStorageDeletion(transaction, {
        userId: ownerId,
        conversationIds: [conversationId],
        deleteMetadata: true
      })
    );
    expect(deletion).toMatchObject({
      attachmentsDeleted: 1,
      objectsQueued: 1,
      committedBytesReleased: 1_024
    });
    expect(
      await db
        .select()
        .from(chatAttachments)
        .where(eq(chatAttachments.id, attachmentId))
    ).toHaveLength(0);
    const [released] = await db
      .select()
      .from(chatStorageAccounts)
      .where(eq(chatStorageAccounts.userId, ownerId));
    expect(released).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    const [queued] = await db
      .select()
      .from(chatStorageDeletionJobs)
      .where(eq(chatStorageDeletionJobs.objectKey, objectKey));
    expect(queued).toMatchObject({
      userId: ownerId,
      objectType: "attachment",
      status: "queued"
    });
  });

  it("queues private objects before account cascade and retains anonymous cleanup work", async () => {
    const ownerId = `attachment-delete-${randomUUID()}`;
    userIds.push(ownerId);
    await db.insert(users).values({
      id: ownerId,
      name: "Deleting Owner",
      email: `${ownerId}@example.test`
    });
    const conversationId = randomUUID();
    await db.insert(conversations).values({
      id: conversationId,
      userId: ownerId,
      title: "Delete account"
    });
    const attachmentId = randomUUID();
    const objectKey =
      `private/chat-attachments/abcdef0123456789abcdef01/${conversationId}/` +
      `${attachmentId}/manual.pdf`;
    objectKeys.push(objectKey);
    const repository = new PostgresChatAttachmentRepository(sqlClient as never);
    await repository.initiate({
      id: attachmentId,
      userId: ownerId,
      conversationId,
      kind: "document",
      filename: "manual.pdf",
      mimeType: "application/pdf",
      declaredSizeBytes: 100,
      sha256: "b".repeat(64),
      objectKey,
      uploadExpiresAt: new Date(Date.now() + 15 * 60 * 1_000),
      orphanExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000)
    });

    await prepareUserDeletion(ownerId);
    const [beforeCascade] = await db
      .select()
      .from(chatStorageDeletionJobs)
      .where(eq(chatStorageDeletionJobs.objectKey, objectKey));
    expect(beforeCascade).toMatchObject({ userId: ownerId, status: "queued" });

    await db.delete(users).where(eq(users.id, ownerId));
    const [afterCascade] = await db
      .select()
      .from(chatStorageDeletionJobs)
      .where(eq(chatStorageDeletionJobs.objectKey, objectKey));
    expect(afterCascade).toMatchObject({ userId: null, status: "queued" });
    userIds.splice(userIds.indexOf(ownerId), 1);
  });

  it("shares the same locked 500 MiB quota with artifact files", async () => {
    const ownerId = `artifact-owner-${randomUUID()}`;
    userIds.push(ownerId);
    await db.insert(users).values({
      id: ownerId,
      name: "Artifact Owner",
      email: `${ownerId}@example.test`
    });
    const conversationId = randomUUID();
    await db.insert(conversations).values({
      id: conversationId,
      userId: ownerId,
      title: "Artifact quota"
    });
    const messageId = randomUUID();
    await db.insert(messages).values({
      id: messageId,
      conversationId,
      userId: ownerId,
      sequence: 1,
      role: "user",
      content: "Create report"
    });
    const sourceTurnId = randomUUID();
    await db.insert(conversationTurns).values({
      id: sourceTurnId,
      conversationId,
      userMessageId: messageId,
      ordinal: 1
    });
    const assistantMessageId = randomUUID();
    await db.insert(messages).values({
      id: assistantMessageId,
      conversationId,
      userId: ownerId,
      sequence: 2,
      role: "assistant",
      content: ""
    });
    const runId = randomUUID();
    await db.insert(agentRuns).values({
      id: runId,
      turnId: sourceTurnId,
      userId: ownerId,
      assistantMessageId,
      clientRequestId: randomUUID(),
      version: 1,
      model: "test-model",
      status: "running"
    });
    const artifactId = randomUUID();
    const repository = new PostgresChatArtifactStorageRepository(
      sqlClient as never
    );
    await repository.createArtifact({
      artifactId,
      userId: ownerId,
      conversationId,
      runId,
      assistantMessageId,
      spec: {
        schemaVersion: "openvac.artifact.v1",
        kind: "diagnosis_report",
        title: "Diagnosis",
        formats: ["pdf"],
        summary: "Summary",
        sections: [],
        tables: [],
        sourceTurnId
      }
    });
    await db.insert(chatStorageAccounts).values({
      userId: ownerId,
      usedBytes: 500 * 1024 * 1024 - 10
    });
    const fileId = randomUUID();
    const objectKey =
      `private/chat-artifacts/abcdef0123456789abcdef01/${conversationId}/` +
      `${artifactId}/${fileId}/diagnosis.pdf`;
    await expect(
      repository.reserveFile({
        fileId,
        artifactId,
        userId: ownerId,
        conversationId,
        format: "pdf",
        filename: "diagnosis.pdf",
        mimeType: "application/pdf",
        sizeBytes: 11,
        sha256: "c".repeat(64),
        objectKey
      })
    ).rejects.toMatchObject({ code: "CHAT_STORAGE_QUOTA_EXCEEDED" });

    await db
      .update(chatStorageAccounts)
      .set({ usedBytes: 0 })
      .where(eq(chatStorageAccounts.userId, ownerId));
    await repository.reserveFile({
      fileId,
      artifactId,
      userId: ownerId,
      conversationId,
      format: "pdf",
      filename: "diagnosis.pdf",
      mimeType: "application/pdf",
      sizeBytes: 200,
      sha256: "c".repeat(64),
      objectKey
    });
    const [reserved] = await db
      .select()
      .from(chatStorageAccounts)
      .where(eq(chatStorageAccounts.userId, ownerId));
    expect(reserved).toMatchObject({ usedBytes: 0, reservedBytes: 200 });
    await repository.commitFile({ fileId, artifactId, userId: ownerId });
    const [committed] = await db
      .select()
      .from(chatStorageAccounts)
      .where(eq(chatStorageAccounts.userId, ownerId));
    expect(committed).toMatchObject({ usedBytes: 200, reservedBytes: 0 });
  });
});
