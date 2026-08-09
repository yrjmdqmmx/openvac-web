import { describe, expect, it } from "vitest";

import {
  buildDeterministicSafeAnswerV3,
  executeCalculator,
  renderAnswerV3,
  validateAnswerV3
} from "../src/server/agent";
import type { AnswerV3 } from "../src/types/chat-v3";
import {
  applyDeepSeekSmokeBoundary,
  applyDeepSeekToolProjectionBoundary,
  classifyDeepSeekSmokeProviderFailure,
  DeepSeekSmokeFailure,
  publicDeepSeekSmokeFailure
} from "../scripts/smoke-deepseek-boundary";
import {
  ProviderError,
  ProviderResponseError,
  ProviderTimeoutError
} from "../src/server/providers";

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
  it("mirrors the production deterministic calculation recovery", () => {
    const calculation = executeCalculator("estimate_pumpdown_time", {
      volume: { value: 100, unit: "L" },
      pumpingSpeed: { value: 10, unit: "L/s" },
      initialPressure: { value: 100, unit: "Pa" },
      targetPressure: { value: 1, unit: "Pa" },
      outputUnit: "s"
    });
    if (!calculation.ok) throw new Error("calculator fixture failed");

    const result = applyDeepSeekToolProjectionBoundary({
      candidate: {
        schemaVersion: "openvac.answer.v3",
        answerKind: "clarification",
        riskLevel: "medium",
        blocks: [],
        missingInputs: ["provider candidate drift"],
        usedEvidenceIds: [],
        usedLinkIds: []
      },
      riskLevel: "medium",
      calculations: [calculation.calculation],
      calculationIds: new Set([calculation.calculation.id])
    });

    expect(result.semanticRecovery).toBe("deterministic_calculation");
    expect(result.answer).toMatchObject({
      answerKind: "expert",
      riskLevel: "medium",
      blocks: [
        { type: "calculation", calculationId: calculation.calculation.id }
      ],
      missingInputs: [],
      usedEvidenceIds: [],
      usedLinkIds: []
    });
  });

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
    expect(
      publicDeepSeekSmokeFailure(
        new DeepSeekSmokeFailure("TOOL_CONTINUATION_INVALID")
      )
    ).toEqual({
      schemaVersion: "openvac.deepseek-smoke-failure.v2",
      code: "TOOL_CONTINUATION_INVALID"
    });
  });

  it("classifies provider failures without exposing status, messages or request details", () => {
    const cases = [
      [
        new ProviderResponseError("deepseek-responses", "secret body", {
          status: 422,
          retryable: false
        }),
        "request_invalid"
      ],
      [
        new ProviderResponseError("deepseek-responses", "secret body", {
          status: 503,
          retryable: true
        }),
        "provider_5xx"
      ],
      [
        new ProviderResponseError("deepseek-responses", "secret auth", {
          status: 401,
          retryable: false
        }),
        "auth"
      ],
      [
        new ProviderResponseError("deepseek-responses", "secret balance", {
          status: 402,
          retryable: false
        }),
        "balance"
      ],
      [
        new ProviderResponseError("deepseek-responses", "secret rate", {
          status: 429,
          retryable: true
        }),
        "rate_limited"
      ],
      [
        new ProviderTimeoutError("deepseek-responses", "secret timeout"),
        "timeout"
      ],
      [
        new ProviderResponseError(
          "deepseek-responses",
          "providerRequestId=request-secret",
          { retryable: true }
        ),
        "stream_contract"
      ],
      [
        new ProviderResponseError(
          "deepseek-responses",
          "local contract secret",
          { retryable: false }
        ),
        "request_contract"
      ],
      [
        new ProviderError("secret provider failure", {
          provider: "deepseek-responses"
        }),
        "provider_other"
      ],
      [new Error("secret unexpected failure"), "unexpected"]
    ] as const;

    for (const [error, kind] of cases) {
      const publicFailure = publicDeepSeekSmokeFailure(
        classifyDeepSeekSmokeProviderFailure(
          "PROVIDER_REQUEST_FAILED",
          "tool_first",
          error
        )
      );
      expect(publicFailure).toEqual({
        schemaVersion: "openvac.deepseek-smoke-failure.v2",
        code: "PROVIDER_REQUEST_FAILED",
        phase: "tool_first",
        kind
      });
      expect(JSON.stringify(publicFailure)).not.toMatch(
        /401|402|422|429|503|secret|providerRequestId|request-secret/u
      );
    }
  });
});
