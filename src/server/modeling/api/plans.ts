import {
  applyOperationBatch,
  hashCanonicalSpec,
  hashModelingPlanDraft,
  modelDocumentSchema,
  modelingPlanDraftSchema
} from "@/lib/modeling/protocol";
import { authenticate } from "@/server/api/auth";
import {
  ApiError,
  jsonData,
  notFound,
  parseJson,
  parseSearchParams
} from "@/server/api/errors";
import {
  modelingRepository,
  type ModelingRepository
} from "@/server/modeling/repository";
import {
  commitQuota,
  QuotaExceededError,
  releaseQuota,
  reserveAnswerQuota,
  type QuotaReservation,
  type ReserveQuotaInput,
  type TransitionQuotaInput
} from "@/server/quota";
import type { ModelingPlanDraft } from "@/types/modeling";

import {
  confirmAiPlanSchema,
  createAiPlanSchema,
  modelingPageSchema,
  modelingUuidSchema
} from "./schemas";
import {
  jobDto,
  parseIdempotencyOnly,
  planDto,
  requireIdempotencyKey,
  revisionDto,
  withModelingApiErrors
} from "./shared";

interface ModelingPlanQuotaPort {
  reserve(
    input: Omit<ReserveQuotaInput, "resource">
  ): Promise<QuotaReservation>;
  commit(input: TransitionQuotaInput): Promise<QuotaReservation>;
  release(input: TransitionQuotaInput): Promise<QuotaReservation>;
}

const modelingPlanQuota: ModelingPlanQuotaPort = {
  reserve: reserveAnswerQuota,
  commit: commitQuota,
  release: releaseQuota
};

export function hashVisiblePlanDraft(draft: ModelingPlanDraft): string {
  return hashModelingPlanDraft(draft);
}

export const handleListAiPlans = withModelingApiErrors(
  async (
    request: Request,
    projectId: string,
    repository: ModelingRepository = modelingRepository
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(projectId);
    const query = parseSearchParams(request, modelingPageSchema);
    const result = await repository.listPlans(
      user.id,
      id,
      query.page,
      query.pageSize
    );
    if (!result) {
      throw notFound("建模项目");
    }
    return jsonData({ ...result, items: result.items.map(planDto) });
  }
);

export const handleCreateAiPlan = withModelingApiErrors(
  async (
    request: Request,
    projectId: string,
    repository: ModelingRepository = modelingRepository,
    quota: ModelingPlanQuotaPort = modelingPlanQuota
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(projectId);
    const input = await parseJson(request, createAiPlanSchema);
    const idempotencyKey = requireIdempotencyKey(request, input.idempotencyKey);
    let reservation: QuotaReservation;
    try {
      reservation = await quota.reserve({
        userId: user.id,
        clientRequestId: `modeling-plan:${id}:${idempotencyKey}`,
        metadata: {
          kind: "modeling_plan",
          projectId: id,
          baseRevisionId: input.baseRevisionId
        }
      });
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        throw new ApiError(
          429,
          "AI_QUOTA_EXCEEDED",
          "今天的 AI 计划额度已用完；纯手工确定性建模仍可继续使用。",
          { resetAt: error.resetAt.toISOString() }
        );
      }
      throw new ApiError(
        503,
        "QUOTA_UNAVAILABLE",
        "AI 计划额度服务暂时不可用，请稍后重试。"
      );
    }

    if (reservation.idempotent && reservation.status === "released") {
      throw new ApiError(
        409,
        "REQUEST_ALREADY_RELEASED",
        "该 AI 计划请求标识已经释放，请使用新的请求标识重试。"
      );
    }

    let result: NonNullable<
      Awaited<ReturnType<ModelingRepository["createAiPlanJob"]>>
    >;
    try {
      const queued = await repository.createAiPlanJob({
        ownerId: user.id,
        projectId: id,
        baseRevisionId: input.baseRevisionId,
        prompt: input.prompt,
        selectedSemanticRefs: input.selectedSemanticRefs,
        idempotencyKey
      });
      if (!queued) {
        throw notFound("建模项目");
      }
      result = queued;
    } catch (error) {
      if (!reservation.idempotent && reservation.status === "reserved") {
        try {
          await quota.release({
            leaseId: reservation.leaseId,
            userId: user.id,
            reason: "modeling_plan_enqueue_failed"
          });
        } catch (releaseError) {
          throw new AggregateError(
            [error, releaseError],
            "AI 建模计划入队失败，且额度预留无法释放。"
          );
        }
      }
      throw error;
    }

    if (reservation.status === "reserved") {
      try {
        await quota.commit({ leaseId: reservation.leaseId, userId: user.id });
      } catch (commitError) {
        // A fresh enqueue and its quota transition form a small saga. If the
        // commit fails, only release the reservation after the queued job has
        // been atomically moved to `cancelled`; otherwise a worker could run a
        // free AI plan. Replayed jobs keep their reservation so a retry can
        // finish the same commit instead of cancelling somebody else's work.
        if (!result.replayed && !reservation.idempotent) {
          let cancellation: Awaited<
            ReturnType<ModelingRepository["cancelJob"]>
          >;
          try {
            cancellation = await repository.cancelJob(user.id, result.value.id);
          } catch (cancelError) {
            throw new AggregateError(
              [commitError, cancelError],
              "AI 建模计划额度确认失败，且排队任务无法安全取消；额度预留已保留。"
            );
          }

          if (cancellation?.job.status === "cancelled") {
            try {
              await quota.release({
                leaseId: reservation.leaseId,
                userId: user.id,
                reason: "modeling_plan_quota_commit_failed"
              });
            } catch (releaseError) {
              throw new AggregateError(
                [commitError, releaseError],
                "AI 建模计划已取消，但额度预留无法释放。"
              );
            }
            throw new ApiError(
              503,
              "QUOTA_COMMIT_FAILED",
              "AI 计划额度确认失败，任务已安全取消；请使用新的请求标识重试。"
            );
          }
        }

        throw new ApiError(
          503,
          "QUOTA_COMMIT_PENDING",
          "AI 计划额度确认暂时失败；任务未被重复创建，额度预留已保留，请稍后使用同一请求标识重试。"
        );
      }
    }
    return jsonData(
      {
        job: jobDto(result.value),
        plan: null,
        idempotentReplay: result.replayed
      },
      {
        status: result.replayed ? 200 : 202,
        headers: result.replayed ? { "idempotency-replayed": "true" } : {}
      }
    );
  }
);

