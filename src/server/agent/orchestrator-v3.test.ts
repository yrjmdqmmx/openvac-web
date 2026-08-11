import { describe, expect, it, vi } from "vitest";

import type { CalculationResult, Citation } from "@/types/chat";
import type { AnswerV3 } from "@/types/chat-v3";
import { QuotaExceededError } from "@/server/quota";
import {
  ProviderError,
  DeepSeekResponsesProvider,
  type ResponsesInputItem,
  type ResponsesProvider,
  type ResponsesStreamEvent,
  type ResponsesStreamRequest
} from "@/server/providers";

import {
  AgentRunOrchestrator,
  MAX_ARTIFACT_PROVIDER_OUTPUT_TOKENS,
  localizeKnownCalculationBlocks,
  buildAgentV3InstructionsForRisk,
  candidateUsesOnlyKnownGrounding,
  persistAndPublishFinalAnswer,
  webSearchQuotaPolicy,
  type OrchestratorEvent
} from "./orchestrator";
import { EvidenceRegistry } from "./evidence-registry";
import type { RunStore } from "./run-store";
import { ToolRegistry } from "./tool-registry";
import type { ArtifactStorage } from "./artifact-tools";

const finalAnswer: AnswerV3 = {
  schemaVersion: "openvac.answer.v3",
  answerKind: "direct",
  riskLevel: "low",
  blocks: [{ type: "paragraph", text: "已持久化回答", evidenceIds: ["E1"] }],
  missingInputs: [],
  usedEvidenceIds: ["E1"],
  usedLinkIds: []
};

const finalCitation: Citation = {
  sourceId: "E1",
  title: "Pump manual",
  publisher: "Example",
  url: "https://example.com/manual",
  sourcePolicy: {
    linkAllowed: true,
    authoritative: true,
    allowedDomains: ["example.com"]
  },
  fetchedAt: "2026-08-09T00:00:00.000Z",
  licenseClass: "open"
};

describe("Agent V3 orchestrator output boundary", () => {
  it("binds every model request to the server-assessed risk level", () => {
    const instructions = buildAgentV3InstructionsForRisk("medium");

    expect(instructions).toContain("风险等级已固定为 medium");
    expect(instructions).toContain("riskLevel 必须原样使用该值");
    expect(instructions).toContain("不得生成无依据的 expert");
  });

  it("allows repair only when every candidate grounding id is server-known", () => {
    const references = (evidenceIds: string[], calculationIds: string[]) => ({
      evidenceIds,
      calculationIds
    });

    expect(
      candidateUsesOnlyKnownGrounding(references(["E1"], []), ["E1"], [])
    ).toBe(true);
    expect(
      candidateUsesOnlyKnownGrounding(
        references([], ["calc_1"]),
        [],
        ["calc_1"]
      )
    ).toBe(true);
    expect(
      candidateUsesOnlyKnownGrounding(references(["E999"], []), ["E1"], [])
    ).toBe(false);
    expect(
      candidateUsesOnlyKnownGrounding(
        references(["E1", "E999"], []),
        ["E1"],
        []
      )
    ).toBe(false);
    expect(
      candidateUsesOnlyKnownGrounding(references([], []), ["E1"], ["calc_1"])
    ).toBe(false);
  });

  it("publishes final blocks and citations only after atomic completion succeeds", async () => {
    const order: string[] = [];
    const emitted: OrchestratorEvent[] = [];
    let resolvePersistence: ((value: { content: string }) => void) | undefined;
    const persistence = new Promise<{ content: string }>((resolve) => {
      resolvePersistence = resolve;
    });

    const completion = persistAndPublishFinalAnswer({
      persist: async () => {
        order.push("store.started");
        const stored = await persistence;
        order.push("store.completed");
        return stored;
      },
      answer: finalAnswer,
      citations: [finalCitation],
      emit: (event) => {
        emitted.push(event);
        order.push(event.type);
      }
    });

    await Promise.resolve();
    expect(order).toEqual(["store.started"]);
    expect(emitted).toEqual([]);

    resolvePersistence?.({ content: "saved" });
    await expect(completion).resolves.toEqual({ content: "saved" });
    order.push("run.completed");

    expect(order).toEqual([
      "store.started",
      "store.completed",
      "block",
      "citation",
      "run.completed"
    ]);
  });

  it("publishes no final answer events when atomic completion fails", async () => {
    const emitted: OrchestratorEvent[] = [];

    await expect(
      persistAndPublishFinalAnswer({
        persist: () => Promise.reject(new Error("transaction rolled back")),
        answer: finalAnswer,
        citations: [finalCitation],
        emit: (event) => emitted.push(event)
      })
    ).rejects.toThrow("transaction rolled back");
    expect(emitted).toEqual([]);
  });

  it("replaces model-authored calculation text with the server-localized projection", () => {
    const calculation: CalculationResult = {
      id: "calc_1",
      tool: "calculate_throughput",
      formulaId: "Q=pS",
      formulaVersion: "1.0.0",
      normalizedInputs: { pressurePa: 10, speedM3S: 0.1 },
      result: { value: 1, unit: "Pa*m3/s" },
      assumptions: ["压力与抽速取同一工作点的稳态值。"],
      warnings: [],
      sourceIds: []
    };
    const candidate = {
      schemaVersion: "openvac.answer.v3",
      answerKind: "direct",
      riskLevel: "low",
      blocks: [
        {
          type: "calculation",
          calculationId: "calc_1",
          title: "calculate_throughput",
          result: "raw value=1",
          assumptions: ["normalizedInputs"],
          warnings: []
        }
      ],
      missingInputs: [],
      usedEvidenceIds: [],
      usedLinkIds: []
    };

    const localized = localizeKnownCalculationBlocks(
      candidate,
      new Map([[calculation.id, calculation]])
    );
    const serialized = JSON.stringify(localized);

    expect(serialized).toContain("气体流量计算");
    expect(serialized).toContain("计算值为 1");
    expect(serialized).not.toContain("calculate_throughput");
    expect(serialized).not.toContain("normalizedInputs");
    expect(serialized).not.toContain("pressurePa");
  });

  it("degrades only automatic web search when the web-search quota is exhausted", () => {
    const exceeded = new QuotaExceededError({
      resource: "web_search",
      scopeType: "user",
      limit: 5,
      resetAt: new Date("2026-08-10T00:00:00.000Z")
    });

    expect(webSearchQuotaPolicy(exceeded, "auto")).toBe("continue_without_web");
    expect(webSearchQuotaPolicy(exceeded, "always")).toBe("fail_required_web");
    expect(
      webSearchQuotaPolicy(
        new QuotaExceededError({
          resource: "answer",
          scopeType: "user",
          limit: 20,
          resetAt: new Date("2026-08-10T00:00:00.000Z")
        }),
        "auto"
      )
    ).toBeUndefined();
    expect(
      webSearchQuotaPolicy(new Error("database unavailable"), "auto")
    ).toBeUndefined();
  });
});

