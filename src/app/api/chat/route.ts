import { and, asc, desc, eq, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import {
  buildExpertPrompt,
  hasRequiredAnswerSections,
  selectCitationPrefix,
  validateHighRiskAnswerBoundaries,
  validateCitations,
  type AnswerMeta,
  type Citation,
  type GroundingEvidence
} from "@/server/agent";
import { auth } from "@/server/auth";
import {
  AccountDeletionInProgressError,
  assertAccountWritable
} from "@/server/auth/account-write-barrier";
import { collectEvidence } from "@/server/chat/evidence";
import { citationSourcePolicy } from "@/server/chat/citation-policy";
import { buildNoEvidenceAnswer } from "@/server/chat/fallback-answer";
import { resolveAuthorizedModelingCards } from "@/server/chat/modeling-cards";
import {
  serializeStoredCitation,
  serializeStoredModelingCards
} from "@/server/chat/stored-message";
import { db } from "@/server/db";
import {
  citations,
  conversations,
  messageCitations,
  messages,
  user
} from "@/server/db/schema";
import { getModelProvider, type ModelUsage } from "@/server/providers";
import {
  completeModelInvocation,
  failModelInvocation,
  loadActiveRuntimePrompt,
  ModelRuntimeError,
  startModelInvocation,
  type InvocationHandle
} from "@/server/operations/model-runtime";
import {
  commitQuota,
  QuotaAccountDeletionPendingError,
  QuotaAccountUnavailableError,
  QuotaExceededError,
  releaseQuota,
  reserveAnswerQuota,
  reserveModelAttemptQuota,
  type QuotaReservation
} from "@/server/quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const inputSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(2).max(4000),
  clientRequestId: z.string().uuid()
});

