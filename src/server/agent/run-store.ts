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
  CalculationResult,
  Citation,
  RequestedAgentMode,
  ResolvedAgentMode,
  RiskLevel,
  WebMode
} from "@/types/chat";

import { renderAnswerV2 } from "./answer-v2";
import { EvidenceRegistry } from "./evidence-registry";
import { recoverStaleAgentRuns } from "./retention";

export type AgentAction = "initial" | "retry" | "regenerate" | "continue";

export type CreatedRun = {
  runId: string;
  turnId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  answerVersion: number;
  question: string;
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
  answer: AnswerV2;
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
    clientRequestId: string;
    requestedMode: RequestedAgentMode;
    resolvedMode: ResolvedAgentMode;
    webMode: WebMode;
    riskLevel: RiskLevel;
    model: string;
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
          question: messages.content
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
          action: input.action
        }
      };
    });
  }

  async complete(input: {
    userId: string;
    run: CreatedRun;
    answer: AnswerV2;
    riskLevel: RiskLevel;
    requestedMode: RequestedAgentMode;
    resolvedMode: ResolvedAgentMode;
    webMode: WebMode;
    webSearched: boolean;
    evidence: EvidenceRegistry;
    usedEvidenceIds: string[];
    calculations: CalculationResult[];
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
    const citationNumbers = new Map(
      uniqueEvidenceIds.map((id, index) => [id, index + 1])
    );
    const content = renderAnswerV2(input.answer, citationNumbers);
    const visibleCitations = input.evidence.citations(uniqueEvidenceIds);
    const meta: AnswerMeta = {
      riskLevel: input.riskLevel,
      missingInputs: input.answer.missingInputs,
      webSearched: input.webSearched,
      citations: visibleCitations,
      answer: input.answer,
      turnId: input.run.turnId,
      runId: input.run.runId,
      answerVersion: input.run.answerVersion,
      requestedMode: input.requestedMode,
      resolvedMode: input.resolvedMode,
      webMode: input.webMode,
      latencyMs: input.latencyMs,
      context: input.context,
      calculations: input.calculations,
      incomplete: status === "incomplete"
    };

    await db.transaction(async (tx) => {
      await assertAccountWritable(tx, input.userId);
      await lockConversation(tx, input.run.conversationId);
      const [current] = await tx
        .select({
          status: agentRuns.status,
          cancelRequestedAt: agentRuns.cancelRequestedAt
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

      await tx
        .update(messages)
        .set({
          content,
          status,
          answerSchemaVersion: "openvac.answer.v2",
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
            calculations: input.calculations,
            incomplete: status === "incomplete"
          }
        })
        .where(eq(messages.id, input.run.assistantMessageId));

      for (const [index, id] of uniqueEvidenceIds.entries()) {
        const entry = input.evidence.get(id);
        if (!entry) continue;
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

      await tx
        .update(agentRuns)
        .set({
          status,
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
    });
    return { content, meta };
  }

  async fail(input: {
    run: CreatedRun;
    status: "failed" | "cancelled";
    code: string;
    message: string;
    context?: Record<string, unknown>;
  }): Promise<void> {
    await db.transaction(async (tx) => {
      await lockConversation(tx, input.run.conversationId);
      const [transitioned] = await tx
        .update(agentRuns)
        .set({
          status: input.status,
          errorCode: input.code,
          errorMessage: input.message,
          contextMetadata: input.context ?? {},
          completedAt: new Date()
        })
        .where(
          and(
            eq(agentRuns.id, input.run.runId),
            inArray(agentRuns.status, ["pending", "running"])
          )
        )
        .returning({ id: agentRuns.id });
      if (!transitioned) return;
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
        status: input.status
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
    isAnswerV2(run.answerPayload)
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
    const meta: AnswerMeta = {
      riskLevel: storedMeta.riskLevel ?? "low",
      missingInputs: run.answerPayload.missingInputs,
      webSearched: storedMeta.webSearched ?? false,
      ...storedMeta,
      citations: storedCitations.flatMap((citation) => {
        const value = restoreCitation(citation);
        return value ? [value] : [];
      }),
      answer: run.answerPayload,
      runId: run.id,
      turnId: run.turnId,
      answerVersion: run.version,
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
        answer: run.answerPayload,
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

function isAnswerV2(value: unknown): value is AnswerV2 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).schemaVersion === "openvac.answer.v2"
  );
}

export class RunStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RunStoreError";
  }
}