describe("Agent V3 artifact provider requests", () => {
  it("uses the artifact budget and trusted fresh instructions without replaying input", async () => {
    const { invoke, input } = artifactRequestSubject();
    const requests: ResponsesStreamRequest[] = [];
    const phases: string[] = [];
    invoke.meteredStream = async function* (
      _input,
      request,
      phase
    ): AsyncGenerator<ResponsesStreamEvent> {
      requests.push(request);
      phases.push(phase);
      yield {
        type: "function-call",
        callId: `call-${phases.length}`,
        name: "create_artifact",
        arguments: JSON.stringify(validParameterArtifactArguments())
      };
      yield {
        type: "finish",
        status: "completed",
        responseId: `response-${phases.length}`,
        outputText: "",
        continuationItems: []
      };
    };
    const cleanInput: ResponsesInputItem[] = [
      { type: "message", role: "user", content: "生成泵组选型参数表" }
    ];

    await invoke.collectModelResponse(
      input,
      cleanInput,
      input.signal,
      "answer_initial",
      true
    );
    await invoke.collectModelResponse(
      input,
      cleanInput,
      input.signal,
      "answer_artifact_fresh_json_invalid",
      true,
      "fresh_json_invalid"
    );
    await invoke.collectModelResponse(
      input,
      cleanInput,
      input.signal,
      "answer_artifact_continuation_invalid_arguments",
      true,
      "continuation_invalid_arguments"
    );

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.input).toEqual(cleanInput);
      expect(request.maxOutputTokens).toBe(MAX_ARTIFACT_PROVIDER_OUTPUT_TOKENS);
      expect(request.toolChoice).toEqual({
        type: "function",
        name: "create_artifact"
      });
      expect(request.instructions).toContain("所有字符串合计不得超过 6000");
      expect(request.instructions).toContain(
        "parameter_table 必须包含有真实值的单位/unit 列"
      );
      expect(request.instructions).toContain("不得编造具体工况");
      expect(JSON.stringify(request.input)).not.toContain(
        "private-malformed-arguments"
      );
    }
    expect(requests[0]?.instructions).not.toContain(
      "上一次 create_artifact 参数不是合法 JSON"
    );
    expect(requests[0]?.safeInvocationPhase).toBeUndefined();
    expect(requests[1]?.instructions).toContain(
      "上一次 create_artifact 参数不是合法 JSON"
    );
    expect(requests[1]?.safeInvocationPhase).toBe("artifact_fresh_json_repair");
    expect(requests[2]?.instructions).not.toContain(
      "上一次 create_artifact 参数不是合法 JSON"
    );
    expect(requests[2]?.instructions).toContain(
      "根据已配对的工具结果中列出的缺失路径"
    );
    expect(requests[2]?.safeInvocationPhase).toBe(
      "artifact_continuation_repair"
    );
  });

  it("retries one semantic repair with the identical clean transport payload", async () => {
    const { invoke, input } = artifactRequestSubject();
    const cleanInput: ResponsesInputItem[] = [
      { type: "message", role: "user", content: "生成泵组选型参数表" }
    ];
    const completed = {
      outputText: "",
      calls: [],
      finish: {
        type: "finish",
        status: "completed",
        responseId: "response-retry",
        outputText: "",
        continuationItems: []
      },
      callableFunctionNames: new Set<string>()
    };
    const collect = vi
      .fn()
      .mockRejectedValueOnce(
        new ProviderError("transient", {
          provider: "deepseek-responses",
          status: 503,
          retryable: true
        })
      )
      .mockResolvedValueOnce(completed);
    invoke.collectModelResponse = collect;

    await expect(
      invoke.requestWithOneRetry(
        input,
        cleanInput,
        input.signal,
        "answer_artifact_fresh_json_invalid",
        true,
        "fresh_json_invalid"
      )
    ).resolves.toBe(completed);

    expect(collect).toHaveBeenCalledTimes(2);
    expect(collect.mock.calls[0]?.[1]).toBe(cleanInput);
    expect(collect.mock.calls[1]?.[1]).toBe(cleanInput);
    expect(collect.mock.calls[0]?.[5]).toBe("fresh_json_invalid");
    expect(collect.mock.calls[1]?.[5]).toBe("fresh_json_invalid");
    expect(collect.mock.calls[1]?.[4]).toBe(true);
    expect(collect.mock.calls[1]?.[3]).toBe(
      "answer_artifact_fresh_json_invalid_retry"
    );
    expect(invoke.retries).toBe(1);
  });

  it("does not create a transport retry after cancellation wins the failure race", async () => {
    const { invoke, input } = artifactRequestSubject();
    const controller = new AbortController();
    const cleanInput: ResponsesInputItem[] = [
      { type: "message", role: "user", content: "生成泵组选型参数表" }
    ];
    const collect = vi.fn(async () => {
      controller.abort();
      throw new ProviderError("transient", {
        provider: "deepseek-responses",
        status: 503,
        retryable: true
      });
    });
    invoke.collectModelResponse = collect;

    await expect(
      invoke.requestWithOneRetry(
        input,
        cleanInput,
        controller.signal,
        "answer_artifact_fresh_json_invalid",
        true,
        "fresh_json_invalid"
      )
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(collect).toHaveBeenCalledTimes(1);
    expect(invoke.retries).toBe(0);
  });

  it("runs JSON-invalid through one clean fresh repair and one artifact audit", async () => {
    const malformed = artifactModelResponse([
      {
        callId: "malformed-call",
        arguments: "{private-malformed-arguments"
      }
    ]);
    const valid = artifactModelResponse([
      {
        callId: "valid-call",
        arguments: JSON.stringify(validParameterArtifactArguments())
      }
    ]);
    const subject = artifactRunSubject([malformed, valid]);

    await expect(
      subject.orchestrator.run(subject.input)
    ).resolves.toMatchObject({
      status: "completed"
    });

    expect(subject.request).toHaveBeenCalledTimes(2);
    expect(subject.request.mock.calls[1]?.[1]).toEqual(subject.cleanInput);
    expect(JSON.stringify(subject.request.mock.calls[1]?.[1])).not.toMatch(
      /private-malformed|malformed-call|function_call/iu
    );
    expect(subject.request.mock.calls[1]?.[5]).toBe("fresh_json_invalid");
    expect(subject.storage.create).toHaveBeenCalledTimes(1);
    expect(subject.store.recordToolCall).toHaveBeenCalledTimes(1);
    expect(subject.store.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "valid-call",
        toolName: "create_artifact",
        status: "completed"
      })
    );
    expect(subject.store.complete).toHaveBeenCalledTimes(1);
    expect(subject.orchestrator.counters).toMatchObject({
      modelRequests: 2,
      repairs: 1,
      toolRounds: 1,
      toolCalls: 1
    });
  });

  it("carries a real strict provider repair through preflight, storage, and audit", async () => {
    const subject = artifactRunSubject([]);
    const malformedArguments = "{private-malformed-arguments";
    const validArguments = JSON.stringify(validParameterArtifactArguments());
    const urls: string[] = [];
    const requestBodies: string[] = [];
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        urls.push(String(url));
        requestBodies.push(String(init?.body));
        if (urls.length === 1) {
          return new Response(
            responsesSse([
              {
                type: "response.created",
                sequence_number: 0,
                response: { id: "response-malformed" }
              },
              {
                type: "response.output_item.done",
                sequence_number: 1,
                item: {
                  type: "function_call",
                  call_id: "malformed-call",
                  name: "create_artifact",
                  arguments: malformedArguments
                }
              },
              {
                type: "response.completed",
                sequence_number: 2,
                response: {
                  id: "response-malformed",
                  output: [
                    {
                      type: "function_call",
                      call_id: "malformed-call",
                      name: "create_artifact",
                      arguments: malformedArguments
                    }
                  ]
                }
              }
            ])
          );
        }
        if (urls.length === 2) {
          throw new TypeError("synthetic TLS reset");
        }
        return new Response(
          JSON.stringify({
            id: "chatcmpl-strict-valid",
            choices: [
              {
                finish_reason: "tool_calls",
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "strict-valid-call",
                      type: "function",
                      function: {
                        name: "create_artifact",
                        arguments: validArguments
                      }
                    }
                  ]
                }
              }
            ],
            usage: {
              prompt_tokens: 500,
              prompt_cache_hit_tokens: 100,
              prompt_cache_miss_tokens: 400,
              completion_tokens: 200,
              total_tokens: 700,
              completion_tokens_details: { reasoning_tokens: 0 }
            }
          })
        );
      })
    });
    const invoke = subject.invoke as typeof subject.invoke & {
      provider: ResponsesProvider;
    };
    invoke.provider = provider;
    const prototype = AgentRunOrchestrator.prototype as unknown as {
      requestWithOneRetry(...args: unknown[]): Promise<unknown>;
    };
    subject.invoke.requestWithOneRetry = prototype.requestWithOneRetry.bind(
      subject.orchestrator
    ) as ReturnType<typeof vi.fn>;
    subject.invoke.meteredStream = async function* (
      _input: Record<string, unknown>,
      request: ResponsesStreamRequest
    ): AsyncGenerator<ResponsesStreamEvent> {
      subject.invoke.modelRequests += 1;
      yield* provider.stream(request);
    };

    await expect(
      subject.orchestrator.run(subject.input)
    ).resolves.toMatchObject({ status: "completed" });

    expect(urls).toEqual([
      "https://api.deepseek.com/responses",
      "https://api.deepseek.com/beta/chat/completions",
      "https://api.deepseek.com/beta/chat/completions"
    ]);
    expect(requestBodies[2]).toBe(requestBodies[1]);
    expect(subject.storage.create).toHaveBeenCalledTimes(1);
    expect(subject.store.recordToolCall).toHaveBeenCalledTimes(1);
    expect(subject.store.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "strict-valid-call",
        toolName: "create_artifact",
        status: "completed"
      })
    );
    expect(subject.orchestrator.counters).toMatchObject({
      modelRequests: 3,
      retries: 1,
      repairs: 1,
      toolRounds: 1,
      toolCalls: 1
    });
  });

  it("carries a semantic-invalid parameter table through one paired strict repair", async () => {
    const subject = artifactRunSubject([]);
    const invalidArguments = JSON.stringify({
      ...validParameterProviderArguments(),
      tables: [
        {
          title: "泵组参数",
          rows: [
            {
              parameter: "有效抽速",
              valueOrStatus: "待用户确认",
              unit: "L/s",
              assumptionOrCondition: "-"
            }
          ]
        }
      ]
    });
    const validArguments = JSON.stringify(validParameterProviderArguments());
    const urls: string[] = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        urls.push(String(url));
        requestBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>
        );
        if (urls.length === 1) {
          return new Response(
            responsesSse([
              {
                type: "response.created",
                sequence_number: 0,
                response: { id: "response-semantic-invalid" }
              },
              {
                type: "response.output_item.done",
                sequence_number: 1,
                item: {
                  type: "function_call",
                  call_id: "semantic-invalid-call",
                  name: "create_artifact",
                  arguments: invalidArguments
                }
              },
              {
                type: "response.completed",
                sequence_number: 2,
                response: {
                  id: "response-semantic-invalid",
                  output: [
                    {
                      type: "function_call",
                      call_id: "semantic-invalid-call",
                      name: "create_artifact",
                      arguments: invalidArguments
                    }
                  ]
                }
              }
            ])
          );
        }
        return new Response(
          JSON.stringify({
            id: "chatcmpl-semantic-valid",
            choices: [
              {
                finish_reason: "tool_calls",
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "semantic-valid-call",
                      type: "function",
                      function: {
                        name: "create_artifact",
                        arguments: validArguments
                      }
                    }
                  ]
                }
              }
            ]
          })
        );
      })
    });
    const invoke = subject.invoke as typeof subject.invoke & {
      provider: ResponsesProvider;
    };
    invoke.provider = provider;
    const prototype = AgentRunOrchestrator.prototype as unknown as {
      requestWithOneRetry(...args: unknown[]): Promise<unknown>;
    };
    subject.invoke.requestWithOneRetry = prototype.requestWithOneRetry.bind(
      subject.orchestrator
    ) as ReturnType<typeof vi.fn>;
    subject.invoke.meteredStream = async function* (
      _input: Record<string, unknown>,
      request: ResponsesStreamRequest
    ): AsyncGenerator<ResponsesStreamEvent> {
      subject.invoke.modelRequests += 1;
      yield* provider.stream(request);
    };

    await expect(
      subject.orchestrator.run(subject.input)
    ).resolves.toMatchObject({ status: "completed" });

    expect(urls).toEqual([
      "https://api.deepseek.com/responses",
      "https://api.deepseek.com/beta/chat/completions"
    ]);
    expect(requestBodies[1]).toMatchObject({
      thinking: { type: "disabled" },
      max_tokens: MAX_ARTIFACT_PROVIDER_OUTPUT_TOKENS,
      tools: [
        {
          function: {
            strict: true,
            parameters: {
              properties: {
                contractVersion: {
                  enum: ["openvac.parameter-table-provider.v1"]
                }
              }
            }
          }
        }
      ],
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({
          role: "tool",
          content: expect.stringContaining("assumptionOrCondition")
        })
      ])
    });
    expect(subject.storage.create).toHaveBeenCalledTimes(1);
    expect(subject.storage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          kind: "parameter_table",
          tables: [
            {
              title: "泵组参数",
              columns: ["参数", "数值或状态", "单位", "假设或工况"],
              rows: [["有效抽速", "待用户确认", "L/s", "待用户确认"]]
            }
          ]
        })
      })
    );
    expect(subject.store.recordToolCall).toHaveBeenCalledTimes(1);
    expect(subject.orchestrator.counters).toMatchObject({
      modelRequests: 2,
      repairs: 1,
      toolRounds: 1,
      toolCalls: 1
    });
  });

  it("repairs a semantic-invalid parameter table once before storage", async () => {
    const subject = artifactRunSubject([
      artifactModelResponse([
        {
          callId: "semantic-invalid-call",
          arguments: JSON.stringify(invalidParameterArtifactArguments())
        }
      ]),
      artifactModelResponse([
        {
          callId: "semantic-valid-call",
          arguments: JSON.stringify(validParameterArtifactArguments())
        }
      ])
    ]);

    await expect(
      subject.orchestrator.run(subject.input)
    ).resolves.toMatchObject({ status: "completed" });

    expect(subject.request).toHaveBeenCalledTimes(2);
    expect(subject.request.mock.calls[1]?.[5]).toBe(
      "continuation_invalid_arguments"
    );
    expect(JSON.stringify(subject.request.mock.calls[1]?.[1])).toContain(
      "assumptionOrCondition"
    );
    expect(subject.storage.create).toHaveBeenCalledTimes(1);
    expect(subject.store.recordToolCall).toHaveBeenCalledTimes(1);
    expect(subject.store.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "semantic-valid-call",
        toolName: "create_artifact",
        status: "completed"
      })
    );
    expect(subject.store.complete).toHaveBeenCalledTimes(1);
    expect(subject.orchestrator.counters).toMatchObject({
      modelRequests: 2,
      repairs: 1,
      toolRounds: 1,
      toolCalls: 1
    });
  });

  it("fails closed when the semantic parameter repair is still invalid", async () => {
    const invalidArguments = JSON.stringify(
      invalidParameterArtifactArguments()
    );
    const subject = artifactRunSubject([
      artifactModelResponse([
        { callId: "semantic-invalid-call-1", arguments: invalidArguments }
      ]),
      artifactModelResponse([
        { callId: "semantic-invalid-call-2", arguments: invalidArguments }
      ])
    ]);

    await expect(subject.orchestrator.run(subject.input)).rejects.toMatchObject(
      {
        code: "INVALID_TOOL_ARGUMENTS",
        retryable: false
      }
    );
    expect(subject.request).toHaveBeenCalledTimes(2);
    expect(subject.storage.create).not.toHaveBeenCalled();
    expect(subject.store.recordToolCall).not.toHaveBeenCalled();
    expect(subject.store.complete).not.toHaveBeenCalled();
    expect(subject.orchestrator.counters).toMatchObject({
      modelRequests: 2,
      repairs: 1,
      toolRounds: 0,
      toolCalls: 0
    });
  });

  it("rejects a mixed valid and invalid parameter-row repair without side effects", async () => {
    const mixedArguments = JSON.stringify(
      mixedInvalidParameterProviderArguments()
    );
    const subject = artifactRunSubject([
      artifactModelResponse([
        { callId: "mixed-invalid-call-1", arguments: mixedArguments }
      ]),
      artifactModelResponse([
        { callId: "mixed-invalid-call-2", arguments: mixedArguments }
      ])
    ]);

    await expect(subject.orchestrator.run(subject.input)).rejects.toMatchObject(
      {
        code: "INVALID_TOOL_ARGUMENTS",
        retryable: false
      }
    );
    expect(subject.storage.create).not.toHaveBeenCalled();
    expect(subject.store.recordToolCall).not.toHaveBeenCalled();
    expect(subject.store.complete).not.toHaveBeenCalled();
    expect(subject.orchestrator.counters).toMatchObject({
      modelRequests: 2,
      repairs: 1,
      toolRounds: 0,
      toolCalls: 0
    });
  });

  it("fails closed after a second parameter failure without storage or audit", async () => {
    const subject = artifactRunSubject([
      artifactModelResponse([
        { callId: "malformed-call", arguments: "{private-malformed" }
      ]),
      artifactModelResponse([{ callId: "zod-invalid-call", arguments: "{}" }])
    ]);

    await expect(subject.orchestrator.run(subject.input)).rejects.toMatchObject(
      {
        code: "INVALID_TOOL_ARGUMENTS",
        retryable: false
      }
    );
    expect(subject.request).toHaveBeenCalledTimes(2);
    expect(subject.storage.create).not.toHaveBeenCalled();
    expect(subject.store.recordToolCall).not.toHaveBeenCalled();
    expect(subject.orchestrator.counters).toMatchObject({
      modelRequests: 2,
      repairs: 1,
      toolRounds: 0,
      toolCalls: 0
    });
  });

  it("rejects multiple artifact calls before reservation, storage, or audit", async () => {
    const validArguments = JSON.stringify(validParameterArtifactArguments());
    const subject = artifactRunSubject([
      artifactModelResponse([
        { callId: "artifact-call-1", arguments: validArguments },
        { callId: "artifact-call-2", arguments: validArguments }
      ])
    ]);

    await expect(subject.orchestrator.run(subject.input)).rejects.toMatchObject(
      {
        code: "ARTIFACT_TOOL_CALL_COUNT_MISMATCH",
        retryable: false
      }
    );
    expect(subject.storage.create).not.toHaveBeenCalled();
    expect(subject.store.recordToolCall).not.toHaveBeenCalled();
    expect(subject.orchestrator.counters).toMatchObject({
      repairs: 0,
      toolRounds: 0,
      toolCalls: 0
    });
  });

  it("runs a clean fresh transport retry through the complete side-effect boundary", async () => {
    const subject = artifactTransportRunSubject([
      { kind: "malformed" },
      { kind: "transport_error" },
      { kind: "valid" }
    ]);

    await expect(
      subject.orchestrator.run(subject.input)
    ).resolves.toMatchObject({
      status: "completed"
    });
    expect(subject.requests).toHaveLength(3);
    expect(subject.phases).toEqual([
      "answer_1",
      "answer_artifact_fresh_json_invalid",
      "answer_artifact_fresh_json_invalid_retry"
    ]);
    expect(subject.requests[2]).toEqual(subject.requests[1]);
    for (const request of subject.requests.slice(1)) {
      expect(request.input).toEqual(subject.cleanInput);
      expect(request.toolChoice).toEqual({
        type: "function",
        name: "create_artifact"
      });
      expect(request.maxOutputTokens).toBe(MAX_ARTIFACT_PROVIDER_OUTPUT_TOKENS);
      expect(request.safeInvocationPhase).toBe("artifact_fresh_json_repair");
      expect(JSON.stringify(request)).not.toMatch(
        /private-malformed|malformed-call|previous_response_id|function_call/iu
      );
    }
    expect(subject.storage.create).toHaveBeenCalledTimes(1);
    expect(subject.store.recordToolCall).toHaveBeenCalledTimes(1);
    expect(subject.orchestrator.counters).toMatchObject({
      modelRequests: 3,
      retries: 1,
      repairs: 1,
      toolRounds: 1,
      toolCalls: 1
    });
  });

  it("fails closed after both fresh transport attempts without side effects", async () => {
    const subject = artifactTransportRunSubject([
      { kind: "malformed" },
      { kind: "transport_error" },
      { kind: "transport_error" }
    ]);

    await expect(subject.orchestrator.run(subject.input)).rejects.toMatchObject(
      {
        name: "ProviderError",
        retryable: true,
        status: 503
      }
    );
    expect(subject.requests).toHaveLength(3);
    expect(subject.requests[2]).toEqual(subject.requests[1]);
    expect(subject.storage.create).not.toHaveBeenCalled();
    expect(subject.store.recordToolCall).not.toHaveBeenCalled();
    expect(subject.orchestrator.counters).toMatchObject({
      modelRequests: 3,
      retries: 1,
      repairs: 1,
      toolRounds: 0,
      toolCalls: 0
    });
  });
});

