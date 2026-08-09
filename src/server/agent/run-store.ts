import { and, asc, eq, inArray, isNull, max, sql } from "drizzle-orm";

import { assertAccountWritable } from "@/server/auth/account-write-barrier";
import { db } from "@/server/db";
import {
  agentRuns,
  agentToolCalls,
  citations,
  conversations,
  conversationTurns,
  messageCitations,
  messages
} from "@/server/db/schema";
import type { ResponsesUsage } from "@/server/providers";
import type {
  AnswerMeta,
  AnswerV2,
  Citation,
  RequestedAgentMode,
  ResolvedAgentMode,
  RiskLevel,
  WebMode
} from "@/types/chat";
import type {
  AnswerV3,
  ArtifactPart,
  InputMessagePart,
  VerifiedLinkPart
} from "@/types/chat-v3";
import { inputMessagePartsSchema } from "@/server/chat-v3/contracts";

import { safeParseAnswerV2, sanitizeStoredAnswerV2 } from "./answer-v2";
import { renderAnswerV3, safeParseAnswerV3 } from "./answer-v3";
import { EvidenceRegistry } from "./evidence-registry";
import { parsePublicHttpsUrl } from "./public-url";
import { recoverStaleAgentRuns } from "./retention";
import {
  cleanupRunArtifactsInTransaction,
  settleAnswerQuotaInTransaction
} from "./run-settlement";

export type AgentAction = "initial" | "retry" | "regenerate" | "continue";

export type CreatedRun = {
  runId: string;
  turnId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  answerVersion: number;
  question: string;
  inputParts: InputMessagePart[];
  action: AgentAction;
};

export type CreateRunResult =
  | { kind: "created"; run: CreatedRun }
  | { kind: "busy"; runId: string }
  | { kind: "replay"; replay: StoredRunReplay }
  | { kind: "request_used" };

export type StoredRunReplay = {
  runId: string;
  turnId: string;
  conversationId: string;
  userMessageId: string;
  messageId: string;
  answerVersion: number;
  status: "completed" | "incomplete";
  answer: AnswerV2 | AnswerV3;
  meta: AnswerMeta;
};

const activeControllers = new Map<string, AbortController>();

export class RunStore {
  async getTurnQuestion(
    userId: string,
    turnId: string
  ): Promise<string | undefined> {
    const [turn] = await db
      .select({ question: messages.content })
      .from(conversationTurns)
      .innerJoin(messages, eq(conversationTurns.userMessageId, messages.id))
      .innerJoin(
        conversations,
        eq(conversationTurns.conversationId, conversations.id)
      )
      .where(
        and(
          eq(conversationTurns.id, turnId),
          eq(conversations.userId, userId),
          isNull(conversations.deletedAt)
        )
      )
      .limit(1);
    return turn?.question;
  }

  async lookupClientRequest(
    userId: string,
    clientRequestId: string
  ): Promise<CreateRunResult | undefined> {
    await recoverStaleAgentRuns({ userId });
    return db.transaction((tx) =>
      findRunByClientRequest(tx, userId, clientRequestId)
    );
  }

  registerController(runId: string, controller: AbortController): () => void {
    activeControllers.set(runId, controller);
    return () => {
      if (activeControllers.get(runId) === controller) {
        activeControllers.delete(runId);
      }
    };
  }

  async createInitial(input: {
    userId: string;
    conversationId?: string;
    question: string;
    inputParts?: InputMessagePart[];
    clientRequestId: string;
    requestedMode: RequestedAgentMode;
    resolvedMode: ResolvedAgentMode;
    webMode: WebMode;
    riskLevel: RiskLevel;
    model: string;
    answerQuotaLeaseId: string;
  }): Promise<CreateRunResult> {
    return db.transaction(async (tx) => {
      await assertAccountWritable(tx, input.userId);
      await lockClientRequest(tx, input.userId, input.clientRequestId);
      const replay = await findRunByClientRequest(
        tx,
        input.userId,
        input.clientRequestId
      );
      if (replay) return replay;

      const now = new Date();
      let conversationId = input.conversationId;
      if (conversationId) {
        const [owned] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.userId, input.userId),
              isNull(conversations.deletedAt)
            )
          )
          .limit(1);
        if (!owned) throw new RunStoreError("CONVERSATION_NOT_FOUND");
      } else {
        const [created] = await tx
          .insert(conversations)
          .values({
            userId: input.userId,
            title: conversationTitle(input.question),
            model: input.model,
            lastMessageAt: now
          })
          .returning({ id: conversations.id });
        if (!created) throw new RunStoreError("CONVERSATION_CREATE_FAILED");
        conversationId = created.id;
      }

