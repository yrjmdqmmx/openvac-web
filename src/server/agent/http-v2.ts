import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  AgentRunOrchestrator,
  AgentRuntimeError,
  answerV3Blocks,
  answerSections,
  classifyVacuumRisk,
  resolveAgentMode,
  RunStore,
  RunStoreError,
  type CreatedRun,
  type OrchestratorEvent
} from "@/server/agent";
import { auth } from "@/server/auth";
import { ApiError } from "@/server/api/errors";
import { chatAttachmentService } from "@/server/chat-attachments";
import { inputMessagePartsSchema } from "@/server/chat-v3/contracts";
import { isEffectiveBan } from "@/server/auth/ban-policy";
import { db } from "@/server/db";
import { systemSettings, user } from "@/server/db/schema";
import { ModelRuntimeError } from "@/server/operations/model-runtime";
import {
  createDeepSeekUserPartition,
  ProviderError,
  routeCapabilities
} from "@/server/providers";
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
import type { ChatStreamEvent } from "@/types/chat";
import type { InputMessagePart } from "@/types/chat-v3";

const requestSchema = z.union([
  z.object({
    protocolVersion: z.literal(2),
    conversationId: z.string().uuid().optional(),
    message: z.string().trim().min(2).max(4_000),
    clientRequestId: z.string().uuid(),
    mode: z.enum(["auto", "deep"]),
    webMode: z.enum(["auto", "always"])
  }),
  z.object({
    protocolVersion: z.literal(3),
    conversationId: z.string().uuid().optional(),
    parts: inputMessagePartsSchema,
    clientRequestId: z.string().uuid(),
    mode: z.enum(["auto", "deep"]),
    webMode: z.enum(["auto", "always"])
  })
]);

const actionRequestSchema = z.object({
  action: z.enum(["retry", "regenerate", "continue"]),
  clientRequestId: z.string().uuid(),
  mode: z.enum(["auto", "deep"]),
  webMode: z.enum(["auto", "always"])
});

const store = new RunStore();

type V2StreamEvent = Extract<ChatStreamEvent, { runId: string }>;
type UnsequencedV2Event<T = V2StreamEvent> = T extends V2StreamEvent
  ? Omit<T, "runId" | "sequence">
  : never;

export async function agentResponsesV3Enabled(): Promise<boolean> {
  if (process.env.AGENT_RESPONSES_V2 !== "true") return false;
  try {
    const [setting] = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, "agent_responses_v2_enabled"))
      .limit(1);
    return setting?.value !== false;
  } catch {
    return false;
  }
}

export const agentResponsesV2Enabled = agentResponsesV3Enabled;