function artifactRequestSubject() {
  const run = {
    runId: "00000000-0000-4000-8000-000000000201",
    conversationId: "00000000-0000-4000-8000-000000000202",
    userMessageId: "00000000-0000-4000-8000-000000000203",
    assistantMessageId: "00000000-0000-4000-8000-000000000204",
    turnId: "00000000-0000-4000-8000-000000000205",
    answerVersion: 1,
    question: "生成泵组选型参数表，并导出 CSV。",
    inputParts: [],
    action: "initial" as const
  };
  const provider = {
    id: "deepseek-responses",
    model: "deepseek-v4-flash",
    capabilities: {}
  } as unknown as ResponsesProvider;
  const orchestrator = new AgentRunOrchestrator(
    provider,
    {} as RunStore,
    () => undefined
  );
  const invoke = orchestrator as unknown as {
    tools: ToolRegistry;
    retries: number;
    meteredStream(
      input: Record<string, unknown>,
      request: ResponsesStreamRequest,
      phase: string
    ): AsyncGenerator<ResponsesStreamEvent>;
    collectModelResponse(
      input: ReturnType<typeof artifactRunInput>,
      modelInput: ResponsesInputItem[],
      signal: AbortSignal,
      phase: string,
      allowTools: boolean,
      artifactRecoveryMode?:
        "fresh_json_invalid" | "continuation_invalid_arguments"
    ): Promise<unknown>;
    requestWithOneRetry(
      input: ReturnType<typeof artifactRunInput>,
      modelInput: ResponsesInputItem[],
      signal: AbortSignal,
      phase: string,
      allowTools: boolean,
      artifactRecoveryMode?:
        "fresh_json_invalid" | "continuation_invalid_arguments"
    ): Promise<unknown>;
  };
  invoke.tools = new ToolRegistry(new EvidenceRegistry(), {
    userId: "user-1",
    conversationId: run.conversationId,
    userMessageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId,
    runId: run.runId,
    turnId: run.turnId,
    question: run.question,
    inputParts: []
  });
  const input = artifactRunInput(run);
  return { invoke, input };
}

