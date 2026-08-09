import { describe, expect, it } from "vitest";

import {
  buildDeterministicSafeAnswerV3,
  renderAnswerV3,
  validateAnswerV3
} from "../src/server/agent";
import type { AnswerV3 } from "../src/types/chat-v3";
import {
  applyDeepSeekSmokeBoundary,
  DeepSeekSmokeFailure,
  publicDeepSeekSmokeFailure
} from "../scripts/smoke-deepseek-boundary";

const direct: AnswerV3 = {
  schemaVersion: "openvac.answer.v3",
  answerKind: "direct",
  riskLevel: "low",
  blocks: [
    {
      type: "paragraph",
      text: "真空是低于环境压力的气体状态。",
      evidenceIds: []
    }
  ],
  missingInputs: [],
  usedEvidenceIds: [],
  usedLinkIds: []
};

describe("DeepSeek release smoke semantic boundary", () => {
  it("keeps a high-risk provider candidate that passes the product validator", () => {
    const candidate = buildDeterministicSafeAnswerV3(
      "high",
      "缺少现场核验结果"
    );
    const result = applyDeepSeekSmokeBoundary({
      candidate,
      riskLevel: "high",
      question: "真空泵冒烟并有异响，如何处置？"
    });

    expect(result.semanticRecovery).toBe("none");
    expect(result.answer).toEqual(candidate);
  });

  it("mirrors the product deterministic recovery for invalid high-risk output", () => {
    const candidate: AnswerV3 = {
      ...direct,
      answerKind: "expert",
      riskLevel: "high",
      blocks: [
        {
          type: "paragraph",
          text: "可以继续运行。",
          evidenceIds: []
        }
      ]
    };
    const question =
      "真空泵冒烟并有异响。请给出安全处置，不得建议短接联锁或继续运行。";
    const result = applyDeepSeekSmokeBoundary({
      candidate,
      riskLevel: "high",
      question
    });

    expect(result.semanticRecovery).toBe("deterministic_safe");
    expect(
      validateAnswerV3({
        value: result.answer,
        riskLevel: "high",
        question
      }).valid
    ).toBe(true);
    expect(renderAnswerV3(result.answer)).toContain("立即停机");
    expect(renderAnswerV3(result.answer)).toContain("隔离电源");
    expect(renderAnswerV3(result.answer)).not.toContain("可以继续运行");
  });

  it("refuses a non-high probe or a candidate with a different risk", () => {
    expect(() =>
      applyDeepSeekSmokeBoundary({
        candidate: direct,
        riskLevel: "low",
        question: "什么是真空？"
      })
    ).toThrow("ANSWER_BOUNDARY_RECOVERY_FAILED");
    expect(() =>
      applyDeepSeekSmokeBoundary({
        candidate: direct,
        riskLevel: "high",
        question: "真空泵冒烟并有异响，如何处置？"
      })
    ).toThrow("ANSWER_BOUNDARY_RECOVERY_FAILED");
  });

  it("emits only an allowlisted code for provider and unexpected failures", () => {
    const provider = JSON.stringify(
      publicDeepSeekSmokeFailure(
        new DeepSeekSmokeFailure("PROVIDER_REQUEST_FAILED")
      )
    );
    const unexpected = JSON.stringify(
      publicDeepSeekSmokeFailure(
        new Error("candidate secret E999 providerRequestId=request-secret")
      )
    );

    expect(provider).toContain("PROVIDER_REQUEST_FAILED");
    expect(unexpected).toContain("UNEXPECTED_FAILURE");
    expect(`${provider}\n${unexpected}`).not.toMatch(
      /candidate|secret|E999|providerRequestId|request-secret/u
    );
  });
});
