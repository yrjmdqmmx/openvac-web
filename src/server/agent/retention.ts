import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  agentRuns,
  agentToolCalls,
  conversationTurns,
  messages
} from "@/server/db/schema";

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
): Promise<{ recovered: number }> {
  const staleBefore = new Date(now.getTime() - staleRunThresholdMs());
  const filters = [
    inArray(agentRuns.status, ["pending", "running"]),
    lte(agentRuns.updatedAt, staleBefore)
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
      version: agentRuns.version
    })
    .from(agentRuns)
    .innerJoin(conversationTurns, eq(agentRuns.turnId, conversationTurns.id))
    .where(and(...filters))
    .orderBy(agentRuns.updatedAt, agentRuns.id)
    .limit(MAX_RECOVERY_BATCH);

  let recovered = 0;
  for (const candidate of candidates) {
    const transitioned = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`openvac:agent:${candidate.conversationId}`}))`
      );
      const [failed] = await tx
        .update(agentRuns)
        .set({
          status: "failed",
          errorCode: "PROCESS_INTERRUPTED",
          errorMessage:
            "Agent process ended before the run reached a terminal state.",
          completedAt: now
        })
        .where(
          and(
            eq(agentRuns.id, candidate.runId),
            inArray(agentRuns.status, ["pending", "running"]),
            lte(agentRuns.updatedAt, staleBefore)
          )
        )
        .returning({ id: agentRuns.id });
      if (!failed) return false;

      await tx
        .update(messages)
        .set({
          status: "failed",
          content: "上次生成因服务进程中断而未完成，可重试后重新生成。",
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
      return true;
    });
    if (transitioned) recovered += 1;
  }

  return { recovered };
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