function artifactRunInput(run: {
  runId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  turnId: string;
  answerVersion: number;
  question: string;
  inputParts: never[];
  action: "initial";
}) {
  return {
    userId: "user-1",
    userPartition: "partition-1",
    clientRequestId: "00000000-0000-4000-8000-000000000206",
    run,
    requestedMode: "auto" as const,
    resolvedMode: "fast" as const,
    riskLevel: "medium" as const,
    signal: new AbortController().signal
  };
}

function validParameterArtifactArguments() {
  return validParameterProviderArguments();
}

function validParameterProviderArguments() {
  return {
    contractVersion: "openvac.parameter-table-provider.v1",
    title: "泵组选型参数表",
    formats: ["csv"],
    summary: "参数、单位和假设",
    sections: [],
    tables: [
      {
        title: "泵组参数",
        rows: [
          {
            parameter: "有效抽速",
            valueOrStatus: "待用户确认",
            unit: "L/s",
            assumptionOrCondition: "待用户确认"
          }
        ]
      }
    ]
  };
}

function invalidParameterArtifactArguments() {
  return {
    ...validParameterArtifactArguments(),
    summary: "参数表包含单位和假设",
    tables: [
      {
        title: "泵组参数",
        rows: [
          {
            parameter: "有效抽速",
            valueOrStatus: "10",
            unit: "L/s",
            assumptionOrCondition: "-"
          }
        ]
      }
    ]
  };
}