export async function postAgentV3(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return jsonError(401, "UNAUTHENTICATED", "请先登录并完成邮箱验证。");
  }
  const parsed = requestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return jsonError(400, "INVALID_REQUEST", "Agent 请求格式不正确。");
  }
  const inputParts: InputMessagePart[] =
    parsed.data.protocolVersion === 3
      ? parsed.data.parts
      : [{ type: "text", text: parsed.data.message }];
  const question = projectInputParts(inputParts);
  const accountFailure = await checkAccount(session.user.id);
  if (accountFailure) return accountFailure;

  const previous = await store.lookupClientRequest(
    session.user.id,
    parsed.data.clientRequestId
  );
  if (previous?.kind === "replay") return replayResponse(previous.replay);
  if (previous?.kind === "busy") {
    return jsonError(409, "CONVERSATION_BUSY", "这段对话已有回答正在生成。");
  }
  if (previous) {
    return jsonError(409, "REQUEST_ALREADY_USED", "这个请求标识已经使用。");
  }

  const reservations = await reserveRunQuotas({
    userId: session.user.id,
    clientRequestId: parsed.data.clientRequestId,
    conversationId: parsed.data.conversationId
  });
  if (reservations instanceof Response) return reservations;

  const risk = classifyVacuumRisk(question);
  const resolvedMode = resolveAgentMode({
    requested: parsed.data.mode,
    question,
    riskLevel: risk.level
  });
  let created;
  try {
    created = await store.createInitial({
      userId: session.user.id,
      conversationId: parsed.data.conversationId,
      question,
      inputParts,
      clientRequestId: parsed.data.clientRequestId,
      requestedMode: parsed.data.mode,
      resolvedMode,
      webMode: parsed.data.webMode,
      riskLevel: risk.level,
      model: "deepseek-v4-flash"
    });
  } catch (error) {
    await releaseRunReservations(
      reservations,
      session.user.id,
      "run_create_failed"
    );
    if (
      error instanceof RunStoreError &&
      error.code === "CONVERSATION_NOT_FOUND"
    ) {
      return jsonError(404, error.code, "这段对话不存在或已删除。");
    }
    return jsonError(503, "RUN_CREATE_FAILED", "暂时无法创建本次回答。");
  }
  if (created.kind !== "created") {
    await releaseRunReservations(
      reservations,
      session.user.id,
      "run_not_created"
    );
    if (created.kind === "replay") return replayResponse(created.replay);
    if (created.kind === "busy") {
      return jsonError(409, "CONVERSATION_BUSY", "这段对话已有回答正在生成。");
    }
    return jsonError(409, "REQUEST_ALREADY_USED", "这个请求标识已经使用。");
  }

  const attachmentIds = inputParts.flatMap((part) =>
    part.type === "attachment" ? [part.attachmentId] : []
  );
  if (attachmentIds.length > 0) {
    try {
      await chatAttachmentService.bindToMessage({
        attachmentIds,
        conversationId: created.run.conversationId,
        messageId: created.run.userMessageId,
        userId: session.user.id
      });
    } catch (error) {
      await Promise.allSettled([
        releaseRunReservations(
          reservations,
          session.user.id,
          "attachment_bind_failed"
        ),
        store.fail({
          run: created.run,
          status: "failed",
          code:
            error instanceof ApiError
              ? error.code
              : "ATTACHMENT_BIND_UNAVAILABLE",
          message: "Attachment binding failed before model execution."
        })
      ]);
      return error instanceof ApiError
        ? jsonError(error.status, error.code, error.message)
        : jsonError(
            503,
            "ATTACHMENT_BIND_UNAVAILABLE",
            "附件暂时无法绑定到这条消息，请稍后重试。"
          );
    }
  }

  const modelAttempt = await commitQuota({
    leaseId: reservations.modelAttempt.leaseId,
    userId: session.user.id
  }).catch(() => undefined);
  if (modelAttempt?.status !== "committed") {
    await Promise.allSettled([
      releaseQuota({
        leaseId: reservations.answer.leaseId,
        userId: session.user.id,
        reason: "model_attempt_commit_failed"
      }),
      store.fail({
        run: created.run,
        status: "failed",
        code: "MODEL_ATTEMPT_COMMIT_FAILED",
        message: "Model attempt quota transition failed."
      })
    ]);
    return jsonError(
      503,
      "MODEL_ATTEMPT_COMMIT_FAILED",
      "模型保护额度暂时不可用。"
    );
  }

  let userPartition: string;
  try {
    userPartition = createDeepSeekUserPartition(
      session.user.id,
      process.env.DEEPSEEK_USER_PARTITION_SECRET ?? ""
    );
  } catch {
    await Promise.allSettled([
      releaseQuota({
        leaseId: reservations.answer.leaseId,
        userId: session.user.id,
        reason: "partition_configuration_failed"
      }),
      store.fail({
        run: created.run,
        status: "failed",
        code: "RESPONSES_USER_PARTITION_UNAVAILABLE",
        message: "DeepSeek user partition secret is unavailable."
      })
    ]);
    return jsonError(
      503,
      "RESPONSES_USER_PARTITION_UNAVAILABLE",
      "Agent 隐私分区配置尚未完成。"
    );
  }

  return streamRun({
    request,
    userId: session.user.id,
    userPartition,
    clientRequestId: parsed.data.clientRequestId,
    run: created.run,
    requestedMode: parsed.data.mode,
    resolvedMode,
    webMode: parsed.data.webMode,
    riskLevel: risk.level,
    answerReservation: reservations.answer
  });
}

export const postAgentV2 = postAgentV3;