      await lockConversation(tx, conversationId);
      const busy = await findActiveRun(tx, conversationId);
      if (busy) return { kind: "busy" as const, runId: busy.id };

      const [{ sequence }, { ordinal }] = await Promise.all([
        tx
          .select({ sequence: max(messages.sequence) })
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
          .then((rows) => rows[0] ?? { sequence: null }),
        tx
          .select({ ordinal: max(conversationTurns.ordinal) })
          .from(conversationTurns)
          .where(eq(conversationTurns.conversationId, conversationId))
          .then((rows) => rows[0] ?? { ordinal: null })
      ]);
      const userSequence = (sequence ?? 0) + 1;
      const userMessageId = crypto.randomUUID();
      const assistantMessageId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      const runId = crypto.randomUUID();

      await tx.insert(messages).values([
        {
          id: userMessageId,
          conversationId,
          userId: input.userId,
          sequence: userSequence,
          role: "user",
          status: "completed",
          content: input.question,
          clientRequestId: input.clientRequestId,
          turnId,
          metadata: {
            inputParts: input.inputParts ?? [
              { type: "text", text: input.question }
            ]
          },
          completedAt: now
        },
        {
          id: assistantMessageId,
          conversationId,
          userId: input.userId,
          sequence: userSequence + 1,
          role: "assistant",
          status: "streaming",
          content: "",
          turnId,
          model: input.model,
          metadata: {
            clientRequestId: input.clientRequestId,
            runId,
            answerVersion: 1
          }
        }
      ]);
      await tx.insert(conversationTurns).values({
        id: turnId,
        conversationId,
        userMessageId,
        ordinal: (ordinal ?? 0) + 1
      });
      await tx.insert(agentRuns).values({
        id: runId,
        turnId,
        userId: input.userId,
        assistantMessageId,
        clientRequestId: input.clientRequestId,
        version: 1,
        action: "initial",
        model: input.model,
        requestedMode: input.requestedMode,
        resolvedMode: input.resolvedMode,
        webMode: input.webMode,
        riskLevel: input.riskLevel,
        answerQuotaLeaseId: input.answerQuotaLeaseId,
        answerQuotaStatus: "reserved",
        status: "running",
        startedAt: now
      });
      await tx
        .update(conversations)
        .set({ lastMessageAt: now, updatedAt: now })
        .where(eq(conversations.id, conversationId));
      return {
        kind: "created" as const,
        run: {
          runId,
          turnId,
          conversationId,
          userMessageId,
          assistantMessageId,
          answerVersion: 1,
          question: input.question,
          inputParts: input.inputParts ?? [
            { type: "text", text: input.question }
          ],
          action: "initial" as const
        }
      };
    });
  }

  async createAction(input: {
    userId: string;
    turnId: string;
    clientRequestId: string;
    action: Exclude<AgentAction, "initial">;
    requestedMode: RequestedAgentMode;
    resolvedMode: ResolvedAgentMode;
    webMode: WebMode;
    riskLevel: RiskLevel;
    model: string;
    answerQuotaLeaseId: string;
  }): Promise<CreateRunResult> {
    return db.transaction(async (tx) => {
      await assertAccountWritable(tx, input.userId);
      await lockClientRequest(tx, input.userId, input.clientRequestId);
      const replay = await findRunByClientRequest(
        tx,
        input.userId,
        input.clientRequestId
      );
      if (replay) return replay;
      const [turn] = await tx
        .select({
          id: conversationTurns.id,
          conversationId: conversationTurns.conversationId,
          userMessageId: conversationTurns.userMessageId,
          question: messages.content,
          metadata: messages.metadata
        })
        .from(conversationTurns)
        .innerJoin(messages, eq(conversationTurns.userMessageId, messages.id))
        .innerJoin(
          conversations,
          eq(conversationTurns.conversationId, conversations.id)
        )
        .where(
          and(
            eq(conversationTurns.id, input.turnId),
            eq(conversations.userId, input.userId),
            isNull(conversations.deletedAt)
          )
        )
        .limit(1);
      if (!turn) throw new RunStoreError("TURN_NOT_FOUND");
      await lockConversation(tx, turn.conversationId);
      const busy = await findActiveRun(tx, turn.conversationId);
      if (busy) return { kind: "busy" as const, runId: busy.id };

      const [latest] = await tx
        .select({ status: agentRuns.status, version: agentRuns.version })
        .from(agentRuns)
        .where(eq(agentRuns.turnId, turn.id))
        .orderBy(sql`${agentRuns.version} desc`)
        .limit(1);
      const actionAllowed =
        (input.action === "retry" &&
          (latest?.status === "failed" || latest?.status === "cancelled")) ||
        (input.action === "continue" && latest?.status === "incomplete") ||
        (input.action === "regenerate" && latest?.status === "completed");
      if (!actionAllowed) {
        throw new RunStoreError("ACTION_NOT_ALLOWED");
      }

      const [{ sequence }, { version }] = await Promise.all([
        tx
          .select({ sequence: max(messages.sequence) })
          .from(messages)
          .where(eq(messages.conversationId, turn.conversationId))
          .then((rows) => rows[0] ?? { sequence: null }),
        tx
          .select({ version: max(agentRuns.version) })
          .from(agentRuns)
          .where(eq(agentRuns.turnId, turn.id))
          .then((rows) => rows[0] ?? { version: null })
      ]);
      const answerVersion = (version ?? 0) + 1;
      const assistantMessageId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const now = new Date();
      await tx.insert(messages).values({
        id: assistantMessageId,
        conversationId: turn.conversationId,
        userId: input.userId,
        sequence: (sequence ?? 0) + 1,
        role: "assistant",
        status: "streaming",
        content: "",
        turnId: turn.id,
        model: input.model,
        metadata: {
          clientRequestId: input.clientRequestId,
          runId,
          answerVersion
        }
      });
      await tx.insert(agentRuns).values({
        id: runId,
        turnId: turn.id,
        userId: input.userId,
        assistantMessageId,
        clientRequestId: input.clientRequestId,
        version: answerVersion,
        action: input.action,
        model: input.model,
        requestedMode: input.requestedMode,
        resolvedMode: input.resolvedMode,
        webMode: input.webMode,
        riskLevel: input.riskLevel,
        answerQuotaLeaseId: input.answerQuotaLeaseId,
        answerQuotaStatus: "reserved",
        status: "running",
        startedAt: now
      });
      return {
        kind: "created" as const,
        run: {
          runId,
          turnId: turn.id,
          conversationId: turn.conversationId,
          userMessageId: turn.userMessageId,
          assistantMessageId,
          answerVersion,
          question: turn.question,
          inputParts: storedInputParts(turn.metadata, turn.question),
          action: input.action
        }
      };
    });
  }

  async complete(input: {
    userId: string;
    run: CreatedRun;
    answer: AnswerV3;
    riskLevel: RiskLevel;
    requestedMode: RequestedAgentMode;
    resolvedMode: ResolvedAgentMode;
    webMode: WebMode;
    webSearched: boolean;
    evidence: EvidenceRegistry;
    usedEvidenceIds: string[];
    verifiedLinks?: VerifiedLinkPart[];
    artifacts?: ArtifactPart[];
    context: AnswerMeta["context"];
    usage?: ResponsesUsage;
    latencyMs: number;
    status?: "completed" | "incomplete";
    counters: {
      toolRounds: number;
      toolCalls: number;
      modelRequests: number;
      retries: number;
      repairs: number;
    };
  }): Promise<{ content: string; meta: AnswerMeta }> {
    const status = input.status ?? "completed";
    const uniqueEvidenceIds = [...new Set(input.usedEvidenceIds)].filter((id) =>
      input.evidence.has(id)
    );
    const visibleEvidenceIds = uniqueEvidenceIds.filter(
      (id) => input.evidence.get(id)?.citationVisible === true
    );
    const citationNumbers = new Map(
      visibleEvidenceIds.map((id, index) => [id, index + 1])
    );
    const content = renderAnswerV3(input.answer, citationNumbers);
    const visibleCitations = input.evidence.citations(visibleEvidenceIds);
    const meta: AnswerMeta = {
      riskLevel: input.riskLevel,
      missingInputs: input.answer.missingInputs,
      webSearched: input.webSearched,
      citations: visibleCitations,
      answerV3: input.answer,
      verifiedLinks: input.verifiedLinks ?? [],
      artifacts: input.artifacts ?? [],
      turnId: input.run.turnId,
      runId: input.run.runId,
      answerVersion: input.run.answerVersion,
      requestedMode: input.requestedMode,
      resolvedMode: input.resolvedMode,
      webMode: input.webMode,
      latencyMs: input.latencyMs,
      context: input.context,
      calculations: input.answer.blocks.flatMap((block) =>
        block.type === "calculation"
          ? [
              {
                calculationId: block.calculationId,
                title: block.title,
                result: block.result,
                unit: block.unit,
                assumptions: block.assumptions,
                warnings: block.warnings
              }
            ]
          : []
      ),
      incomplete: status === "incomplete"
    };

    await db.transaction(async (tx) => {
      await assertAccountWritable(tx, input.userId);
      await lockConversation(tx, input.run.conversationId);
      const [current] = await tx
        .select({
          status: agentRuns.status,
          cancelRequestedAt: agentRuns.cancelRequestedAt,
          answerQuotaLeaseId: agentRuns.answerQuotaLeaseId
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, input.run.runId))
        .limit(1);
      if (
        !current ||
        !["pending", "running"].includes(current.status) ||
        current.cancelRequestedAt
      ) {
        throw new RunStoreError("RUN_NOT_COMPLETABLE");
      }
      if (!current.answerQuotaLeaseId) {
        throw new RunStoreError("ANSWER_QUOTA_LEASE_MISSING");
      }

      await tx
        .update(messages)
        .set({
          content,
          status,
          answerSchemaVersion: "openvac.answer.v3",
          answerPayload: input.answer as Record<string, unknown>,
          inputTokens: input.usage?.inputTokens,
          outputTokens: input.usage?.outputTokens,
          latencyMs: input.latencyMs,
          completedAt: new Date(),
          metadata: {
            riskLevel: input.riskLevel,
            missingInputs: input.answer.missingInputs,
            webSearched: input.webSearched,
            runId: input.run.runId,
            turnId: input.run.turnId,
            answerVersion: input.run.answerVersion,
            requestedMode: input.requestedMode,
            resolvedMode: input.resolvedMode,
            webMode: input.webMode,
            context: input.context,
            verifiedLinks: input.verifiedLinks ?? [],
            artifacts: input.artifacts ?? [],
            incomplete: status === "incomplete"
          }
        })
        .where(eq(messages.id, input.run.assistantMessageId));

      for (const [index, id] of visibleEvidenceIds.entries()) {
        const entry = input.evidence.get(id);
        if (!entry?.citationVisible) continue;
        const [created] = await tx
          .insert(citations)
          .values({
            sourceType: entry.originalSourceId.startsWith("web:")
              ? "web"
              : "knowledge",
            title: entry.evidence.citation.title,
            url: entry.evidence.citation.url,
            quote: entry.evidence.excerpt,
            sourceTier: entry.evidence.citation.licenseClass,
            trustTier: entry.trustTier,
            reviewStatus: entry.reviewStatus,
            license: entry.evidence.citation.licenseClass,
            locator: {
              pageOrSection: entry.evidence.citation.pageOrSection ?? null
            },
            metadata: {
              publisher: entry.evidence.citation.publisher,
              fetchedAt: new Date(
                entry.evidence.citation.fetchedAt
              ).toISOString(),
              sourceId: id,
              originalSourceId: entry.originalSourceId,
              runtimeValidated: entry.runtimeValidated
            }
          })
          .returning({ id: citations.id });
        if (created) {
          await tx.insert(messageCitations).values({
            messageId: input.run.assistantMessageId,
            citationId: created.id,
            ordinal: index + 1
          });
        }
      }

      if (status === "completed") {
        await tx
          .update(conversationTurns)
          .set({ selectedRunId: input.run.runId, updatedAt: new Date() })
          .where(eq(conversationTurns.id, input.run.turnId));
      }
      await tx
        .update(conversations)
        .set({ lastMessageAt: new Date(), updatedAt: new Date() })
        .where(eq(conversations.id, input.run.conversationId));

      const answerQuotaStatus = await settleAnswerQuotaInTransaction(tx, {
        leaseId: current.answerQuotaLeaseId,
        userId: input.userId,
        status,
        reason: "agent_run_incomplete"
      });
      await tx
        .update(agentRuns)
        .set({
          status,
          answerQuotaStatus,
          settlementStatus: "completed",
          answerPayload: input.answer as Record<string, unknown>,
          contextMetadata: input.context ?? {},
          toolRoundCount: input.counters.toolRounds,
          toolCallCount: input.counters.toolCalls,
          modelRequestCount: input.counters.modelRequests,
          retryCount: input.counters.retries,
          repairCount: input.counters.repairs,
          completedAt: new Date()
        })
        .where(eq(agentRuns.id, input.run.runId));
    });
    return { content, meta };
  }

  async fail(input: {
    run: CreatedRun;
    status: "failed" | "cancelled";
    code: string;
    message: string;
    context?: Record<string, unknown>;
    counters?: {
      toolRounds: number;
      toolCalls: number;
      modelRequests: number;
      retries: number;
      repairs: number;
    };
  }): Promise<{
    settlementStatus: "completed";
    answerQuotaStatus: "released" | null;
  }> {
    return db.transaction(async (tx) => {
      await lockConversation(tx, input.run.conversationId);
      const [transitioned] = await tx
        .update(agentRuns)
        .set({
          status: input.status,
          errorCode: input.code,
          errorMessage: input.message,
          contextMetadata: input.context ?? {},
          ...(input.counters
            ? {
                toolRoundCount: input.counters.toolRounds,
                toolCallCount: input.counters.toolCalls,
                modelRequestCount: input.counters.modelRequests,
                retryCount: input.counters.retries,
                repairCount: input.counters.repairs
              }
            : {}),
          completedAt: new Date()
        })
        .where(
          and(
            eq(agentRuns.id, input.run.runId),
            inArray(agentRuns.status, ["pending", "running"])
          )
        )
        .returning({
          id: agentRuns.id,
          userId: agentRuns.userId,
          answerQuotaLeaseId: agentRuns.answerQuotaLeaseId
        });
      if (!transitioned) {
        const [settled] = await tx
          .select({
            status: agentRuns.status,
            answerQuotaStatus: agentRuns.answerQuotaStatus,
            settlementStatus: agentRuns.settlementStatus
          })
          .from(agentRuns)
          .where(eq(agentRuns.id, input.run.runId))
          .limit(1);
        if (
          settled &&
          ["failed", "cancelled"].includes(settled.status) &&
          settled.settlementStatus === "completed" &&
          (settled.answerQuotaStatus === "released" ||
            settled.answerQuotaStatus === null)
        ) {
          return {
            settlementStatus: "completed" as const,
            answerQuotaStatus: settled.answerQuotaStatus
          };
        }
        throw new RunStoreError("RUN_NOT_FAILABLE");
      }
      const answerQuotaStatus = await settleAnswerQuotaInTransaction(tx, {
        leaseId: transitioned.answerQuotaLeaseId,
        userId: transitioned.userId,
        status: input.status,
        reason:
          input.status === "cancelled"
            ? "agent_run_cancelled"
            : "agent_run_failed"
      });
      if (answerQuotaStatus === "committed") {
        throw new RunStoreError("ANSWER_QUOTA_RELEASE_FAILED");
      }
      await cleanupRunArtifactsInTransaction(tx, {
        runId: input.run.runId,
        userId: transitioned.userId,
        conversationId: input.run.conversationId,
        turnId: input.run.turnId,
        assistantMessageId: input.run.assistantMessageId
      });
      await tx
        .update(agentRuns)
        .set({
          answerQuotaStatus,
          settlementStatus: "completed"
        })
        .where(eq(agentRuns.id, input.run.runId));
      await tx
        .update(messages)
        .set({
          status: input.status,
          content:
            input.status === "cancelled"
              ? "本次回答已取消，未扣除成功回答额度。"
              : "本次回答未完成，可重试后重新生成。",
          errorCode: input.code,
          errorMessage: input.message,
          completedAt: new Date(),
          metadata: {
            runId: input.run.runId,
            turnId: input.run.turnId,
            answerVersion: input.run.answerVersion
          }
        })
        .where(eq(messages.id, input.run.assistantMessageId));
      return {
        settlementStatus: "completed" as const,
        answerQuotaStatus
      };
    });
  }

  async recordToolCall(input: {
    runId: string;
    round: number;
    sequence: number;
    callId: string;
    toolName: string;
    argumentsDigest: string;
    resultDigest?: string;
    calculationId?: string;
    citationIds?: string[];
    status: "completed" | "failed";
    latencyMs: number;
    errorCode?: string;
  }): Promise<void> {
    await db.insert(agentToolCalls).values({
      runId: input.runId,
      round: input.round,
      sequence: input.sequence,
      providerCallId: input.callId,
      toolName: input.toolName,
      argumentsDigest: input.argumentsDigest,
      resultDigest: input.resultDigest,
      sanitizedPreview: {
        evidenceCount: input.citationIds?.length ?? 0,
        status: input.status,
        ...(input.calculationId ? { calculationId: input.calculationId } : {})
      },
      citationIds: input.citationIds ?? [],
      status: input.status,
      idempotencyKey: `${input.runId}:${input.callId}`,
      latencyMs: input.latencyMs,
      errorCode: input.errorCode,
      startedAt: new Date(Date.now() - input.latencyMs),
      completedAt: new Date()
    });
  }

  async requestCancellation(input: {
    userId: string;
    runId: string;
  }): Promise<"accepted" | "already_finished" | "not_found"> {
    const result = await db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ conversationId: conversationTurns.conversationId })
        .from(agentRuns)
        .innerJoin(
          conversationTurns,
          eq(agentRuns.turnId, conversationTurns.id)
        )
        .where(
          and(eq(agentRuns.id, input.runId), eq(agentRuns.userId, input.userId))
        )
        .limit(1);
      if (!owned) return "not_found" as const;

      // The completion path takes the same lock before checking
      // cancelRequestedAt. Exactly one side of a cancel/complete race wins.
      await lockConversation(tx, owned.conversationId);
      const [current] = await tx
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, input.runId))
        .limit(1);
      if (!current || !["pending", "running"].includes(current.status)) {
        return "already_finished" as const;
      }
      const [updated] = await tx
        .update(agentRuns)
        .set({ cancelRequestedAt: new Date() })
        .where(
          and(
            eq(agentRuns.id, input.runId),
            inArray(agentRuns.status, ["pending", "running"])
          )
        )
        .returning({ id: agentRuns.id });
      return updated ? ("accepted" as const) : ("already_finished" as const);
    });
    if (result === "accepted") {
      activeControllers.get(input.runId)?.abort(new Error("USER_CANCELLED"));
    }
    return result;
  }
}

