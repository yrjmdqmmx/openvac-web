import {
  ConfigurationError,
  ProviderError,
  ProviderResponseError,
  ProviderTimeoutError
} from "../src/server/providers";

export type QwenVlSmokeFailureCode =
  | "CONFIG_MISSING"
  | "AUTH_FAILED"
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMITED"
  | "REQUEST_INVALID"
  | "PROVIDER_UNAVAILABLE"
  | "TIMEOUT"
  | "RESPONSE_INVALID"
  | "UNEXPECTED_FAILURE";

export type QwenVlSmokeFailureDetail = "UNIT_NOT_RECOGNIZED";

export class QwenVlSmokeFailure extends Error {
  constructor(
    readonly code: QwenVlSmokeFailureCode,
    readonly detail?: QwenVlSmokeFailureDetail
  ) {
    super(code);
    this.name = "QwenVlSmokeFailure";
  }
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
      error.retryable
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

export function recognizesPascalUnit(value: string): boolean {
  if (/(?:未|无法|没有|不能)(?:清晰)?识别/iu.test(value)) {
    return false;
  }
  const normalized = value
    .toLowerCase()
    .replace(/大写|小写|英文字母|字母|字符|和|与|及/gu, "");
  const compact = normalized.replace(/[^\p{L}\p{N}]+/gu, "");
  return (
    compact.includes("pa") ||
    compact.includes("pascal") ||
    compact.includes("帕")
  );
}
