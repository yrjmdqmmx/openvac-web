import {
  ConfigurationError,
  ProviderError,
  ProviderResponseError,
  ProviderTimeoutError,
  QwenVlOutputTruncatedError
} from "../src/server/providers";

export type QwenVlSmokeFailureCode =
  | "CONFIG_MISSING"
  | "AUTH_FAILED"
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMITED"
  | "REQUEST_INVALID"
  | "PROVIDER_UNAVAILABLE"
  | "TIMEOUT"
  | "OUTPUT_TRUNCATED"
  | "RESPONSE_INVALID"
  | "UNEXPECTED_FAILURE";

export type QwenVlSmokeFailureDetail =
  "VISUAL_NONCE_MISMATCH" | "VISUAL_PREFLIGHT_FAILED";

export type QwenVlSmokeRetryBudget = {
  used: boolean;
};

export type QwenVlSmokeRetryEvent = {
  schemaVersion: "openvac.qwen-vl-smoke-retry.v1";
  caseId: string;
  firstFailureCode: QwenVlSmokeFailureCode;
  firstFailureStatus?: number;
  attempt: 2;
  maxAttempts: 2;
};

export class QwenVlSmokeFailure extends Error {
  constructor(
    readonly code: QwenVlSmokeFailureCode,
    readonly detail?: QwenVlSmokeFailureDetail
  ) {
    super(code);
    this.name = "QwenVlSmokeFailure";
  }
}

export function createQwenVlSmokeRetryBudget(): QwenVlSmokeRetryBudget {
  return { used: false };
}

export function qwenVlSmokeRecordedDurationMs(input: {
  attempts: 1 | 2;
  successfulAttemptDurationMs: number;
  requestStartedAtMs: number;
  requestFinishedAtMs: number;
}): number {
  return input.attempts === 1
    ? input.successfulAttemptDurationMs
    : Math.max(
        input.successfulAttemptDurationMs,
        Math.round(input.requestFinishedAtMs - input.requestStartedAtMs)
      );
}

export async function withOneQwenVlControlledFixtureRetry<
  TRequest,
  TResult
>(input: {
  caseId: string;
  budget: QwenVlSmokeRetryBudget;
  request: TRequest;
  execute(request: TRequest): Promise<TResult>;
  onRetry(event: QwenVlSmokeRetryEvent): void;
}): Promise<{ result: TResult; attempts: 1 | 2 }> {
  try {
    return { result: await input.execute(input.request), attempts: 1 };
  } catch (error) {
    const event = qwenVlControlledFixtureRetryEvent(error, input.caseId);
    if (!event || input.budget.used) throw error;
    input.budget.used = true;
    input.onRetry(event);
  }
  return { result: await input.execute(input.request), attempts: 2 };
}

function qwenVlControlledFixtureRetryEvent(
  error: unknown,
  caseId: string
): QwenVlSmokeRetryEvent | undefined {
  if (
    !(error instanceof ProviderError) ||
    error instanceof ConfigurationError ||
    error instanceof QwenVlOutputTruncatedError
  ) {
    return undefined;
  }
  const status = error.status;
  const controlledRequestRejection =
    caseId === "device_identification" && (status === 400 || status === 422);
  const explicitTransientFailure =
    error instanceof ProviderTimeoutError ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599);
  if (!controlledRequestRejection && !explicitTransientFailure) {
    return undefined;
  }
  const failure = classifyQwenVlSmokeFailure(error);
  return {
    schemaVersion: "openvac.qwen-vl-smoke-retry.v1",
    caseId,
    firstFailureCode: failure.code,
    ...(status === undefined ? {} : { firstFailureStatus: status }),
    attempt: 2,
    maxAttempts: 2
  };
}

export function classifyQwenVlSmokeFailure(error: unknown): QwenVlSmokeFailure {
  if (error instanceof QwenVlSmokeFailure) {
    return error;
  }
  if (error instanceof ConfigurationError) {
    return new QwenVlSmokeFailure("CONFIG_MISSING");
  }
  if (error instanceof ProviderTimeoutError) {
    return new QwenVlSmokeFailure("TIMEOUT");
  }
  if (error instanceof QwenVlOutputTruncatedError) {
    return new QwenVlSmokeFailure("OUTPUT_TRUNCATED");
  }
  if (error instanceof ProviderError) {
    if (error.status === 401 || error.status === 403) {
      return new QwenVlSmokeFailure("AUTH_FAILED");
    }
    if (error.status === 402) {
      return new QwenVlSmokeFailure("QUOTA_EXHAUSTED");
    }
    if (error.status === 429) {
      return new QwenVlSmokeFailure("RATE_LIMITED");
    }
    if (error.status === 400 || error.status === 422) {
      return new QwenVlSmokeFailure("REQUEST_INVALID");
    }
    if (
      (error.status !== undefined && error.status >= 500) ||
      (!(error instanceof ProviderResponseError) && error.retryable)
    ) {
      return new QwenVlSmokeFailure("PROVIDER_UNAVAILABLE");
    }
    if (error instanceof ProviderResponseError) {
      return new QwenVlSmokeFailure("RESPONSE_INVALID");
    }
  }
  return new QwenVlSmokeFailure("UNEXPECTED_FAILURE");
}

export function publicQwenVlSmokeFailure(
  error: unknown
): Record<string, string> {
  const result: Record<string, string> = {
    schemaVersion: "openvac.qwen-vl-smoke-failure.v1",
    code:
      error instanceof QwenVlSmokeFailure ? error.code : "UNEXPECTED_FAILURE"
  };
  if (error instanceof QwenVlSmokeFailure && error.detail) {
    result.detail = error.detail;
  }
  return result;
}

export function recognizesVisualNonce(value: string, nonce: string): boolean {
  if (!/^\d{8}$/u.test(nonce)) {
    return false;
  }
  if (/(?:未|无法|没有|不能)(?:清晰)?(?:识别|读取)/iu.test(value)) {
    return false;
  }
  const normalized = value.replace(/[０-９]/gu, (digit) =>
    String(digit.charCodeAt(0) - 0xff10)
  );
  const candidates = (
    normalized.match(/(?<!\d)(?:\d[\s,，._-]*){7}\d(?!\d)/gu) ?? []
  ).map((candidate) => candidate.replace(/\D/gu, ""));
  return candidates.length === 1 && candidates[0] === nonce;
}
