export class ModelingRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ModelingRepositoryError";
  }
}

export class StaleRevisionError extends ModelingRepositoryError {
  constructor(details: {
    projectId: string;
    expectedRevisionId: string;
    currentRevisionId: string | null;
  }) {
    super(
      "STALE_REVISION",
      "项目已经产生了更新版本，请基于最新版本重新操作。",
      details
    );
    this.name = "StaleRevisionError";
  }
}

export class StalePlanError extends ModelingRepositoryError {
  constructor(details: {
    planId: string;
    baseRevisionId: string;
    currentRevisionId: string | null;
  }) {
    super(
      "STALE_PLAN",
      "AI 方案所基于的版本已经过期，请重新生成方案。",
      details
    );
    this.name = "StalePlanError";
  }
}

export class IdempotencyConflictError extends ModelingRepositoryError {
  constructor(idempotencyKey: string) {
    super("IDEMPOTENCY_CONFLICT", "该幂等键已经用于不同的请求。", {
      idempotencyKey
    });
    this.name = "IdempotencyConflictError";
  }
}

export class ValidationAttemptInProgressError extends ModelingRepositoryError {
  constructor(attemptId: string) {
    super(
      "MODELING_VALIDATION_IN_PROGRESS",
      "相同幂等键的确定性校验仍在执行，请稍后重试。",
      { attemptId }
    );
    this.name = "ValidationAttemptInProgressError";
  }
}

export class ValidationAttemptStateError extends ModelingRepositoryError {
  constructor(attemptId: string) {
    super(
      "MODELING_VALIDATION_STATE_CONFLICT",
      "确定性校验账本状态冲突，未写入模型版本。",
      { attemptId }
    );
    this.name = "ValidationAttemptStateError";
  }
}

export class PlanConflictError extends ModelingRepositoryError {
  constructor(code: string, message: string, planId: string) {
    super(code, message, { planId });
    this.name = "PlanConflictError";
  }
}

export class ModelingLimitError extends ModelingRepositoryError {
  constructor(
    code:
      | "MODELING_QUEUE_FULL"
      | "MODELING_USER_QUEUE_LIMIT"
      | "MODELING_USER_RUNNING_LIMIT"
      | "MODELING_DAILY_COMPUTE_LIMIT"
      | "MODELING_DAILY_EXPORT_LIMIT"
      | "MODELING_OPERATION_RATE_LIMIT",
    message: string,
    details?: Record<string, unknown>
  ) {
    super(code, message, details);
    this.name = "ModelingLimitError";
  }
}