type PersistedTurn = {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
};

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return jsonError(401, "UNAUTHENTICATED", "请先登录并完成邮箱验证。");
  }

  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(400, "INVALID_REQUEST", "问题或请求标识格式不正确。");
  }

  const [account] = await db
    .select({
      banned: user.banned,
      banReason: user.banReason,
      banExpires: user.banExpires,
      deletionRequestedAt: user.deletionRequestedAt
    })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);
  if (
    account?.banned &&
    (!account.banExpires || account.banExpires > new Date())
  ) {
    return jsonError(
      403,
      "ACCOUNT_SUSPENDED",
      account.banReason || "账户当前无法使用。"
    );
  }
  if (!account || account.deletionRequestedAt) {
    return jsonError(
      409,
      "ACCOUNT_DELETION_IN_PROGRESS",
      "账号正在删除，不能再写入新数据。"
    );
  }

  const replay = await findReplay(session.user.id, parsed.data.clientRequestId);
  if (replay) {
    return replayResponse(replay);
  }

  const modelProvider = getModelProvider();
  let reservation;
  try {
    reservation = await reserveAnswerQuota({
      userId: session.user.id,
      clientRequestId: parsed.data.clientRequestId,
      metadata: { conversationId: parsed.data.conversationId ?? null }
    });
  } catch (error) {
    if (
      error instanceof QuotaAccountDeletionPendingError ||
      error instanceof QuotaAccountUnavailableError
    ) {
      return jsonError(
        409,
        "ACCOUNT_DELETION_IN_PROGRESS",
        "账号正在删除，不能再写入新数据。"
      );
    }
    if (error instanceof QuotaExceededError) {
      return Response.json(
        {
          error: {
            code: error.code,
            message: "今天的成功回答额度已用完。",
            resetAt: error.resetAt.toISOString()
          }
        },
        { status: 429 }
      );
    }
    return jsonError(
      503,
      "QUOTA_UNAVAILABLE",
      "额度服务暂时不可用，请稍后重试。"
    );
  }

  if (reservation.idempotent) {
    const completedReplay = await findReplay(
      session.user.id,
      parsed.data.clientRequestId
    );
    if (completedReplay) {
      return replayResponse(completedReplay);
    }
    if (reservation.status !== "reserved") {
      return jsonError(
        409,
        "REQUEST_ALREADY_USED",
        "这个请求标识已经使用，请刷新后重试。"
      );
    }
    return jsonError(
      409,
      "REQUEST_IN_PROGRESS",
      "同一请求正在处理中，请等待完成后重试。"
    );
  }
  if (reservation.status !== "reserved") {
    return jsonError(
      409,
      "REQUEST_ALREADY_USED",
      "这个请求标识已经使用，请刷新后重试。"
    );
  }

  let modelAttemptReservation: QuotaReservation;
  try {
    modelAttemptReservation = await reserveModelAttemptQuota({
      userId: session.user.id,
      clientRequestId: parsed.data.clientRequestId,
      metadata: { conversationId: parsed.data.conversationId ?? null }
    });
  } catch (error) {
    await releaseQuota({
      leaseId: reservation.leaseId,
      userId: session.user.id,
      reason: "model_attempt_reservation_failed"
    }).catch(() => undefined);
    if (
      error instanceof QuotaAccountDeletionPendingError ||
      error instanceof QuotaAccountUnavailableError
    ) {
      return jsonError(
        409,
        "ACCOUNT_DELETION_IN_PROGRESS",
        "账号正在删除，不能再写入新数据。"
      );
    }
    if (error instanceof QuotaExceededError) {
      return Response.json(
        {
          error: {
            code: "MODEL_ATTEMPT_LIMIT_EXCEEDED",
            message:
              "模型尝试次数已达到今日保护上限，本次未调用模型，请于额度恢复后重试。",
            resetAt: error.resetAt.toISOString()
          }
        },
        { status: 429 }
      );
    }
    return jsonError(
      503,
      "MODEL_ATTEMPT_QUOTA_UNAVAILABLE",
      "模型尝试保护服务暂时不可用，请稍后重试。"
    );
  }

  if (
    modelAttemptReservation.idempotent ||
    modelAttemptReservation.status !== "reserved"
  ) {
    await releaseQuota({
      leaseId: reservation.leaseId,
      userId: session.user.id,
      reason: "model_attempt_request_reused"
    }).catch(() => undefined);
    return jsonError(
      409,
      "MODEL_ATTEMPT_REQUEST_REUSED",
      "这个模型请求标识已经使用，请刷新后重试。"
    );
  }

  let turn: PersistedTurn;
  try {
    turn = await createPendingTurn({
      userId: session.user.id,
      conversationId: parsed.data.conversationId,
      question: parsed.data.message,
      clientRequestId: parsed.data.clientRequestId,
      model: modelProvider.model
    });
  } catch (error) {
    await Promise.allSettled([
      releaseQuota({
        leaseId: reservation.leaseId,
        userId: session.user.id,
        reason: "message_persistence_failed"
      }),
      releaseQuota({
        leaseId: modelAttemptReservation.leaseId,
        userId: session.user.id,
        reason: "message_persistence_failed"
      })
    ]);
    if (error instanceof ConversationNotFoundError) {
      return jsonError(
        404,
        "CONVERSATION_NOT_FOUND",
        "这段对话不存在或已删除。"
      );
    }
    if (error instanceof AccountDeletionInProgressError) {
      return jsonError(409, error.code, "账号正在删除，不能再写入新数据。");
    }
    return jsonError(
      503,
      "PERSISTENCE_FAILED",
      "暂时无法保存问题，请稍后重试。"
    );
  }

  const encoder = new TextEncoder();
  const responseAbortController = new AbortController();
  const operationSignal = AbortSignal.any([
    request.signal,
    responseAbortController.signal
  ]);
  let streamClosed = false;
  const responseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const abortOperation = () => {
        if (!responseAbortController.signal.aborted) {
          responseAbortController.abort();
        }
      };
      const send = (event: Record<string, unknown>) => {
        if (streamClosed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          streamClosed = true;
          abortOperation();
        }
      };
      const heartbeat = setInterval(() => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          streamClosed = true;
          abortOperation();
        }
      }, 15_000);

      const startedAt = Date.now();
      let answer = "";
      let usage: ModelUsage | undefined;
      let invocation: InvocationHandle | undefined;
      let invocationSettled = false;
      let providerCallAttempted = false;
      let modelAttemptFinalized = false;

      try {
        send({
          type: "status",
          stage: "reserved",
          label: "已预占本次回答额度…"
        });
        const evidenceResult = await collectEvidence({
          question: parsed.data.message,
          userId: session.user.id,
          clientRequestId: parsed.data.clientRequestId,
          signal: operationSignal,
          onStage: (label) =>
            send({
              type: "status",
              stage: label.includes("权威") ? "searching" : "retrieving",
              label
            })
        });

        const activePrompt = await loadActiveRuntimePrompt();
        const prompt = buildExpertPrompt({
          question: parsed.data.message,
          evidence: evidenceResult.evidence,
          conversationContext: await loadConversationContext(
            turn.conversationId,
            turn.userMessageId
          ),
          operatorInstructions: activePrompt?.content
        });
        send({
          type: "status",
          stage: "answering",
          label: "正在组织有依据的回答…"
        });

        if (evidenceResult.evidence.length === 0) {
          answer = buildNoEvidenceAnswer({
            question: parsed.data.message,
            risk: prompt.risk
          });
          const releasedModelAttempt = await releaseQuota({
            leaseId: modelAttemptReservation.leaseId,
            userId: session.user.id,
            reason: "model_not_required"
          });
          if (releasedModelAttempt.status !== "released") {
            throw new ModelAttemptQuotaTransitionError();
          }
          modelAttemptFinalized = true;
        } else {
          const maximumOutputTokens = parseMaximumOutputTokens();
          invocation = await startModelInvocation({
            userId: session.user.id,
            conversationId: turn.conversationId,
            messageId: turn.assistantMessageId,
            clientRequestId: parsed.data.clientRequestId,
            provider: modelProvider.id,
            model: modelProvider.model,
            messages: prompt.messages,
            maximumOutputTokens,
            promptVersionId: activePrompt?.id,
            evidenceSourceIds: evidenceResult.evidence.map(
              (item) => item.citation.sourceId
            ),
            webSearched: evidenceResult.webSearched
          });
          operationSignal.throwIfAborted();
          const committedModelAttempt = await commitQuota({
            leaseId: modelAttemptReservation.leaseId,
            userId: session.user.id
          });
          if (committedModelAttempt.status !== "committed") {
            throw new ModelAttemptQuotaTransitionError();
          }
          modelAttemptFinalized = true;
          let providerRequestId: string | undefined;
          let finishReason: string | undefined;
          providerCallAttempted = true;
          for await (const event of modelProvider.stream({
            messages: prompt.messages,
            temperature: 0.1,
            maxOutputTokens: maximumOutputTokens,
            signal: operationSignal
          })) {
            if (event.type === "text-delta") {
              answer += event.text;
            } else if (event.type === "finish") {
              usage = event.usage;
              providerRequestId = event.providerRequestId;
              finishReason = event.finishReason;
            }
          }
          await completeModelInvocation({
            handle: invocation,
            usage,
            providerRequestId,
            finishReason
          });
          invocationSettled = true;
        }

        const citationValidation = validateAnswer(
          answer,
          evidenceResult.evidence,
          prompt.risk.level
        );
        const citedEvidence = selectCitationPrefix(
          evidenceResult.evidence,
          citationValidation.usedCitationNumbers
        );
        const modelingCards = await resolveAuthorizedModelingCards({
          ownerId: session.user.id,
          texts: [parsed.data.message, answer]
        });
        const meta: AnswerMeta = {
          riskLevel: prompt.risk.level,
          missingInputs: inferMissingInputs(parsed.data.message),
          webSearched: evidenceResult.webSearched,
          citations: citedEvidence.map((item) => item.citation),
          ...(modelingCards.length ? { modelingCards } : {})
        };
        const bufferedCitations = meta.citations.map(serializeCitation);

        send({
          type: "status",
          stage: "saving",
          label: "正在校验引用并保存回答…"
        });
        await completeTurn({
          userId: session.user.id,
          turn,
          answer,
          meta,
          evidence: citedEvidence,
          usage,
          latencyMs: Date.now() - startedAt,
          runtime: {
            provider: modelProvider.id,
            model: modelProvider.model,
            promptVersionId: activePrompt?.id ?? null,
            promptVersion: activePrompt?.version ?? null,
            sourceVersions: citedEvidence.map((item) => ({
              sourceId: item.citation.sourceId,
              fetchedAt: new Date(item.citation.fetchedAt).toISOString(),
              pageOrSection: item.citation.pageOrSection ?? null
            }))
          }
        });
        const committedReservation = await commitQuota({
          leaseId: reservation.leaseId,
          userId: session.user.id
        });
        if (committedReservation.status !== "committed") {
          throw new QuotaCommitError();
        }

        for (const text of chunkText(answer)) {
          send({ type: "delta", text });
        }
        for (const citation of bufferedCitations) {
          send({
            type: "citation",
            citation
          });
        }

        send({
          type: "complete",
          conversationId: turn.conversationId,
          messageId: turn.assistantMessageId,
          meta: {
            ...meta,
            citations: bufferedCitations
          }
        });
      } catch (error) {
        const cancelled = operationSignal.aborted;
        if (invocation && !invocationSettled) {
          await failModelInvocation({
            handle: invocation,
            status: cancelled ? "cancelled" : "failed",
            errorCode: cancelled ? "CLIENT_CANCELLED" : errorCode(error),
            errorMessage: safeErrorMessage(error),
            retainReservedEstimate: providerCallAttempted
          }).catch(() => undefined);
        }
        if (!modelAttemptFinalized) {
          await releaseQuota({
            leaseId: modelAttemptReservation.leaseId,
            userId: session.user.id,
            reason: cancelled
              ? "cancelled_before_model_attempt"
              : "failed_before_model_attempt"
          }).catch(() => undefined);
        }
        await failTurn(
          turn.assistantMessageId,
          cancelled ? "cancelled" : "failed",
          cancelled ? "CLIENT_CANCELLED" : errorCode(error),
          safeErrorMessage(error)
        ).catch(() => undefined);
        await releaseQuota({
          leaseId: reservation.leaseId,
          userId: session.user.id,
          reason: cancelled ? "client_cancelled" : "answer_failed"
        }).catch(() => undefined);
        send({
          type: "error",
          code: cancelled ? "CANCELLED" : errorCode(error),
          message: cancelled
            ? "已取消回答，本次不会扣除额度。"
            : userFacingFailureMessage(error)
        });
      } finally {
        clearInterval(heartbeat);
        if (!streamClosed) {
          streamClosed = true;
          controller.close();
        }
      }
    },
    cancel() {
      streamClosed = true;
      if (!responseAbortController.signal.aborted) {
        responseAbortController.abort();
      }
    }
  });

  return new Response(responseStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

async function createPendingTurn(input: {
  userId: string;
  conversationId?: string;
  question: string;
  clientRequestId: string;
  model: string;
}): Promise<PersistedTurn> {
  return db.transaction(async (tx) => {
    await assertAccountWritable(tx, input.userId);
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
      if (!owned) throw new ConversationNotFoundError();
    } else {
      const [created] = await tx
        .insert(conversations)
        .values({
          userId: input.userId,
          title: makeConversationTitle(input.question),
          model: input.model,
          lastMessageAt: now
        })
        .returning({ id: conversations.id });
      conversationId = created!.id;
    }

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${conversationId}))`
    );
    const [sequenceRow] = await tx
      .select({ value: max(messages.sequence) })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    const userSequence = (sequenceRow?.value ?? 0) + 1;
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();

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
        model: input.model,
        metadata: { clientRequestId: input.clientRequestId }
      }
    ]);
    await tx
      .update(conversations)
      .set({ lastMessageAt: now, updatedAt: now })
      .where(eq(conversations.id, conversationId));

    return { conversationId, userMessageId, assistantMessageId };
  });
}

async function completeTurn(input: {
  userId: string;
  turn: PersistedTurn;
  answer: string;
  meta: AnswerMeta;
  evidence: GroundingEvidence[];
  usage?: ModelUsage;
  latencyMs: number;
  runtime: {
    provider: string;
    model: string;
    promptVersionId: string | null;
    promptVersion: number | null;
    sourceVersions: Array<{
      sourceId: string;
      fetchedAt: string;
      pageOrSection: string | null;
    }>;
  };
}) {
  await db.transaction(async (tx) => {
    await assertAccountWritable(tx, input.userId);
    await tx
      .update(messages)
      .set({
        content: input.answer,
        status: "completed",
        inputTokens: input.usage?.inputTokens,
        outputTokens: input.usage?.outputTokens,
        latencyMs: input.latencyMs,
        completedAt: new Date(),
        metadata: {
          riskLevel: input.meta.riskLevel,
          missingInputs: input.meta.missingInputs,
          webSearched: input.meta.webSearched,
          ...(input.meta.modelingCards?.length
            ? { modelingCards: input.meta.modelingCards }
            : {}),
          ...input.runtime
        }
      })
      .where(eq(messages.id, input.turn.assistantMessageId));

    for (const [index, item] of input.evidence.entries()) {
      const [created] = await tx
        .insert(citations)
        .values({
          sourceType: item.citation.sourceId.startsWith("web:")
            ? "web"
            : "knowledge",
          title: item.citation.title,
          url: item.citation.url,
          quote: item.excerpt,
          sourceTier: item.citation.licenseClass,
          license: item.citation.licenseClass,
          locator: { pageOrSection: item.citation.pageOrSection ?? null },
          metadata: {
            publisher: item.citation.publisher,
            fetchedAt: new Date(item.citation.fetchedAt).toISOString(),
            sourceId: item.citation.sourceId
          }
        })
        .returning({ id: citations.id });
      await tx.insert(messageCitations).values({
        messageId: input.turn.assistantMessageId,
        citationId: created!.id,
        ordinal: index + 1
      });
    }
    await tx
      .update(conversations)
      .set({ lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(conversations.id, input.turn.conversationId));
  });
}

async function failTurn(
  assistantMessageId: string,
  status: "failed" | "cancelled",
  code: string,
  message: string
) {
  await db
    .update(messages)
    .set({
      status,
      errorCode: code,
      errorMessage: message,
      completedAt: new Date()
    })
    .where(eq(messages.id, assistantMessageId));
}

async function loadConversationContext(
  conversationId: string,
  currentUserMessageId: string
) {
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.status, "completed")
      )
    )
    .orderBy(desc(messages.sequence))
    .limit(10);

  return rows
    .filter((row) => row.id !== currentUserMessageId)
    .reverse()
    .map((row) => `${row.role === "user" ? "用户" : "OpenVac"}：${row.content}`)
    .join("\n");
}

async function findReplay(userId: string, clientRequestId: string) {
  const [userMessage] = await db
    .select({
      conversationId: messages.conversationId,
      sequence: messages.sequence
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.userId, userId),
        eq(messages.clientRequestId, clientRequestId),
        isNull(conversations.deletedAt)
      )
    )
    .limit(1);
  if (!userMessage) return null;

  const [assistant] = await db
    .select({
      id: messages.id,
      content: messages.content,
      status: messages.status,
      metadata: messages.metadata
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, userMessage.conversationId),
        eq(messages.sequence, userMessage.sequence + 1)
      )
    )
    .limit(1);
  if (!assistant || assistant.status !== "completed") return null;

  const storedCitations = await db
    .select({
      id: citations.id,
      title: citations.title,
      url: citations.url,
      license: citations.license,
      locator: citations.locator,
      metadata: citations.metadata
    })
    .from(messageCitations)
    .innerJoin(citations, eq(messageCitations.citationId, citations.id))
    .where(eq(messageCitations.messageId, assistant.id))
    .orderBy(asc(messageCitations.ordinal));

  return {
    conversationId: userMessage.conversationId,
    messageId: assistant.id,
    content: assistant.content,
    metadata: assistant.metadata,
    citations: storedCitations
  };
}

function replayResponse(
  replay: NonNullable<Awaited<ReturnType<typeof findReplay>>>
) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        const emit = (event: Record<string, unknown>) =>
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        for (const text of chunkText(replay.content)) {
          emit({ type: "delta", text });
        }
        const replayCitations = replay.citations
          .map((citation) => serializeStoredCitation(citation))
          .filter((citation) => citation !== null);
        const replayModelingCards = serializeStoredModelingCards(
          replay.metadata.modelingCards
        );
        replayCitations.forEach((citation) =>
          emit({ type: "citation", citation })
        );
        emit({
          type: "complete",
          conversationId: replay.conversationId,
          messageId: replay.messageId,
          meta: {
            riskLevel: replay.metadata.riskLevel ?? "low",
            missingInputs: replay.metadata.missingInputs ?? [],
            webSearched: replay.metadata.webSearched ?? false,
            citations: replayCitations,
            ...(replayModelingCards.length
              ? { modelingCards: replayModelingCards }
              : {})
          }
        });
        controller.close();
      }
    }),
    {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform"
      }
    }
  );
}

function validateAnswer(
  answer: string,
  evidence: GroundingEvidence[],
  riskLevel: AnswerMeta["riskLevel"]
) {
  if (!hasRequiredAnswerSections(answer)) {
    throw new InvalidAnswerError("模型回答未满足 OpenVac 的五段结构。");
  }
  const citationList = evidence.map((item) => item.citation);
  const result = validateCitations(answer, citationList, {
    knownSourceIds: citationList.map((citation) => citation.sourceId)
  });
  if (!result.valid) {
    throw new InvalidAnswerError(`引用校验失败：${result.errors.join(" ")}`);
  }
  if (riskLevel === "high") {
    const safety = validateHighRiskAnswerBoundaries(answer);
    if (!safety.valid) {
      throw new InvalidAnswerError(
        `高风险回答缺少安全边界：${safety.missing.join(", ")}。`
      );
    }
  }
  return result;
}

function inferMissingInputs(question: string) {
  const fields = [
    ["泵的准确型号", /(?:型号|model|[A-Z]{2,}[-\s]?\d{2,})/i],
    ["抽取介质", /(?:介质|气体|空气|氧气|氢气|溶剂|蒸气)/u],
    [
      "入口与目标压力",
      /(?:入口压力|目标压力|极限压力|工作压力|\bPa\b|mbar|Torr)/i
    ],
    ["目标或实测抽速", /(?:抽速|L\/s|m³\/h|m3\/h)/i],
    ["温度与运行时间", /(?:温度|℃|°C|运行.{0,5}(?:分钟|小时))/i]
  ] as const;
  return fields
    .filter(([, pattern]) => !pattern.test(question))
    .map(([label]) => label)
    .slice(0, 4);
}

function makeConversationTitle(question: string) {
  const compact = question.replace(/\s+/g, " ").trim();
  return compact.length <= 28 ? compact : `${compact.slice(0, 28)}…`;
}

function serializeCitation(citation: Citation) {
  return {
    ...citation,
    sourcePolicy: citationSourcePolicy(citation.url, citation.licenseClass),
    fetchedAt: new Date(citation.fetchedAt).toISOString()
  };
}

function parseMaximumOutputTokens() {
  const value = Number.parseInt(
    process.env.MODEL_MAX_OUTPUT_TOKENS ?? "4096",
    10
  );
  return Number.isSafeInteger(value) && value > 0 ? value : 4096;
}

function chunkText(value: string, maximumCharacters = 320): string[] {
  const characters = Array.from(value);
  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < characters.length;
    offset += maximumCharacters
  ) {
    chunks.push(characters.slice(offset, offset + maximumCharacters).join(""));
  }
  return chunks;
}

function errorCode(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof InvalidAnswerError
    ? "ANSWER_VALIDATION_FAILED"
    : "ANSWER_FAILED";
}

function safeErrorMessage(error: unknown) {
  if (error instanceof InvalidAnswerError) return error.message;
  if (error instanceof ModelRuntimeError) return error.message;
  if (error instanceof AccountDeletionInProgressError) return error.message;
  return "Provider or persistence operation failed.";
}

function userFacingFailureMessage(error: unknown) {
  if (error instanceof AccountDeletionInProgressError) {
    return "账号正在删除，本次回答已停止，回答额度已归还。";
  }
  if (error instanceof ModelRuntimeError) {
    if (error.code === "MODEL_DISABLED") {
      return "回答模型当前已停用，本次额度已归还。";
    }
    if (error.code.includes("BUDGET")) {
      return "系统当前已触发模型预算保护，本次额度已归还，请稍后再试。";
    }
    if (error.code === "MODEL_PRICING_UNCONFIGURED") {
      return "模型成本配置尚未完成，本次额度已归还。";
    }
  }
  return "本次回答未能通过证据、引用或系统校验，额度已归还。";
}

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

class ConversationNotFoundError extends Error {}
class InvalidAnswerError extends Error {}
class QuotaCommitError extends Error {
  readonly code = "QUOTA_COMMIT_FAILED";
}
class ModelAttemptQuotaTransitionError extends Error {
  readonly code = "MODEL_ATTEMPT_QUOTA_TRANSITION_FAILED";
}
