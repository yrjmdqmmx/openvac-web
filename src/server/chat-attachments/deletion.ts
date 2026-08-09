import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  chatArtifactFiles,
  chatArtifacts,
  chatAttachments,
  chatStorageAccounts,
  chatStorageDeletionJobs
} from "@/server/db/schema";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ChatStorageDeletionSummary = {
  attachmentsDeleted: number;
  artifactsDeleted: number;
  objectsQueued: number;
  committedBytesReleased: number;
  reservedBytesReleased: number;
};

export async function enqueueConversationStorageDeletion(
  transaction: Transaction,
  input: {
    userId: string;
    conversationIds?: string[];
    deleteMetadata: boolean;
  }
): Promise<ChatStorageDeletionSummary> {
  const conversationFilter = input.conversationIds?.length
    ? inArray(chatAttachments.conversationId, input.conversationIds)
    : undefined;
  const attachments = await transaction
    .select({
      id: chatAttachments.id,
      objectKey: chatAttachments.objectKey,
      quotaState: chatAttachments.quotaState,
      declaredSizeBytes: chatAttachments.declaredSizeBytes,
      sizeBytes: chatAttachments.sizeBytes,
      uploadExpiresAt: chatAttachments.uploadExpiresAt
    })
    .from(chatAttachments)
    .where(and(eq(chatAttachments.userId, input.userId), conversationFilter))
    .for("update");

  const artifactConversationFilter = input.conversationIds?.length
    ? inArray(chatArtifacts.conversationId, input.conversationIds)
    : undefined;
  const artifacts = await transaction
    .select({ id: chatArtifacts.id })
    .from(chatArtifacts)
    .where(
      and(eq(chatArtifacts.userId, input.userId), artifactConversationFilter)
    )
    .for("update");
  const artifactFiles = await transaction
    .select({
      id: chatArtifactFiles.id,
      artifactId: chatArtifactFiles.artifactId,
      objectKey: chatArtifactFiles.objectKey,
      quotaState: chatArtifactFiles.quotaState,
      sizeBytes: chatArtifactFiles.sizeBytes,
      createdAt: chatArtifactFiles.createdAt
    })
    .from(chatArtifactFiles)
    .innerJoin(
      chatArtifacts,
      eq(chatArtifactFiles.artifactId, chatArtifacts.id)
    )
    .where(
      and(eq(chatArtifacts.userId, input.userId), artifactConversationFilter)
    )
    .for("update", { of: chatArtifactFiles });

  const jobs: Array<typeof chatStorageDeletionJobs.$inferInsert> = [
    ...attachments.map((attachment) => ({
      userId: input.userId,
      objectType: "attachment" as const,
      sourceId: attachment.id,
      objectKey: attachment.objectKey,
      runAt:
        attachment.quotaState === "reserved"
          ? new Date(attachment.uploadExpiresAt.getTime() + 60_000)
          : new Date()
    })),
    ...artifactFiles.map((file) => ({
      userId: input.userId,
      objectType: "artifact" as const,
      sourceId: file.id,
      objectKey: file.objectKey,
      runAt:
        file.quotaState === "reserved"
          ? new Date(file.createdAt.getTime() + 60 * 60_000)
          : new Date()
    }))
  ];
  if (jobs.length > 0) {
    await transaction
      .insert(chatStorageDeletionJobs)
      .values(jobs)
      .onConflictDoNothing({ target: chatStorageDeletionJobs.objectKey });
  }

  const committedBytesReleased =
    attachments.reduce(
      (total, item) =>
        total +
        (item.quotaState === "committed" ? Number(item.sizeBytes ?? 0) : 0),
      0
    ) +
    artifactFiles.reduce(
      (total, item) =>
        total + (item.quotaState === "committed" ? Number(item.sizeBytes) : 0),
      0
    );
  const reservedBytesReleased =
    attachments.reduce(
      (total, item) =>
        total +
        (item.quotaState === "reserved" ? Number(item.declaredSizeBytes) : 0),
      0
    ) +
    artifactFiles.reduce(
      (total, item) =>
        total + (item.quotaState === "reserved" ? Number(item.sizeBytes) : 0),
      0
    );

  if (
    input.deleteMetadata &&
    (attachments.length || artifacts.length || artifactFiles.length)
  ) {
    await transaction
      .update(chatStorageAccounts)
      .set({
        usedBytes: sql`greatest(${chatStorageAccounts.usedBytes} - ${committedBytesReleased}, 0)`,
        reservedBytes: sql`greatest(${chatStorageAccounts.reservedBytes} - ${reservedBytesReleased}, 0)`,
        updatedAt: new Date()
      })
      .where(eq(chatStorageAccounts.userId, input.userId));

    if (attachments.length > 0) {
      await transaction.delete(chatAttachments).where(
        inArray(
          chatAttachments.id,
          attachments.map((item) => item.id)
        )
      );
    }
    const artifactIds = artifacts.map((item) => item.id);
    if (artifactIds.length > 0) {
      await transaction
        .delete(chatArtifacts)
        .where(inArray(chatArtifacts.id, artifactIds));
    }
  }

  return {
    attachmentsDeleted: input.deleteMetadata ? attachments.length : 0,
    artifactsDeleted: input.deleteMetadata ? artifacts.length : 0,
    objectsQueued: jobs.length,
    committedBytesReleased: input.deleteMetadata ? committedBytesReleased : 0,
    reservedBytesReleased: input.deleteMetadata ? reservedBytesReleased : 0
  };
}
