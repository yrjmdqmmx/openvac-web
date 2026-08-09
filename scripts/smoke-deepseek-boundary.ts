import {
  buildDeterministicSafeAnswerV3,
  validateAnswerV3
} from "../src/server/agent";
import type { RiskLevel } from "../src/types/chat";
import type { AnswerV3 } from "../src/types/chat-v3";
import {
  ProviderError,
  ProviderResponseError,
  ProviderTimeoutError
} from "../src/server/providers";

export type DeepSeekSmokeBoundaryResult = {
  answer: AnswerV3;
  semanticRecovery: "none" | "deterministic_safe";
};

export type DeepSeekSmokeFailureCode =
  | "CONFIG_MISSING"
  | "PROVIDER_REQUEST_FAILED"
  | "PROVIDER_TERMINAL_INVALID"
  | "ANSWER_JSON_INVALID"
  | "ANSWER_SCHEMA_INVALID"
  | "ANSWER_BOUNDARY_RECOVERY_FAILED"
  | "TOOL_CALL_INVALID"
  | "TOOL_EXECUTION_FAILED"
  | "TOOL_CONTINUATION_INVALID"
  | "UNEXPECTED_FAILURE";

export type DeepSeekSmokeFailurePhase = "safety" | "tool_first" | "tool_final";

export type DeepSeekSmokeFailureKind =
  | "request_invalid"
  | "auth"
  | "balance"
  | "rate_limited"
  | "http_4xx"
  | "provider_5xx"
  | "timeout"
  | "request_contract"
  | "stream_contract"
  | "provider_other"
  | "unexpected";

export class DeepSeekSmokeFailure extends Error {
  constructor(
    readonly code: DeepSeekSmokeFailureCode,
    readonly phase?: DeepSeekSmokeFailurePhase,
    readonly kind?: DeepSeekSmokeFailureKind
  ) {
    super(code);
    this.name = "DeepSeekSmokeFailure";
  }
}

export function classifyDeepSeekSmokeProviderFailure(
  code: Extract<
    DeepSeekSmokeFailureCode,
    "PROVIDER_REQUEST_FAILED" | "TOOL_CONTINUATION_INVALID"
  >,
  phase: DeepSeekSmokeFailurePhase,
  error: unknown
): DeepSeekSmokeFailure {
  let kind: DeepSeekSmokeFailureKind = "unexpected";
  if (error instanceof ProviderTimeoutError) {
    kind = "timeout";
  } else if (
    error instanceof ProviderError &&
    (error.status === 400 || error.status === 422)
  ) {
    kind = "request_invalid";
  } else if (
    error instanceof ProviderError &&
    (error.status === 401 || error.status === 403)
  ) {
    kind = "auth";
  } else if (error instanceof ProviderError && error.status === 402) {
    kind = "balance";
  } else if (error instanceof ProviderError && error.status === 429) {
    kind = "rate_limited";
  } else if (
    error instanceof ProviderError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500
  ) {
    kind = "http_4xx";
  } else if (
    error instanceof ProviderError &&
    error.status !== undefined &&
    error.status >= 500
  ) {
    kind = "provider_5xx";
  } else if (error instanceof ProviderResponseError) {
    kind = error.retryable ? "stream_contract" : "request_contract";
  } else if (error instanceof ProviderError) {
    kind = "provider_other";
  }
  return new DeepSeekSmokeFailure(code, phase, kind);
}

export function publicDeepSeekSmokeFailure(
  error: unknown
): Record<string, string> {
  const result: Record<string, string> = {
    schemaVersion: "openvac.deepseek-smoke-failure.v2",
    code:
      error instanceof DeepSeekSmokeFailure ? error.code : "UNEXPECTED_FAILURE"
  };
  if (error instanceof DeepSeekSmokeFailure) {
    if (error.phase) result.phase = error.phase;
    if (error.kind) result.kind = error.kind;
  }
  return result;
}

export function applyDeepSeekSmokeBoundary(input: {
  candidate: AnswerV3;
  riskLevel: RiskLevel;
  question: string;
}): DeepSeekSmokeBoundaryResult {
  if (input.riskLevel !== "high") {
    throw new DeepSeekSmokeFailure("ANSWER_BOUNDARY_RECOVERY_FAILED");
  }
  if (input.candidate.riskLevel !== input.riskLevel) {
    throw new DeepSeekSmokeFailure("ANSWER_BOUNDARY_RECOVERY_FAILED");
  }
  const validate = (value: AnswerV3) =>
    validateAnswerV3({
      value,
      riskLevel: input.riskLevel,
      question: input.question,
      knownEvidenceIds: [],
      knownLinkIds: [],
      knownArtifactIds: [],
      knownCalculationIds: [],
      verifiedEvidenceIds: []
    });
  const candidate = validate(input.candidate);
  if (candidate.valid) {
    return { answer: candidate.answer, semanticRecovery: "none" };
  }

  const fallback = buildDeterministicSafeAnswerV3(
    input.riskLevel,
    "发布探针候选未通过产品语义边界。"
  );
  const recovered = validate(fallback);
  if (!recovered.valid) {
    throw new DeepSeekSmokeFailure("ANSWER_BOUNDARY_RECOVERY_FAILED");
  }
  return {
    answer: recovered.answer,
    semanticRecovery: "deterministic_safe"
  };
}