function conversationTitle(question: string): string {
  const compact = question.replace(/\s+/g, " ").trim();
  return compact.length <= 28 ? compact : `${compact.slice(0, 28)}…`;
}

type AgentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockConversation(
  tx: AgentTransaction,
  conversationId: string
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`openvac:agent:${conversationId}`}))`
  );
}

async function lockClientRequest(
  tx: AgentTransaction,
  userId: string,
  clientRequestId: string
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`openvac:agent-request:${userId}:${clientRequestId}`}))`
  );
}

async function findActiveRun(tx: AgentTransaction, conversationId: string) {
  const [active] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(conversationTurns, eq(agentRuns.turnId, conversationTurns.id))
    .where(
      and(
        eq(conversationTurns.conversationId, conversationId),
        inArray(agentRuns.status, ["pending", "running"])
      )
    )
    .limit(1);
  return active;
}

async function findRunByClientRequest(
  tx: AgentTransaction,
  userId: string,
  clientRequestId: string
): Promise<CreateRunResult | undefined> {
  const [run] = await tx
    .select({
      id: agentRuns.id,
      turnId: agentRuns.turnId,
      version: agentRuns.version,
      status: agentRuns.status,
      answerPayload: agentRuns.answerPayload,
      assistantMessageId: agentRuns.assistantMessageId,
      conversationId: conversationTurns.conversationId,
      userMessageId: conversationTurns.userMessageId,
      metadata: messages.metadata
    })
    .from(agentRuns)
    .innerJoin(conversationTurns, eq(agentRuns.turnId, conversationTurns.id))
    .innerJoin(messages, eq(agentRuns.assistantMessageId, messages.id))
    .where(
      and(
        eq(agentRuns.userId, userId),
        eq(agentRuns.clientRequestId, clientRequestId)
      )
    )
    .limit(1);
  if (!run) return undefined;
  if (["pending", "running"].includes(run.status)) {
    return { kind: "busy", runId: run.id };
  }
  if (
    (run.status === "completed" || run.status === "incomplete") &&
    parseStoredAnswer(run.answerPayload) !== undefined
  ) {
    const storedCitations = await tx
      .select({
        title: citations.title,
        url: citations.url,
        license: citations.license,
        trustTier: citations.trustTier,
        reviewStatus: citations.reviewStatus,
        locator: citations.locator,
        metadata: citations.metadata
      })
      .from(messageCitations)
      .innerJoin(citations, eq(messageCitations.citationId, citations.id))
      .where(eq(messageCitations.messageId, run.assistantMessageId))
      .orderBy(asc(messageCitations.ordinal));
    const storedMeta = run.metadata as Partial<AnswerMeta>;
    const answer = parseStoredAnswer(run.answerPayload);
    if (!answer) return { kind: "request_used" };
    const meta: AnswerMeta = {
      riskLevel: safeRiskLevel(storedMeta.riskLevel),
      missingInputs: answer.missingInputs,
      webSearched: storedMeta.webSearched ?? false,
      citations: storedCitations.flatMap((citation) => {
        const value = restoreCitation(citation);
        return value ? [value] : [];
      }),
      ...(answer.schemaVersion === "openvac.answer.v2"
        ? { answer }
        : { answerV3: answer }),
      runId: run.id,
      turnId: run.turnId,
      answerVersion: run.version,
      ...(safeRequestedMode(storedMeta.requestedMode)
        ? { requestedMode: safeRequestedMode(storedMeta.requestedMode) }
        : {}),
      ...(safeResolvedMode(storedMeta.resolvedMode)
        ? { resolvedMode: safeResolvedMode(storedMeta.resolvedMode) }
        : {}),
      ...(safeWebMode(storedMeta.webMode)
        ? { webMode: safeWebMode(storedMeta.webMode) }
        : {}),
      ...(safeNonNegativeInteger(storedMeta.latencyMs) !== undefined
        ? { latencyMs: safeNonNegativeInteger(storedMeta.latencyMs) }
        : {}),
      verifiedLinks: safeStoredVerifiedLinks(storedMeta.verifiedLinks),
      artifacts: safeStoredArtifacts(storedMeta.artifacts),
      calculations:
        answer.schemaVersion === "openvac.answer.v3"
          ? answer.blocks.flatMap((block) =>
              block.type === "calculation"
                ? [
                    {
                      calculationId: block.calculationId,
                      title: block.title,
                      result: block.result,
                      unit: block.unit,
                      assumptions: block.assumptions,
                      warnings: block.warnings
                    }
                  ]
                : []
            )
          : [],
      incomplete: run.status === "incomplete"
    };
    return {
      kind: "replay",
      replay: {
        runId: run.id,
        turnId: run.turnId,
        conversationId: run.conversationId,
        userMessageId: run.userMessageId,
        messageId: run.assistantMessageId,
        answerVersion: run.version,
        status: run.status,
        answer,
        meta
      }
    };
  }
  return { kind: "request_used" };
}