export const handleGetAiPlan = withModelingApiErrors(
  async (
    request: Request,
    planId: string,
    repository: ModelingRepository = modelingRepository
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(planId);
    const plan = await repository.getPlan(user.id, id);
    if (!plan) {
      throw notFound("AI 建模方案");
    }
    return jsonData(planDto(plan));
  }
);

export const handleConfirmAiPlan = withModelingApiErrors(
  async (
    request: Request,
    planId: string,
    repository: ModelingRepository = modelingRepository
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(planId);
    const input = await parseJson(request, confirmAiPlanSchema);
    // The client confirmation key protects retries at the HTTP boundary. The
    // immutable server-generated operation batch owns the revision key/id.
    requireIdempotencyKey(request, input.idempotencyKey);
    const plan = await repository.getPlan(user.id, id);
    if (!plan) {
      throw notFound("AI 建模方案");
    }
    const draft = modelingPlanDraftSchema.parse(plan.draft);
    if (hashVisiblePlanDraft(draft) !== plan.planHash) {
      throw new ApiError(
        409,
        "PLAN_INTEGRITY_ERROR",
        "AI 方案内容与校验哈希不一致，请重新生成方案。"
      );
    }
    if (draft.status !== "validated" || !draft.operationBatch) {
      throw new ApiError(
        409,
        "PLAN_NOT_CONFIRMABLE",
        "当前 AI 方案仍缺少输入或尚未通过校验。"
      );
    }
    const base = await repository.getRevision(
      user.id,
      plan.projectId,
      plan.baseRevisionId
    );
    if (!base) {
      throw notFound("AI 方案基础版本");
    }
    const baseDocument = modelDocumentSchema.parse(base.document);
    const document = applyOperationBatch(baseDocument, draft.operationBatch);
    const result = await repository.confirmPlan({
      ownerId: user.id,
      planId: id,
      expectedBaseRevisionId: input.baseRevisionId,
      expectedPlanHash: input.planHash,
      idempotencyKey: draft.operationBatch.idempotencyKey,
      document,
      contentHash: hashCanonicalSpec(document)
    });
    if (!result) {
      throw notFound("AI 建模方案");
    }
    return jsonData(
      {
        revision: revisionDto(result.value),
        idempotentReplay: result.replayed
      },
      {
        headers: result.replayed ? { "idempotency-replayed": "true" } : {}
      }
    );
  }
);

export const handleRejectAiPlan = withModelingApiErrors(
  async (
    request: Request,
    planId: string,
    repository: ModelingRepository = modelingRepository
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(planId);
    await parseIdempotencyOnly(request);
    const result = await repository.rejectPlan(user.id, id);
    if (!result) {
      throw notFound("AI 建模方案");
    }
    return jsonData(
      { plan: planDto(result.value), idempotentReplay: result.replayed },
      {
        headers: result.replayed ? { "idempotency-replayed": "true" } : {}
      }
    );
  }
);