function mixedInvalidParameterProviderArguments() {
  const valid = validParameterProviderArguments();
  return {
    ...valid,
    tables: [
      {
        title: "泵组参数",
        rows: [
          valid.tables[0]!.rows[0]!,
          {
            parameter: "极限压力",
            valueOrStatus: "待用户确认",
            unit: "-",
            assumptionOrCondition: "-"
          }
        ]
      }
    ]
  };
}

function artifactModelResponse(
  calls: Array<{ callId: string; arguments: string }>
) {
  const continuationItems: ResponsesInputItem[] = calls.map((call) => ({
    type: "function_call",
    call_id: call.callId,
    name: "create_artifact",
    arguments: call.arguments
  }));
  return {
    outputText: "",
    calls: calls.map((call) => ({
      ...call,
      name: "create_artifact"
    })),
    finish: {
      type: "finish" as const,
      status: "completed" as const,
      responseId: `response-${calls[0]?.callId ?? "empty"}`,
      outputText: "",
      continuationItems
    },
    callableFunctionNames: new Set(["create_artifact"]),
    forcedFunctionName: "create_artifact"
  };
}

function artifactRunSubject(
  responses: ReturnType<typeof artifactModelResponse>[]
) {
  const cleanInput: ResponsesInputItem[] = [
    { type: "message", role: "user", content: "生成泵组选型参数表" }
  ];
  const storage: ArtifactStorage & { create: ReturnType<typeof vi.fn> } = {
    create: vi.fn(async (artifactInput) => ({
      artifactId: "00000000-0000-4000-8000-000000000301",
      userId: artifactInput.userId,
      conversationId: artifactInput.conversationId,
      sourceTurnId: artifactInput.turnId,
      kind: artifactInput.spec.kind,
      title: artifactInput.spec.title,
      formats: artifactInput.spec.formats,
      status: "ready" as const
    }))
  };
  const store = {
    recordToolCall: vi.fn(async () => undefined),
    complete: vi.fn(async () => ({ content: "saved", meta: {} }))
  };
  const provider = {
    id: "deepseek-responses",
    model: "deepseek-v4-flash",
    capabilities: {
      forcedFunctionResultTransport: "native_continuation"
    }
  } as unknown as ResponsesProvider;
  const orchestrator = new AgentRunOrchestrator(
    provider,
    store as unknown as RunStore,
    () => undefined,
    { artifactStorage: storage }
  );
  const run = {
    runId: "00000000-0000-4000-8000-000000000311",
    conversationId: "00000000-0000-4000-8000-000000000312",
    userMessageId: "00000000-0000-4000-8000-000000000313",
    assistantMessageId: "00000000-0000-4000-8000-000000000314",
    turnId: "00000000-0000-4000-8000-000000000315",
    answerVersion: 1,
    question: "生成泵组选型参数表，并导出 CSV。",
    inputParts: [],
    action: "initial" as const
  };
  const input = {
    userId: "user-1",
    userPartition: "partition-1",
    clientRequestId: "00000000-0000-4000-8000-000000000316",
    run,
    requestedMode: "auto" as const,
    resolvedMode: "fast" as const,
    webMode: "auto" as const,
    riskLevel: "medium" as const,
    signal: new AbortController().signal
  };
  const invoke = orchestrator as unknown as {
    modelRequests: number;
    contextBuilder: {
      build(): Promise<{
        input: ResponsesInputItem[];
        disclosure: Record<string, unknown>;
      }>;
    };
    proactiveKnowledgeSearch(): Promise<void>;
    proactiveAttachmentEvidence(): Promise<void>;
    proactiveWebSearch(): Promise<void>;
    meteredStream(
      input: Record<string, unknown>,
      request: ResponsesStreamRequest,
      phase: string
    ): AsyncGenerator<ResponsesStreamEvent>;
    requestWithOneRetry: ReturnType<typeof vi.fn>;
  };
  invoke.contextBuilder = {
    build: async () => ({ input: cleanInput, disclosure: {} })
  };
  invoke.proactiveKnowledgeSearch = vi.fn(async () => undefined);
  invoke.proactiveAttachmentEvidence = vi.fn(async () => undefined);
  invoke.proactiveWebSearch = vi.fn(async () => undefined);
  const remaining = [...responses];
  const request = vi.fn(async (..._args: unknown[]) => {
    void _args;
    invoke.modelRequests += 1;
    const response = remaining.shift();
    if (!response) throw new Error("Unexpected third model request.");
    return response;
  });
  invoke.requestWithOneRetry = request;
  return { orchestrator, invoke, input, cleanInput, request, storage, store };
}