function restoreCitation(input: {
  title: string;
  url: string | null;
  license: string | null;
  trustTier: string | null;
  reviewStatus: string | null;
  locator: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): Citation | undefined {
  if (!input.url) return undefined;
  const sourceId = input.metadata.sourceId;
  const publisher = input.metadata.publisher;
  const fetchedAt = input.metadata.fetchedAt;
  if (
    typeof sourceId !== "string" ||
    typeof publisher !== "string" ||
    typeof fetchedAt !== "string"
  ) {
    return undefined;
  }
  const licenseClass = input.license;
  if (
    ![
      "open",
      "public_domain",
      "metadata_only",
      "private_authorized",
      "unknown"
    ].includes(licenseClass ?? "")
  ) {
    return undefined;
  }
  return {
    sourceId,
    title: input.title,
    publisher,
    url: input.url,
    pageOrSection:
      typeof input.locator.pageOrSection === "string"
        ? input.locator.pageOrSection
        : undefined,
    fetchedAt,
    licenseClass: licenseClass as Citation["licenseClass"],
    trustTier: ["tier_a", "tier_b", "tier_c", "blocked"].includes(
      input.trustTier ?? ""
    )
      ? (input.trustTier as Citation["trustTier"])
      : undefined,
    reviewStatus: [
      "reviewed",
      "pending_review",
      "rejected",
      "runtime_verified"
    ].includes(input.reviewStatus ?? "")
      ? (input.reviewStatus as Citation["reviewStatus"])
      : undefined
  };
}

function parseStoredAnswer(value: unknown): AnswerV2 | AnswerV3 | undefined {
  const v2 = safeParseAnswerV2(value);
  return (
    (v2 ? sanitizeStoredAnswerV2(v2) : undefined) ?? safeParseAnswerV3(value)
  );
}

function storedInputParts(
  metadata: Record<string, unknown>,
  fallbackText: string
): InputMessagePart[] {
  const parsed = inputMessagePartsSchema.safeParse(metadata.inputParts);
  return parsed.success ? parsed.data : [{ type: "text", text: fallbackText }];
}

function safeRiskLevel(value: unknown): RiskLevel {
  return value === "medium" || value === "high" ? value : "low";
}

function safeRequestedMode(value: unknown): RequestedAgentMode | undefined {
  return value === "auto" || value === "deep" ? value : undefined;
}

function safeResolvedMode(value: unknown): ResolvedAgentMode | undefined {
  return value === "fast" || value === "deep" ? value : undefined;
}

function safeWebMode(value: unknown): WebMode | undefined {
  return value === "auto" || value === "always" ? value : undefined;
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeStoredVerifiedLinks(value: unknown): VerifiedLinkPart[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const record = candidate as Record<string, unknown>;
    if (
      record.type !== "verified_link" ||
      typeof record.linkId !== "string" ||
      record.linkId.length < 1 ||
      record.linkId.length > 160 ||
      typeof record.label !== "string" ||
      record.label.length < 1 ||
      record.label.length > 240 ||
      typeof record.hostname !== "string" ||
      typeof record.url !== "string" ||
      (record.status !== "verified" && record.status !== "unavailable")
    ) {
      return [];
    }
    const url = parsePublicHttpsUrl(record.url, record.hostname);
    if (!url) return [];
    const evidenceIds = Array.isArray(record.evidenceIds)
      ? record.evidenceIds.filter(
          (id): id is string => typeof id === "string" && /^E\d+$/u.test(id)
        )
      : [];
    if (
      evidenceIds.length > 64 ||
      evidenceIds.length !== new Set(evidenceIds).size ||
      (Array.isArray(record.evidenceIds) &&
        evidenceIds.length !== record.evidenceIds.length)
    ) {
      return [];
    }
    return [
      {
        type: "verified_link" as const,
        linkId: record.linkId,
        url: url.href,
        label: record.label,
        hostname: record.hostname,
        status: record.status,
        ...(evidenceIds.length > 0 ? { evidenceIds } : {})
      }
    ];
  });
}

function safeStoredArtifacts(value: unknown): ArtifactPart[] {
  if (!Array.isArray(value)) return [];
  const kinds = new Set([
    "diagnosis_report",
    "selection_report",
    "inspection_checklist",
    "parameter_table"
  ]);
  const formats = new Set(["md", "docx", "pdf", "csv"]);
  const statuses = new Set(["generating", "ready", "failed", "deleted"]);
  return value.slice(0, 64).flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const record = candidate as Record<string, unknown>;
    if (
      record.type !== "artifact" ||
      typeof record.artifactId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        record.artifactId
      ) ||
      typeof record.kind !== "string" ||
      !kinds.has(record.kind) ||
      typeof record.title !== "string" ||
      record.title.length < 1 ||
      record.title.length > 240 ||
      !Array.isArray(record.formats) ||
      record.formats.some(
        (format) => typeof format !== "string" || !formats.has(format)
      ) ||
      typeof record.status !== "string" ||
      !statuses.has(record.status)
    ) {
      return [];
    }
    return [record as ArtifactPart];
  });
}

export class RunStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RunStoreError";
  }
}
