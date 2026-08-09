import { and, eq, inArray, lte, notExists, or, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  agentRuns,
  agentToolCalls,
  conversationTurns,
  messages,
  quotaLedger
} from "@/server/db/schema";
import { releaseQuotaInTransaction } from "@/server/quota/repository";

import {
  cleanupRunArtifactsInTransaction,
  settleAnswerQuotaInTransaction,
  type AgentRunTerminalStatus
} from "./run-settlement";

const DEFAULT_STALE_RUN_MS = 210_000;
const MAX_RECOVERY_BATCH = 500;

type RecoveryScope = {
  userId?: string;
  conversationId?: string;
};

export async function cleanupExpiredAgentToolCalls(
  now = new Date()
): Promise<{ deleted: number }> {
  const deleted = await db
    .delete(agentToolCalls)
    .where(lte(agentToolCalls.expiresAt, now))
    .returning({ id: agentToolCalls.id });
  return { deleted: deleted.length };
}

/**
 * A Responses run keeps reasoning only in process memory. If the process exits,
 * that run cannot be resumed safely and must become a retryable failed answer.
 * The same advisory conversation lock used by completion/cancellation prevents
 * recovery from winning a race against a genuinely finishing request.
 */
export async function recoverStaleAgentRuns(
  scope: RecoveryScope = {},
  now = new Date()
): Promise<{ recovered: number; pending: number }> {
  const staleBefore = new Date(now.getTime() - staleRunThresholdMs());
  const filters = [
    or(
      and(
        inArray(agentRuns.status, ["pending", "running"]),
        lte(agentRuns.updatedAt, staleBefore)
      ),
      and(
        inArray(agentRuns.status, [
          "completed",
          "incomplete",
          "failed",
          "cancelled"
        ]),
        eq(agentRuns.settlementStatus, "pending")
      )
    )
  ];
  if (scope.userId) filters.push(eq(agentRuns.userId, scope.userId));
  if (scope.conversationId) {
    filters.push(eq(conversationTurns.conversationId, scope.conversationId));
  }

  const candidates = await db
    .select({
      runId: agentRuns.id,
      assistantMessageId: agentRuns.assistantMessageId,
      conversationId: conversationTurns.conversationId,
      turnId: conversationTurns.id,
      version: agentRuns.version,
      status: agentRuns.status
    })
    .from(agentRuns)
    .innerJoin(conversationTurns, eq(agentRuns.turnId, conversationTurns.id))
    .where(and(...filters))
    .orderBy(agentRuns.updatedAt, agentRuns.id)
    .limit(MAX_RECOVERY_BATCH);

  let recovered = 0;
  let pending = 0;
  for (const candidate of candidates) {
    try {
      const transitioned = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`openvac:agent:${candidate.conversationId}`}))`
        );
        const [current] = await tx
          .select({
            status: agentRuns.status,
            userId: agentRuns.userId,
            answerQuotaLeaseId: agentRuns.answerQuotaLeaseId,
            settlementStatus: agentRuns.settlementStatus,
            updatedAt: agentRuns.updatedAt
          })
          .from(agentRuns)
          .where(eq(agentRuns.id, candidate.runId))
          .for("update")
          .limit(1);
        if (!current) return false;

        const wasInterrupted =
          ["pending", "running"].includes(current.status) &&
          current.updatedAt <= staleBefore;
        const needsTerminalSettlement =
          ["completed", "incomplete", "failed", "cancelled"].includes(
            current.status
          ) && current.settlementStatus === "pending";
        if (!wasInterrupted && !needsTerminalSettlement) return false;

        const terminalStatus: AgentRunTerminalStatus = wasInterrupted
          ? "failed"
          : (current.status as AgentRunTerminalStatus);
        const answerQuotaStatus = await settleAnswerQuotaInTransaction(tx, {
          leaseId: current.answerQuotaLeaseId,
          userId: current.userId,
          status: terminalStatus,
          reason: wasInterrupted
            ? "agent_run_process_interrupted"
            : `agent_run_${terminalStatus}_recovery`
        });
        if (terminalStatus === "failed" || terminalStatus === "cancelled") {
          await cleanupRunArtifactsInTransaction(tx, {
            runId: candidate.runId,
            userId: current.userId,
            conversationId: candidate.conversationId,
            turnId: candidate.turnId,
            assistantMessageId: candidate.assistantMessageId
          });
        }

        await tx
          .update(agentRuns)
          .set({
            status: terminalStatus,
            answerQuotaStatus,
            settlementStatus: "completed",
            ...(wasInterrupted
              ? {
                  errorCode: "PROCESS_INTERRUPTED",
                  errorMessage:
                    "Agent process ended before the run reached a terminal state."
                }
              : {}),
            completedAt: now
          })
          .where(eq(agentRuns.id, candidate.runId));

        if (wasInterrupted) {
          await tx
            .update(messages)
            .set({
              status: "failed",
              content:
                "上次生成因服务进程中断而未完成，额度已归还，可重试后重新生成。",
              errorCode: "PROCESS_INTERRUPTED",
              errorMessage:
                "Agent process ended before the run reached a terminal state.",
              completedAt: now,
              metadata: {
                runId: candidate.runId,
                turnId: candidate.turnId,
                answerVersion: candidate.version
              }
            })
            .where(eq(messages.id, candidate.assistantMessageId));
        }
        return true;
      });
      if (transitioned) recovered += 1;
    } catch {
      // The transaction rolled back, so the durable pending state remains
      // eligible for the next recovery pass without blocking other runs.
      pending += 1;
    }
  }

  const orphanFilters = [
    eq(quotaLedger.status, "reserved"),
    lte(quotaLedger.reservedAt, staleBefore),
    or(
      and(
        eq(quotaLedger.resource, "answer"),
        notExists(
          db
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(eq(agentRuns.answerQuotaLeaseId, quotaLedger.leaseId))
        )
      ),
      eq(quotaLedger.resource, "model_attempt")
    )
  ];
  if (scope.userId) {
    orphanFilters.push(eq(quotaLedger.actorUserId, scope.userId));
  }
  const orphanedReservations = await db
    .select({
      leaseId: quotaLedger.leaseId,
      userId: quotaLedger.actorUserId,
      resource: quotaLedger.resource
    })
    .from(quotaLedger)
    .where(and(...orphanFilters))
    .groupBy(quotaLedger.leaseId, quotaLedger.actorUserId, quotaLedger.resource)
    .orderBy(quotaLedger.leaseId)
    .limit(MAX_RECOVERY_BATCH);
  for (const orphan of orphanedReservations) {
    try {
      await db.transaction(async (tx) => {
        const quota = await releaseQuotaInTransaction(tx, {
          leaseId: orphan.leaseId,
          actorUserId: orphan.userId,
          reason:
            orphan.resource === "answer"
              ? "agent_run_never_persisted"
              : "model_attempt_never_committed"
        });
        if (quota.resource !== orphan.resource || quota.status !== "released") {
          throw new Error("Orphaned run quota was not released.");
        }
      });
      recovered += 1;
    } catch {
      pending += 1;
    }
  }

  return { recovered, pending };
}

function staleRunThresholdMs(): number {
  const longestRunTimeout = Math.max(
    positiveEnvironmentInteger("AGENT_AUTO_TIMEOUT_MS", 60_000),
    positiveEnvironmentInteger("AGENT_DEEP_TIMEOUT_MS", 180_000)
  );
  const minimum = Math.max(DEFAULT_STALE_RUN_MS, longestRunTimeout + 30_000);
  const configured = Number.parseInt(process.env.AGENT_STALE_RUN_MS ?? "", 10);
  return Number.isFinite(configured) && configured >= minimum
    ? configured
    : minimum;
}

function positiveEnvironmentInteger(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