function artifactTransportRunSubject(
  behaviors: Array<{ kind: "malformed" | "transport_error" | "valid" }>
) {
  const subject = artifactRunSubject([]);
  const prototype = AgentRunOrchestrator.prototype as unknown as {
    requestWithOneRetry(...args: unknown[]): Promise<unknown>;
  };
  subject.invoke.requestWithOneRetry = prototype.requestWithOneRetry.bind(
    subject.orchestrator
  ) as ReturnType<typeof vi.fn>;
  const remaining = [...behaviors];
  const requests: ResponsesStreamRequest[] = [];
  const phases: string[] = [];
  subject.invoke.meteredStream = async function* (
    _input: Record<string, unknown>,
    request: ResponsesStreamRequest,
    phase: string
  ): AsyncGenerator<ResponsesStreamEvent> {
    subject.invoke.modelRequests += 1;
    requests.push(request);
    phases.push(phase);
    const behavior = remaining.shift();
    if (!behavior) throw new Error("Unexpected physical provider request.");
    if (behavior.kind === "transport_error") {
      throw new ProviderError("transient", {
        provider: "deepseek-responses",
        status: 503,
        retryable: true
      });
    }
    const callId =
      behavior.kind === "malformed" ? "malformed-call" : "valid-call";
    const argumentsValue =
      behavior.kind === "malformed"
        ? "{private-malformed-arguments"
        : JSON.stringify(validParameterArtifactArguments());
    yield {
      type: "function-call",
      callId,
      name: "create_artifact",
      arguments: argumentsValue
    };
    yield {
      type: "finish",
      status: "completed",
      responseId: `response-${callId}`,
      outputText: "",
      continuationItems: [
        {
          type: "function_call",
          call_id: callId,
          name: "create_artifact",
          arguments: argumentsValue
        }
      ]
    };
  };
  return { ...subject, requests, phases };
}

function responsesSse(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      }
      controller.close();
    }
  });
}