export async function postAgentActionV3(
  request: Request,
  turnId: string
): Promise<Response> {
  if (!(await agentResponsesV2Enabled())) {
    return jsonError(404, "AGENT_DISABLED", "Agent 当前未启用。");
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return jsonError(401, "UNAUTHENTICATED", "请先登录并完成邮箱验证。");
  }
  if (!z.string().uuid().safeParse(turnId).success) {
    return jsonError(400, "INVALID_TURN_ID", "回答轮次标识不正确。");
  }
  const parsed = actionRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return jsonError(400, "INVALID_REQUEST", "回答操作请求格式不正确。");
  }
  const accountFailure = await checkAccount(session.user.id);
  if (accountFailure) return accountFailure;
  const previous = await store.lookupClientRequest(
    session.user.id,
    parsed.data.clientRequestId
  );
  if (previous?.kind === "replay") return replayResponse(previous.replay);
  if (previous?.kind === "busy") {
    return jsonError(409, "CONVERSATION_BUSY", "这段对话已有回答正在生成。");
  }
  if (previous) {
    return jsonError(409, "REQUEST_ALREADY_USED", "这个请求标识已经使用。");
  }
  const question = await store.getTurnQuestion(session.user.id, turnId);
  if (!question)
    return jsonError(404, "TURN_NOT_FOUND", "这轮对话不存在或已删除。");

  const reservations = await reserveRunQuotas({
    userId: session.user.id,
    clientRequestId: parsed.data.clientRequestId
  });
  if (reservations instanceof Response) return reservations;
  const risk = classifyVacuumRisk(question);
  const resolvedMode = resolveAgentMode({
    requested: parsed.data.mode,
    question,
    riskLevel: risk.level
  });
  let created;
  try {
    created = await store.createAction({
      userId: session.user.id,
      turnId,
      clientRequestId: parsed.data.clientRequestId,
      action: parsed.data.action,
      requestedMode: parsed.data.mode,
      resolvedMode,
      webMode: parsed.data.webMode,
      riskLevel: risk.level,
      model: "deepseek-v4-flash"
    });
  } catch (error) {
    await releaseRunReservations(
      reservations,
      session.user.id,
      "action_run_create_failed"
    );
    if (error instanceof RunStoreError && error.code === "ACTION_NOT_ALLOWED") {
      return jsonError(409, error.code, "当前回答状态不支持这个操作。");
    }
    if (error instanceof RunStoreError && error.code === "TURN_NOT_FOUND") {
      return jsonError(404, error.code, "这轮对话不存在或已删除。");
    }
    return jsonError(503, "RUN_CREATE_FAILED", "暂时无法创建本次回答操作。");
  }
  if (created.kind !== "created") {
    await releaseRunReservations(
      reservations,
      session.user.id,
      "action_run_not_created"
    );
    if (created.kind === "replay") return replayResponse(created.replay);
    if (created.kind === "busy") {
      return jsonError(409, "CONVERSATION_BUSY", "这段对话已有回答正在生成。");
    }
    return jsonError(409, "REQUEST_ALREADY_USED", "这个请求标识已经使用。");
  }
  const modelAttempt = await commitQuota({
    leaseId: reservations.modelAttempt.leaseId,
    userId: session.user.id
  }).catch(() => undefined);
  if (modelAttempt?.status !== "committed") {
    await Promise.allSettled([
      releaseQuota({
        leaseId: reservations.answer.leaseId,
        userId: session.user.id,
        reason: "model_attempt_commit_failed"
      }),
      store.fail({
        run: created.run,
        status: "failed",
        code: "MODEL_ATTEMPT_COMMIT_FAILED",
        message: "Model attempt quota transition failed."
      })
    ]);
    return jsonError(
      503,
      "MODEL_ATTEMPT_COMMIT_FAILED",
      "模型保护额度暂时不可用。"
    );
  }
  let userPartition: string;
  try {
    userPartition = createDeepSeekUserPartition(
      session.user.id,
      process.env.DEEPSEEK_USER_PARTITION_SECRET ?? ""
    );
  } catch {
    await Promise.allSettled([
      releaseQuota({
        leaseId: reservations.answer.leaseId,
        userId: session.user.id,
        reason: "partition_configuration_failed"
      }),
      store.fail({
        run: created.run,
        status: "failed",
        code: "RESPONSES_USER_PARTITION_UNAVAILABLE",
        message: "DeepSeek user partition secret is unavailable."
      })
    ]);
    return jsonError(
      503,
      "RESPONSES_USER_PARTITION_UNAVAILABLE",
      "Agent 隐私分区配置尚未完成。"
    );
  }
  return streamRun({
    request,
    userId: session.user.id,
    userPartition,
    clientRequestId: parsed.data.clientRequestId,
    run: created.run,
    requestedMode: parsed.data.mode,
    resolvedMode,
    webMode: parsed.data.webMode,
    riskLevel: risk.level,
    answerReservation: reservations.answer
  });
}

