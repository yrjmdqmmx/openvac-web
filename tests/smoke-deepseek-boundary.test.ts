import { describe, expect, it, vi } from "vitest";

import {
  buildDeterministicSafeAnswerV3,
  EvidenceRegistry,
  executeCalculator,
  renderAnswerV3,
  ToolRegistry,
  validateAnswerV3
} from "../src/server/agent";
import type { AnswerV3 } from "../src/types/chat-v3";
import {
  applyDeepSeekSmokeBoundary,
  applyDeepSeekToolProjectionBoundary,
  buildDeepSeekSmokeTrustedExecutionCall,
  classifyDeepSeekSmokeProviderFailure,
  classifyDeepSeekToolExecutionFailure,
  collectDeepSeekToolProbeWithOneTransportRetry,
  collectCompletedSafetyProbeWithOneRetry,
  DeepSeekSmokeFailure,
  parseDeepSeekSmokeAnswer,
  publicDeepSeekSmokeFailure
} from "../scripts/smoke-deepseek-boundary";
import { runToolContinuationProbe } from "../scripts/smoke-deepseek";
import {
  ProviderError,
  ProviderResponseError,
  ProviderTimeoutError,
  type ResponsesStreamEvent,
  type ResponsesStreamRequest
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
  it("retries one identical physical tool probe only for retryable transport failures", async () => {
    const collect = vi
      .fn<() => Promise<{ terminal: string }>>()
      .mockRejectedValueOnce(
        new ProviderError("transient", {
          provider: "deepseek-responses",
          status: 503,
          retryable: true
        })
      )
      .mockResolvedValueOnce({ terminal: "completed" });

    await expect(
      collectDeepSeekToolProbeWithOneTransportRetry(collect)
    ).resolves.toEqual({ terminal: "completed" });
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("does not retry a semantic or non-retryable tool probe failure", async () => {
    const failure = new ProviderError("request invalid", {
      provider: "deepseek-responses",
      status: 422,
      retryable: false
    });
    const collect = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(
      collectDeepSeekToolProbeWithOneTransportRetry(collect)
    ).rejects.toBe(failure);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it("stops after the second retryable transport failure", async () => {
    const failures = ["first", "second"].map(
      (message) =>
        new ProviderError(message, {
          provider: "deepseek-responses",
          status: 503,
          retryable: true
        })
    );
    const collect = vi
      .fn<() => Promise<never>>()
      .mockRejectedValueOnce(failures[0])
      .mockRejectedValueOnce(failures[1]);

    await expect(
      collectDeepSeekToolProbeWithOneTransportRetry(collect)
    ).rejects.toBe(failures[1]);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it.each(["{malformed", "{}", "private-provider-sentinel"])(
    "builds trusted execution arguments without replaying provider arguments: %s",
    (providerArguments) => {
      const question =
        "腔体体积 100 L、等效抽速 10 L/s；估算从 100 Pa 抽到 1 Pa 的理想抽空时间。";
      const providerCall = {
        callId: "call-smoke",
        name: "estimate_pumpdown_time",
        arguments: providerArguments
      };
      const executionCall = buildDeepSeekSmokeTrustedExecutionCall({
        question,
        modelInput: [{ type: "message", role: "user", content: question }],
        providerCall
      });

      expect(executionCall).toEqual({
        callId: providerCall.callId,
        name: providerCall.name,
        arguments: JSON.stringify({
          volume: { value: 100, unit: "L" },
          pumpingSpeed: { value: 10, unit: "L/s" },
          initialPressure: { value: 100, unit: "Pa" },
          targetPressure: { value: 1, unit: "Pa" },
          outputUnit: "s"
        })
      });
      expect(executionCall?.arguments).not.toContain(providerArguments);
    }
  );

  it("fails trusted smoke extraction closed without using provider arguments", () => {
    expect(
      buildDeepSeekSmokeTrustedExecutionCall({
        question: "估算抽空时间。",
        modelInput: [
          { type: "message", role: "user", content: "估算抽空时间。" }
        ],
        providerCall: {
          callId: "call-smoke",
          name: "estimate_pumpdown_time",
          arguments: "private-provider-sentinel"
        }
      })
    ).toBeUndefined();
  });

  it.each(["{malformed", "{}", "private-provider-sentinel"])(
    "runs the complete trusted smoke turn without replaying raw arguments: %s",
    async (providerArguments) => {
      const requests: ResponsesStreamRequest[] = [];
      const provider = {
        stream: async function* (
          request: ResponsesStreamRequest
        ): AsyncGenerator<ResponsesStreamEvent> {
          requests.push(request);
          if (requests.length === 1) {
            const continuationItems = [
              {
                type: "function_call" as const,
                call_id: "call-smoke",
                name: "estimate_pumpdown_time",
                arguments: providerArguments
              }
            ];
            yield {
              type: "function-call",
              callId: "call-smoke",
              name: "estimate_pumpdown_time",
              arguments: providerArguments
            };
            yield {
              type: "finish",
              status: "completed",
              responseId: "response-tool",
              outputText: "",
              continuationItems
            };
            return;
          }
          yield {
            type: "finish",
            status: "completed",
            responseId: "response-final",
            outputText: "{}",
            continuationItems: []
          };
        }
      };
      const realRegistry = new ToolRegistry(new EvidenceRegistry());
      const execute = vi.fn(realRegistry.execute.bind(realRegistry));

      await expect(
        runToolContinuationProbe(provider, "partition", {
          definitions: realRegistry.definitions,
          execute
        })
      ).resolves.toMatchObject({
        terminal: "completed",
        callCount: 1,
        resultTransport: "trusted_projection",
        semanticRecovery: "deterministic_calculation"
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith({
        callId: "call-smoke",
        name: "estimate_pumpdown_time",
        arguments: JSON.stringify({
          volume: { value: 100, unit: "L" },
          pumpingSpeed: { value: 10, unit: "L/s" },
          initialPressure: { value: 100, unit: "Pa" },
          targetPressure: { value: 1, unit: "Pa" },
          outputUnit: "s"
        })
      });
      expect(requests).toHaveLength(2);
      expect(requests[1]?.toolChoice).toBe("none");
      expect(
        Array.isArray(requests[1]?.input)
          ? requests[1].input.map((item) => item.type)
          : []
      ).toEqual(["message", "message"]);
      expect(JSON.stringify(requests[1]?.input)).not.toMatch(
        /function_call|function_call_output|private-provider-sentinel|\{malformed/u
      );
    }
  );

  it("fails the complete smoke turn after one trusted execution failure without a final request", async () => {
    const requests: ResponsesStreamRequest[] = [];
    const provider = {
      stream: async function* (
        request: ResponsesStreamRequest
      ): AsyncGenerator<ResponsesStreamEvent> {
        requests.push(request);
        yield {
          type: "function-call",
          callId: "call-smoke",
          name: "estimate_pumpdown_time",
          arguments: "private-provider-sentinel"
        };
        yield {
          type: "finish",
          status: "completed",
          responseId: "response-tool",
          outputText: "",
          continuationItems: [
            {
              type: "function_call",
              call_id: "call-smoke",
              name: "estimate_pumpdown_time",
              arguments: "private-provider-sentinel"
            }
          ]
        };
      }
    };
    const definitions = new ToolRegistry(new EvidenceRegistry()).definitions;
    const execute = vi.fn(async (call: { callId: string }) => ({
      ok: false as const,
      outputItem: {
        type: "function_call_output" as const,
        call_id: call.callId,
        output: JSON.stringify({ ok: false, error: "TOOL_TIMEOUT" })
      },
      errorCode: "TOOL_TIMEOUT",
      evidenceIds: [],
      calculations: [],
      verifiedLinks: [],
      artifacts: [],
      missingInputs: []
    }));

    const action = runToolContinuationProbe(provider, "partition", {
      definitions,
      execute
    });
    await expect(action).rejects.toMatchObject({
      code: "TOOL_EXECUTION_FAILED",
      phase: "tool_first",
      kind: "timeout"
    });
    expect(requests).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(
        publicDeepSeekSmokeFailure(await action.catch((error) => error))
      )
    ).not.toContain("private-provider-sentinel");
  });

  it("fails the complete smoke turn on continuation identity mismatch without a final request", async () => {
    const requests: ResponsesStreamRequest[] = [];
    const provider = {
      stream: async function* (
        request: ResponsesStreamRequest
      ): AsyncGenerator<ResponsesStreamEvent> {
        requests.push(request);
        yield {
          type: "function-call",
          callId: "call-smoke",
          name: "estimate_pumpdown_time",
          arguments: "private-provider-sentinel"
        };
        yield {
          type: "finish",
          status: "completed",
          responseId: "response-tool",
          outputText: "",
          continuationItems: [
            {
              type: "function_call",
              call_id: "different-call",
              name: "estimate_pumpdown_time",
              arguments: "private-provider-sentinel"
            }
          ]
        };
      }
    };
    const realRegistry = new ToolRegistry(new EvidenceRegistry());
    const execute = vi.fn(realRegistry.execute.bind(realRegistry));

    await expect(
      runToolContinuationProbe(provider, "partition", {
        definitions: realRegistry.definitions,
        execute
      })
    ).rejects.toMatchObject({ code: "TOOL_CONTINUATION_INVALID" });
    expect(requests).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retries the exact same tool-first request only after a retryable transport error", async () => {
    const requests: ResponsesStreamRequest[] = [];
    const provider = {
      stream: async function* (
        request: ResponsesStreamRequest
      ): AsyncGenerator<ResponsesStreamEvent> {
        requests.push(request);
        throw new ProviderError("transient", {
          provider: "deepseek-responses",
          status: 503,
          retryable: true
        });
      }
    };

    await expect(
      runToolContinuationProbe(provider, "partition")
    ).rejects.toMatchObject({
      code: "PROVIDER_REQUEST_FAILED",
      phase: "tool_first",
      kind: "provider_5xx"
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
  });

  it("retries one side-effect-free safety probe after an invalid terminal", async () => {
    const collect = vi
      .fn<() => Promise<{ terminal: string }>>()
      .mockResolvedValueOnce({ terminal: "failed" })
      .mockResolvedValueOnce({ terminal: "completed" });

    await expect(
      collectCompletedSafetyProbeWithOneRetry(collect)
    ).resolves.toEqual({ terminal: "completed" });
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("fails closed after two invalid safety terminals", async () => {
    const collect = vi
      .fn<() => Promise<{ terminal: string }>>()
      .mockResolvedValueOnce({ terminal: "incomplete" })
      .mockResolvedValueOnce({ terminal: "failed" });

    await expect(
      collectCompletedSafetyProbeWithOneRetry(collect)
    ).rejects.toMatchObject({
      code: "PROVIDER_TERMINAL_INVALID",
      phase: "safety",
      kind: "provider_other"
    });
    expect(collect).toHaveBeenCalledTimes(2);
  });
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

  it("accepts fenced Answer V3 JSON like the production parser", () => {
    const candidate = buildDeterministicSafeAnswerV3(
      "high",
      "缺少现场核验结果"
    );
    const parsed = parseDeepSeekSmokeAnswer(
      `\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\``
    );

    const result = applyDeepSeekSmokeBoundary({
      candidate: parsed,
      riskLevel: "high",
      question: "真空泵冒烟并有异响，如何处置？"
    });

    expect(result.semanticRecovery).toBe("none");
    expect(result.answer).toEqual(candidate);
  });

  it("uses the deterministic high-risk answer for non-JSON output", () => {
    const question = "真空泵冒烟并有异响，如何处置？";
    const result = applyDeepSeekSmokeBoundary({
      candidate: parseDeepSeekSmokeAnswer("not JSON"),
      riskLevel: "high",
      question
    });

    expect(result.semanticRecovery).toBe("deterministic_safe");
    expect(renderAnswerV3(result.answer)).toContain("立即停机");
    expect(renderAnswerV3(result.answer)).toContain("隔离电源");
  });

  it("refuses a non-high probe and safely recovers a risk mismatch", () => {
    expect(() =>
      applyDeepSeekSmokeBoundary({
        candidate: direct,
        riskLevel: "low",
        question: "什么是真空？"
      })
    ).toThrow("ANSWER_BOUNDARY_RECOVERY_FAILED");
    expect(
      applyDeepSeekSmokeBoundary({
        candidate: direct,
        riskLevel: "high",
        question: "真空泵冒烟并有异响，如何处置？"
      }).semanticRecovery
    ).toBe("deterministic_safe");
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

  it("classifies tool execution failures without exposing arguments", () => {
    expect(
      publicDeepSeekSmokeFailure(
        classifyDeepSeekToolExecutionFailure("INVALID_TOOL_ARGUMENTS")
      )
    ).toEqual({
      schemaVersion: "openvac.deepseek-smoke-failure.v2",
      code: "TOOL_EXECUTION_FAILED",
      phase: "tool_first",
      kind: "tool_arguments"
    });
    expect(
      publicDeepSeekSmokeFailure(
        classifyDeepSeekToolExecutionFailure("CALCULATION_INPUT_INVALID")
      )
    ).toEqual({
      schemaVersion: "openvac.deepseek-smoke-failure.v2",
      code: "TOOL_EXECUTION_FAILED",
      phase: "tool_first",
      kind: "calculation_input"
    });
  });
});
