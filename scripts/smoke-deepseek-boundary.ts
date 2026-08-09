import {
  buildDeterministicSafeAnswerV3,
  validateAnswerV3
} from "../src/server/agent";
import type { RiskLevel } from "../src/types/chat";
import type { AnswerV3 } from "../src/types/chat-v3";

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

export class DeepSeekSmokeFailure extends Error {
  constructor(readonly code: DeepSeekSmokeFailureCode) {
    super(code);
    this.name = "DeepSeekSmokeFailure";
  }
}

export function publicDeepSeekSmokeFailure(
  error: unknown
): Record<string, string> {
  return {
    schemaVersion: "openvac.deepseek-smoke-failure.v1",
    code:
      error instanceof DeepSeekSmokeFailure ? error.code : "UNEXPECTED_FAILURE"
  };
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