export const postAgentActionV2 = postAgentActionV3;

export async function cancelAgentRunV3(
  request: Request,
  runId: string
): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return jsonError(401, "UNAUTHENTICATED", "请先登录并完成邮箱验证。");
  }
  if (!z.string().uuid().safeParse(runId).success) {
    return jsonError(400, "INVALID_RUN_ID", "运行标识不正确。");
  }
  const result = await store.requestCancellation({
    userId: session.user.id,
    runId
  });
  if (result === "not_found") {
    return jsonError(404, "RUN_NOT_FOUND", "这次运行不存在或无权访问。");
  }
  if (result === "already_finished") {
    return jsonError(409, "RUN_ALREADY_FINISHED", "回答已经结束，无法取消。");
  }
  return Response.json({ data: { runId, status: "cancellation_requested" } });
}

export const cancelAgentRunV2 = cancelAgentRunV3;

function streamRun(input: {
  request: Request;
  userId: string;
  userPartition: string;
  clientRequestId: string;
  run: CreatedRun;
  requestedMode: "auto" | "deep";
  resolvedMode: "fast" | "deep";
  webMode: "auto" | "always";
  riskLevel: "low" | "medium" | "high";
  answerReservation: QuotaReservation;
}): Response {
  const encoder = new TextEncoder();
  const controller = new AbortController();
  const signal = AbortSignal.any([input.request.signal, controller.signal]);
  const unregister = store.registerController(input.run.runId, controller);
  let sequence = 0;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(target) {
      const send = (event: UnsequencedV2Event) => {
        if (closed) return;
        try {
          target.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ ...event, runId: input.run.runId, sequence: ++sequence })}\n\n`
            )
          );
        } catch {
          closed = true;
          controller.abort(new Error("CLIENT_STREAM_CLOSED"));
        }
      };
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          target.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          closed = true;
          controller.abort(new Error("CLIENT_STREAM_CLOSED"));
        }
      }, 15_000);
      heartbeat.unref?.();

      send({
        type: "run.accepted",
        turnId: input.run.turnId,
        conversationId: input.run.conversationId,
        userMessageId: input.run.userMessageId,
        messageId: input.run.assistantMessageId,
        answerVersion: input.run.answerVersion
      });
      const hasAttachments = input.run.inputParts.some(
        (part) => part.type === "attachment"
      );
      const capabilities = routeCapabilities({
        hasImages: hasAttachments,
        hasDocuments: hasAttachments
      });
      const orchestrator = new AgentRunOrchestrator(
        capabilities.reasoningProvider,
        store,
        (event) => emitOrchestratorEvent(send, event),
        {
          visionProvider: capabilities.visionProvider,
          documentParser: capabilities.documentParser
        }
      );
      try {
        const result = await orchestrator.run({
          userId: input.userId,
          userPartition: input.userPartition,
          clientRequestId: input.clientRequestId,
          run: input.run,
          requestedMode: input.requestedMode,
          resolvedMode: input.resolvedMode,
          webMode: input.webMode,
          riskLevel: input.riskLevel,
          signal
        });
        if (result.status === "completed") {
          await commitQuota({
            leaseId: input.answerReservation.leaseId,
            userId: input.userId
          }).catch(() => undefined);
        } else {
          await releaseQuota({
            leaseId: input.answerReservation.leaseId,
            userId: input.userId,
            reason: "agent_run_incomplete"
          }).catch(() => undefined);
        }
        send({
          type: "run.completed",
          conversationId: input.run.conversationId,
          turnId: input.run.turnId,
          messageId: input.run.assistantMessageId,
          answerVersion: input.run.answerVersion,
          answer: result.answer,
          meta: result.meta
        });
      } catch (error) {
        const cancelled = signal.aborted;
        await Promise.allSettled([
          releaseQuota({
            leaseId: input.answerReservation.leaseId,
            userId: input.userId,
            reason: cancelled ? "agent_run_cancelled" : "agent_run_failed"
          }),
          store.fail({
            run: input.run,
            status: cancelled ? "cancelled" : "failed",
            code: cancelled ? "CANCELLED" : publicErrorCode(error),
            message: safeStoredError(error),
            counters: orchestrator.counters
          })
        ]);
        if (cancelled) {
          send({
            type: "run.cancelled",
            code: "CANCELLED",
            message: "已取消本次回答，未扣除成功回答额度。",
            charged: false
          });
        } else {
          send({
            type: "run.failed",
            code: publicErrorCode(error),
            message: publicErrorMessage(error),
            retryable: isRetryable(error),
            suggestedAction: isRetryable(error) ? "retry" : "report",
            charged: false
          });
        }
      } finally {
        clearInterval(heartbeat);
        unregister();
        if (!closed) {
          closed = true;
          target.close();
        }
      }
    },
    cancel(reason) {
      closed = true;
      controller.abort(reason);
      unregister();
    }
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

function emitOrchestratorEvent(
  send: (event: UnsequencedV2Event) => void,
  event: OrchestratorEvent
): void {
  if (event.type === "stage") {
    send({
      type: "stage.changed",
      stage: event.stage,
      label: event.label
    });
  } else if (event.type === "tool") {
    send({
      type: `tool.${event.status}`,
      label: event.label
    });
  } else if (event.type === "block") {
    send({
      type: "answer.block.committed",
      block: event.block,
      index: event.index
    });
  } else {
    send({ type: "citation.committed", citation: event.citation });
  }
}

function replayResponse(
  replay: Extract<
    Awaited<ReturnType<RunStore["lookupClientRequest"]>>,
    { kind: "replay" }
  >["replay"]
): Response {
  const encoder = new TextEncoder();
  let sequence = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: UnsequencedV2Event) =>
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ ...event, runId: replay.runId, sequence: ++sequence })}\n\n`
            )
          );
        send({
          type: "run.accepted",
          turnId: replay.turnId,
          conversationId: replay.conversationId,
          userMessageId: replay.userMessageId,
          messageId: replay.messageId,
          answerVersion: replay.answerVersion
        });
        if (replay.answer.schemaVersion === "openvac.answer.v3") {
          for (const { block, index } of answerV3Blocks(replay.answer)) {
            send({ type: "answer.block.committed", block, index });
          }
        } else {
          for (const section of answerSections(replay.answer)) {
            send({ type: "answer.section.committed", ...section });
          }
        }
        for (const citation of replay.meta.citations) {
          send({ type: "citation.committed", citation });
        }
        send({
          type: "run.completed",
          conversationId: replay.conversationId,
          turnId: replay.turnId,
          messageId: replay.messageId,
          answerVersion: replay.answerVersion,
          answer: replay.answer,
          meta: replay.meta
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

async function reserveRunQuotas(input: {
  userId: string;
  clientRequestId: string;
  conversationId?: string;
}): Promise<
  { answer: QuotaReservation; modelAttempt: QuotaReservation } | Response
> {
  let answer: QuotaReservation;
  try {
    answer = await reserveAnswerQuota({
      userId: input.userId,
      clientRequestId: input.clientRequestId,
      metadata: { conversationId: input.conversationId ?? null, protocol: 3 }
    });
  } catch (error) {
    return quotaError(error, "今天的成功回答额度已用完。");
  }
  if (answer.idempotent || answer.status !== "reserved") {
    return jsonError(409, "REQUEST_IN_PROGRESS", "同一请求正在处理中。");
  }
  try {
    const modelAttempt = await reserveModelAttemptQuota({
      userId: input.userId,
      clientRequestId: `${input.clientRequestId}:model-v3`,
      metadata: { conversationId: input.conversationId ?? null, protocol: 3 }
    });
    if (modelAttempt.idempotent || modelAttempt.status !== "reserved") {
      await releaseQuota({
        leaseId: answer.leaseId,
        userId: input.userId,
        reason: "model_attempt_request_reused"
      }).catch(() => undefined);
      return jsonError(409, "REQUEST_IN_PROGRESS", "同一请求正在处理中。");
    }
    return { answer, modelAttempt };
  } catch (error) {
    await releaseQuota({
      leaseId: answer.leaseId,
      userId: input.userId,
      reason: "model_attempt_reservation_failed"
    }).catch(() => undefined);
    return quotaError(error, "模型尝试次数已达到今日保护上限。");
  }
}

async function releaseRunReservations(
  reservations: { answer: QuotaReservation; modelAttempt: QuotaReservation },
  userId: string,
  reason: string
): Promise<void> {
  await Promise.allSettled([
    releaseQuota({ leaseId: reservations.answer.leaseId, userId, reason }),
    releaseQuota({ leaseId: reservations.modelAttempt.leaseId, userId, reason })
  ]);
}

async function checkAccount(userId: string): Promise<Response | undefined> {
  const [account] = await db
    .select({
      banned: user.banned,
      banReason: user.banReason,
      banExpires: user.banExpires,
      deletionRequestedAt: user.deletionRequestedAt
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (account && isEffectiveBan(account)) {
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
  return undefined;
}

function quotaError(error: unknown, limitMessage: string): Response {
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
          message: limitMessage,
          resetAt: error.resetAt.toISOString()
        }
      },
      { status: 429 }
    );
  }
  return jsonError(503, "QUOTA_UNAVAILABLE", "额度服务暂时不可用。");
}

function projectInputParts(parts: InputMessagePart[]): string {
  const text = parts
    .filter(
      (part): part is Extract<InputMessagePart, { type: "text" }> =>
        part.type === "text"
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const links = parts.filter((part) => part.type === "link").length;
  const attachments = parts.filter((part) => part.type === "attachment").length;
  return [
    text || "请分析本条消息附带的资料。",
    links > 0 ? `本条消息包含 ${links} 个待核验链接。` : "",
    attachments > 0 ? `本条消息包含 ${attachments} 个私有附件。` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function publicErrorCode(error: unknown): string {
  if (error instanceof AgentRuntimeError) return error.code;
  if (error instanceof ModelRuntimeError) return error.code;
  if (error instanceof ProviderError) {
    if (error.status === 401) return "PROVIDER_AUTHENTICATION_FAILED";
    if (error.status === 402) return "PROVIDER_BILLING_REQUIRED";
    return "PROVIDER_UNAVAILABLE";
  }
  return "AGENT_RUN_FAILED";
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof AgentRuntimeError && !error.retryable) {
    return "本次回答未通过结构、引用或安全校验，成功回答额度已归还。";
  }
  if (error instanceof ModelRuntimeError && error.code.includes("BUDGET")) {
    return "系统已触发模型预算保护，成功回答额度已归还。";
  }
  if (
    error instanceof ProviderError &&
    [401, 402].includes(error.status ?? 0)
  ) {
    return "回答服务配置异常，已阻止本次回答并归还额度。";
  }
  return "本次回答未完成，成功回答额度已归还，可稍后重试。";
}

function safeStoredError(error: unknown): string {
  if (
    error instanceof AgentRuntimeError ||
    error instanceof ModelRuntimeError
  ) {
    return error.message.slice(0, 1_000);
  }
  if (error instanceof ProviderError) {
    return `${error.name}:${error.status ?? "unknown"}`;
  }
  return error instanceof Error ? error.name : "Unknown error";
}

function isRetryable(error: unknown): boolean {
  if (error instanceof AgentRuntimeError) return error.retryable;
  if (error instanceof ProviderError) return error.retryable;
  return false;
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
