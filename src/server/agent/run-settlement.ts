import { sql } from "drizzle-orm";

import type { QuotaTransaction } from "@/server/quota/repository";
import {
  commitQuotaInTransaction,
  releaseQuotaInTransaction
} from "@/server/quota/repository";

export type AgentRunTerminalStatus =
  "completed" | "incomplete" | "failed" | "cancelled";

export async function settleAnswerQuotaInTransaction(
  transaction: QuotaTransaction,
  input: {
    leaseId: string | null;
    userId: string;
    status: AgentRunTerminalStatus;
    reason: string;
  }
): Promise<"committed" | "released" | null> {
  if (!input.leaseId) return null;

  const expected = input.status === "completed" ? "committed" : "released";
  const quota =
    expected === "committed"
      ? await commitQuotaInTransaction(transaction, {
          leaseId: input.leaseId,
          actorUserId: input.userId
        })
      : await releaseQuotaInTransaction(transaction, {
          leaseId: input.leaseId,
          actorUserId: input.userId,
          reason: input.reason
        });

  if (quota.resource !== "answer" || quota.status !== expected) {
    throw new Error(`Agent answer quota did not become ${expected}.`);
  }
  return expected;
}

/**
 * Atomically detaches every object created by one failed run. Object deletion
 * is intentionally delegated to the existing durable per-object queue; one
 * failing object therefore cannot prevent the remaining jobs from running.
 */
export async function cleanupRunArtifactsInTransaction(
  transaction: QuotaTransaction,
  input: {
    runId: string;
    userId: string;
    conversationId: string;
    turnId: string;
    assistantMessageId: string;
  }
): Promise<void> {
  // Release quota before deleting the file rows that carry its byte totals.
  // Both statements remain atomic because the caller owns the transaction.
  await transaction.execute(sql`
    with locked_artifacts as materialized (
      select artifact.id
      from chat_artifact artifact
      join agent_run run
        on run.id = ${input.runId}
       and run.user_id = ${input.userId}
       and run.turn_id = ${input.turnId}
       and run.assistant_message_id = ${input.assistantMessageId}
      where artifact.user_id = ${input.userId}
        and artifact.conversation_id = ${input.conversationId}
        and artifact.source_turn_id = ${input.turnId}
        and artifact.message_id = ${input.assistantMessageId}
        and artifact.status <> 'deleted'
        and artifact.deleted_at is null
      for update of artifact
    ),
    locked_files as materialized (
      select file.id, file.size_bytes, file.quota_state,
             file.deletion_status
      from chat_artifact_file file
      join locked_artifacts artifact on artifact.id = file.artifact_id
      for update of file
    ),
    quota_totals as (
      select
        coalesce(sum(file.size_bytes) filter (
          where file.deletion_status = 'active'
            and file.quota_state = 'committed'
        ), 0)::bigint as committed_bytes,
        coalesce(sum(file.size_bytes) filter (
          where file.deletion_status = 'active'
            and file.quota_state = 'reserved'
        ), 0)::bigint as reserved_bytes
      from locked_files file
    )
    update chat_storage_account account
    set used_bytes = greatest(
          account.used_bytes - quota_totals.committed_bytes,
          0
        ),
        reserved_bytes = greatest(
          account.reserved_bytes - quota_totals.reserved_bytes,
          0
        ),
        updated_at = now()
    from quota_totals
    where account.user_id = ${input.userId}
      and (
        quota_totals.committed_bytes > 0
        or quota_totals.reserved_bytes > 0
      )
  `);

  await transaction.execute(sql`
    with locked_artifacts as materialized (
      select artifact.id
      from chat_artifact artifact
      join agent_run run
        on run.id = ${input.runId}
       and run.user_id = ${input.userId}
       and run.turn_id = ${input.turnId}
       and run.assistant_message_id = ${input.assistantMessageId}
      where artifact.user_id = ${input.userId}
        and artifact.conversation_id = ${input.conversationId}
        and artifact.source_turn_id = ${input.turnId}
        and artifact.message_id = ${input.assistantMessageId}
        and artifact.status <> 'deleted'
        and artifact.deleted_at is null
      for update of artifact
    ),
    locked_files as materialized (
      select file.id, file.object_key
      from chat_artifact_file file
      join locked_artifacts artifact on artifact.id = file.artifact_id
      for update of file
    ),
    queued_jobs as (
      insert into chat_storage_deletion_job (
        user_id, object_type, source_id, object_key
      )
      select ${input.userId}, 'artifact', file.id, file.object_key
      from locked_files file
      on conflict (object_key) do nothing
      returning id
    ),
    deleted_files as (
      delete from chat_artifact_file file
      using locked_artifacts artifact
      where file.artifact_id = artifact.id
      returning file.id
    )
    update chat_artifact artifact
    set status = 'failed', ready_at = null, updated_at = now()
    where artifact.id in (select id from locked_artifacts)
      and artifact.status <> 'deleted'
  `);
}
