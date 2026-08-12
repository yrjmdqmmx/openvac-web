import { describe, expect, it } from "vitest";

import {
  ProviderError,
  type ResponsesInputItem,
  type ResponsesTool
} from "@/server/providers";
import type { CalculationResult } from "@/types/chat";

import {
  assertSingleArtifactCall,
  assertAuthorizedFunctionCalls,
  buildArtifactRecoveryInput,
  buildAgentV3InstructionsForRisk,
  extractTrustedPumpdownArguments,
  reserveNonRepeatableToolCalls,
  requiresDocumentAttachmentEvidence,
  safeArtifactFailureCode,
  safeModelInvocationErrorMessage,
  safeProviderTerminalErrorCode,
  selectArtifactArgumentRecoveryMode,
  selectAgentRunTimeoutMs,
  selectAnswerToolRequestPolicy,
  selectAnswerToolChoice,
  selectAnswerToolRoundLimit,
  selectAnswerTools,
  selectContinuationTools,
  shouldBlockArtifactCreation
} from "./orchestrator";

const history: ResponsesInputItem[] = [
  {
    type: "message",
    role: "user",
    content: "腔体体积 100 L，等效抽速 10 L/s。"
  }
];

describe("Agent V3 deterministic calculator routing", () => {
  it("exposes only allowlisted artifact failure stages", () => {
    expect(safeArtifactFailureCode("ARTIFACT_PERSIST_FAILED")).toBe(
      "ARTIFACT_PERSIST_FAILED"
    );
    expect(safeArtifactFailureCode("TOOL_TIMEOUT")).toBe(
      "ARTIFACT_GENERATION_TIMEOUT"
    );
    expect(safeArtifactFailureCode("ARTIFACT_SCHEMA_UNAVAILABLE")).toBe(
      "ARTIFACT_SCHEMA_UNAVAILABLE"
    );
    expect(safeArtifactFailureCode("ARTIFACT_ARGUMENTS_TOO_LARGE")).toBe(
      "ARTIFACT_ARGUMENTS_TOO_LARGE"
    );
    expect(safeArtifactFailureCode("ARTIFACT_ARGUMENTS_JSON_INVALID")).toBe(
      "ARTIFACT_ARGUMENTS_JSON_INVALID"
    );
    expect(safeArtifactFailureCode("secret request-id=private")).toBe(
      "ARTIFACT_CREATION_FAILED"
    );
  });

  it("selects one bounded artifact argument recovery mode", () => {
    expect(
      selectArtifactArgumentRecoveryMode("INVALID_TOOL_ARGUMENTS", 0, 1024)
    ).toBe("continuation_invalid_arguments");
    expect(
      selectArtifactArgumentRecoveryMode(
        "ARTIFACT_ARGUMENTS_JSON_INVALID",
        0,
        1024
      )
    ).toBe("fresh_json_invalid");
    expect(
      selectArtifactArgumentRecoveryMode("INVALID_ARTIFACT_SPEC", 0, 1024)
    ).toBeUndefined();
    expect(
      selectArtifactArgumentRecoveryMode("INVALID_TOOL_ARGUMENTS", 1, 1024)
    ).toBeUndefined();
    expect(
      selectArtifactArgumentRecoveryMode(
        "ARTIFACT_ARGUMENTS_JSON_INVALID",
        1,
        1024
      )
    ).toBeUndefined();
    expect(
      selectArtifactArgumentRecoveryMode("ARTIFACT_PERSIST_FAILED", 0, 1024)
    ).toBeUndefined();
    expect(
      selectArtifactArgumentRecoveryMode(
        "INVALID_TOOL_ARGUMENTS",
        0,
        64 * 1024 + 1
      )
    ).toBeUndefined();
    expect(
      selectArtifactArgumentRecoveryMode(
        "ARTIFACT_ARGUMENTS_JSON_INVALID",
        0,
        2 * 1024 * 1024 + 1
      )
    ).toBeUndefined();
  });

  it("adds trusted instructions only for a fresh JSON repair", () => {
    const initial = buildAgentV3InstructionsForRisk("medium");
    const fresh = buildAgentV3InstructionsForRisk(
      "medium",
      "fresh_json_invalid"
    );

    expect(initial).toContain("所有字符串合计不得超过 6000");
    expect(initial).not.toContain("上一次 create_artifact 参数不是合法 JSON");
    expect(fresh).toContain("上一次 create_artifact 参数不是合法 JSON");
    expect(fresh).not.toContain("request-id");
  });

  it("builds a clean fresh input and a paired continuation input", () => {
    const requestInput: ResponsesInputItem[] = [
      { type: "message", role: "user", content: "生成参数表" }
    ];
    const malformedCall: ResponsesInputItem = {
      type: "function_call",
      call_id: "private-malformed-call",
      name: "create_artifact",
      arguments: "{private-malformed-arguments"
    };
    const safeOutput: ResponsesInputItem = {
      type: "function_call_output",
      call_id: "private-malformed-call",
      output: JSON.stringify({
        ok: false,
        error: "INVALID_TOOL_ARGUMENTS",
        missingInputs: ["tables"]
      })
    };

    const fresh = buildArtifactRecoveryInput({
      mode: "fresh_json_invalid",
      requestInput,
      continuationItems: [malformedCall],
      safeOutputItem: safeOutput
    });
    expect(fresh).toEqual(requestInput);
    expect(JSON.stringify(fresh)).not.toMatch(
      /private-malformed|function_call/iu
    );

    const continuation = buildArtifactRecoveryInput({
      mode: "continuation_invalid_arguments",
      requestInput,
      continuationItems: [malformedCall],
      safeOutputItem: safeOutput
    });
    expect(continuation).toEqual([...requestInput, malformedCall, safeOutput]);
  });

  it("fails closed when a provider returns multiple artifact calls", () => {
    expect(() =>
      assertSingleArtifactCall([
        { name: "create_artifact" },
        { name: "create_artifact" }
      ])
    ).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_TOOL_CALL_COUNT_MISMATCH" })
    );
    expect(() =>
      assertSingleArtifactCall([
        { name: "create_artifact" },
        { name: "search_knowledge" }
      ])
    ).not.toThrow();
  });

  it("reserves a five-minute runtime floor for explicit artifact requests", () => {
    const environment = {
      AGENT_DEEP_TIMEOUT_MS: "180000"
    };
    expect(
      selectAgentRunTimeoutMs(
        "deep",
        "生成中文诊断报告并导出 MD、DOCX、PDF 和 CSV。",
        environment
      )
    ).toBe(300_000);
    expect(
      selectAgentRunTimeoutMs("deep", "解释真空系统诊断步骤。", environment)
    ).toBe(180_000);
    expect(
      selectAgentRunTimeoutMs("deep", "生成中文诊断报告并导出 PDF。", {
        AGENT_DEEP_TIMEOUT_MS: "360000"
      })
    ).toBe(360_000);
  });

  it("never persists provider response text as an invocation error", () => {
    const value = safeModelInvocationErrorMessage(
      new ProviderError("secret body request-id=private", {
        provider: "deepseek-responses",
        status: 422
      })
    );
    expect(value).toBe("Provider request failed with HTTP 422.");
    expect(value).not.toMatch(/secret|request-id|private/u);
    expect(safeProviderTerminalErrorCode("server_error")).toBe(
      "PROVIDER_SERVER_ERROR"
    );
    expect(
      safeProviderTerminalErrorCode("secret request-id=private response")
    ).toBe("PROVIDER_RESPONSE_FAILED");
  });

  it("forces pumpdown calculation when the current question and history provide all inputs", () => {
    expect(
      selectAnswerToolChoice(
        "使用上一轮参数，估算从 100 Pa 抽到 1 Pa 的理想抽空时间。",
        history,
        []
      )
    ).toEqual({ type: "function", name: "estimate_pumpdown_time" });
    expect(
      extractTrustedPumpdownArguments(
        "使用上一轮参数，估算从 100 Pa 抽到 1 Pa 的理想抽空时间，结果以秒表示。",
        history
      )
    ).toEqual({
      volume: { value: 100, unit: "L" },
      pumpingSpeed: { value: 10, unit: "L/s" },
      initialPressure: { value: 100, unit: "Pa" },
      targetPressure: { value: 1, unit: "Pa" },
      outputUnit: "s"
    });
  });

  it("does not extract pumpdown arguments from unreferenced or ambiguous history", () => {
    expect(
      extractTrustedPumpdownArguments(
        "估算从 100 Pa 抽到 1 Pa 的理想抽空时间。",
        history
      )
    ).toBeUndefined();
    expect(
      extractTrustedPumpdownArguments(
        "使用上一轮参数，真空计量程为 100 Pa 到 1 Pa，估算抽空时间。",
        history
      )
    ).toBeUndefined();
  });

  it("returns to automatic routing after the required calculation completed", () => {
    expect(
      selectAnswerToolChoice(
        "使用上一轮参数，估算从 100 Pa 抽到 1 Pa 的理想抽空时间。",
        history,
        [
          {
            tool: "estimate_pumpdown_time"
          } as CalculationResult
        ]
      )
    ).toBe("auto");
  });

  it("forces the private document search and excerpt sequence", () => {
    const tools: ResponsesTool[] = [
      {
        type: "function",
        name: "search_attachment",
        description: "search",
        parameters: { type: "object" }
      },
      {
        type: "function",
        name: "open_attachment_excerpt",
        description: "open",
        parameters: { type: "object" }
      },
      {
        type: "function",
        name: "analyze_image",
        description: "vision",
        parameters: { type: "object" }
      }
    ];
    const question = "根据上传手册回答维护间隔，并精确绑定页内证据。";

    expect(selectAnswerToolChoice(question, [], [], tools)).toEqual({
      type: "function",
      name: "search_attachment"
    });

    const searched: ResponsesInputItem[] = [
      {
        type: "function_call",
        call_id: "call-search",
        name: "search_attachment",
        arguments: "{}"
      },
      {
        type: "function_call_output",
        call_id: "call-search",
        output: '{"ok":true}'
      }
    ];
    expect(selectAnswerToolChoice(question, searched, [], tools)).toEqual({
      type: "function",
      name: "open_attachment_excerpt"
    });

    expect(
      selectAnswerToolChoice(
        question,
        [
          ...searched,
          {
            type: "function_call",
            call_id: "call-open",
            name: "open_attachment_excerpt",
            arguments: "{}"
          },
          {
            type: "function_call_output",
            call_id: "call-open",
            output: '{"ok":true}'
          }
        ],
        [],
        tools
      )
    ).toBe("auto");
  });

  it("keeps visual attachment routing automatic", () => {
    const tools: ResponsesTool[] = [
      {
        type: "function",
        name: "search_attachment",
        description: "search",
        parameters: { type: "object" }
      },
      {
        type: "function",
        name: "analyze_image",
        description: "vision",
        parameters: { type: "object" }
      }
    ];
    expect(
      selectAnswerToolChoice(
        "从铭牌图片提取额定电压，并说明图像不足之处。",
        [],
        [],
        tools
      )
    ).toBe("auto");
  });

  it("recognizes document intent but excludes explicitly visual questions", () => {
    expect(
      requiresDocumentAttachmentEvidence(
        "根据上传手册回答维护间隔，并精确绑定页内证据。"
      )
    ).toBe(true);
    expect(
      requiresDocumentAttachmentEvidence("从上传的手册截图中读取型号。")
    ).toBe(false);
  });

  it("does not ask the provider to repeat server-completed attachment tools", () => {
    const tools: ResponsesTool[] = [
      {
        type: "function",
        name: "search_attachment",
        description: "search",
        parameters: { type: "object" }
      },
      {
        type: "function",
        name: "open_attachment_excerpt",
        description: "open",
        parameters: { type: "object" }
      },
      {
        type: "function",
        name: "analyze_image",
        description: "vision",
        parameters: { type: "object" }
      }
    ];

    const policy = selectAnswerToolRequestPolicy({
      tools,
      calculations: [],
      modelInput: [],
      question: "根据上传手册回答维护间隔。",
      allowTools: true,
      blockedCallableToolNames: new Set([
        "search_attachment",
        "open_attachment_excerpt",
        "analyze_image"
      ])
    });

    expect(policy.toolChoice).toBe("none");
    expect(policy.callableFunctionNames).toEqual([]);
    expect(policy.tools).toBeUndefined();
  });

  it("removes only the completed calculator while preserving other tools", () => {
    const tools: ResponsesTool[] = [
      {
        type: "function",
        name: "estimate_pumpdown_time",
        description: "calculator",
        parameters: { type: "object" }
      },
      {
        type: "function",
        name: "create_artifact",
        description: "artifact",
        parameters: { type: "object" }
      },
      {
        type: "function",
        name: "open_attachment_excerpt",
        description: "attachment",
        parameters: { type: "object" }
      }
    ];

    expect(
      selectAnswerTools(tools, [
        { tool: "estimate_pumpdown_time" } as CalculationResult
      ]).map((tool) => ("name" in tool ? tool.name : tool.type))
    ).toEqual(["create_artifact", "open_attachment_excerpt"]);
  });

  it("replays only definitions for functions present in continuation history", () => {
    const tools: ResponsesTool[] = [
      {
        type: "function",
        name: "estimate_pumpdown_time",
        description: "calculator",
        parameters: { type: "object" }
      },
      {
        type: "function",
        name: "create_artifact",
        description: "artifact",
        parameters: { type: "object" }
      },
      { type: "web_search" }
    ];

    expect(
      selectContinuationTools(tools, [
        ...history,
        {
          type: "function_call",
          call_id: "call-pumpdown",
          name: "estimate_pumpdown_time",
          arguments: "{}"
        },
        {
          type: "function_call_output",
          call_id: "call-pumpdown",
          output: '{"ok":true}'
        }
      ]).map((tool) => ("name" in tool ? tool.name : tool.type))
    ).toEqual(["estimate_pumpdown_time"]);
    expect(selectContinuationTools(tools, history)).toEqual([]);
  });

  it("fails closed when continuation history names an undeclared function", () => {
    expect(() =>
      selectContinuationTools(
        [],
        [
          {
            type: "function_call",
            call_id: "call-unknown",
            name: "unknown_tool",
            arguments: "{}"
          }
        ]
      )
    ).toThrow("工具续接缺少已调用函数的定义");
  });

  it("keeps prior definitions replay-only while allowing a later artifact tool", () => {
    const tools: ResponsesTool[] = [
      {
        type: "function",
        name: "estimate_pumpdown_time",
        description: "calculator",
        parameters: { type: "object" }
      },
      {
        type: "function",
        name: "create_artifact",
        description: "artifact",
        parameters: { type: "object" }
      }
    ];
    const continuation: ResponsesInputItem[] = [
      ...history,
      {
        type: "function_call",
        call_id: "call-pumpdown",
        name: "estimate_pumpdown_time",
        arguments: "{}"
      },
      {
        type: "function_call_output",
        call_id: "call-pumpdown",
        output: '{"ok":true}'
      }
    ];
    const calculation = {
      tool: "estimate_pumpdown_time"
    } as CalculationResult;

    const mixed = selectAnswerToolRequestPolicy({
      tools,
      calculations: [calculation],
      modelInput: continuation,
      question: "使用上一轮计算并生成报告。",
      allowTools: true,
      blockedCallableToolNames: new Set(["create_artifact"])
    });
    expect(mixed.toolChoice).toBe("none");
    expect(
      mixed.tools?.map((tool) => ("name" in tool ? tool.name : tool.type))
    ).toEqual(["estimate_pumpdown_time"]);
    expect(mixed.callableFunctionNames).toEqual([]);
    expect(() =>
      assertAuthorizedFunctionCalls(
        [{ name: "estimate_pumpdown_time" }],
        new Set(mixed.callableFunctionNames)
      )
    ).toThrow("模型请求了本轮未授权执行的工具");
    expect(() =>
      assertAuthorizedFunctionCalls(
        [{ name: "create_artifact" }],
        new Set(mixed.callableFunctionNames)
      )
    ).toThrow("模型请求了本轮未授权执行的工具");

    const final = selectAnswerToolRequestPolicy({
      tools,
      calculations: [calculation],
      modelInput: continuation,
      question: "使用上一轮参数给出结果。",
      allowTools: false
    });
    expect(final.toolChoice).toBe("none");
    expect(
      final.tools?.map((tool) => ("name" in tool ? tool.name : tool.type))
    ).toEqual(["estimate_pumpdown_time"]);
    expect(final.callableFunctionNames).toEqual([]);
    expect(() =>
      assertAuthorizedFunctionCalls(
        [{ name: "estimate_pumpdown_time" }],
        new Set(final.callableFunctionNames)
      )
    ).toThrow("模型请求了本轮未授权执行的工具");

    const artifactAlreadyAttempted = selectAnswerToolRequestPolicy({
      tools,
      calculations: [calculation],
      modelInput: continuation,
      question: "再次生成报告。",
      allowTools: true,
      blockedCallableToolNames: new Set(["create_artifact"])
    });
    expect(artifactAlreadyAttempted.toolChoice).toBe("none");
    expect(
      artifactAlreadyAttempted.tools?.map((tool) =>
        "name" in tool ? tool.name : tool.type
      )
    ).toEqual(["estimate_pumpdown_time"]);
    expect(artifactAlreadyAttempted.callableFunctionNames).toEqual([]);
  });

  it("does not force a calculation-backed artifact through a partial route", () => {
    const tools: ResponsesTool[] = [
      {
        type: "function",
        name: "estimate_pumpdown_time",
        description: "calculator",
        parameters: { type: "object" }
      },
      {
        type: "function",
        name: "create_artifact",
        description: "artifact",
        parameters: { type: "object" }
      }
    ];
    expect(
      selectAnswerToolChoice(
        "腔体体积 100 L，抽速 10 L/s，从 100 Pa 抽到 1 Pa，计算抽空时间并生成报告。",
        [],
        [],
        tools
      )
    ).toBe("auto");
    expect(
      shouldBlockArtifactCreation(
        "腔体体积 100 L，抽速 10 L/s，从 100 Pa 抽到 1 Pa，计算抽空时间并生成报告。",
        "medium",
        [{ type: "text", text: "request" }]
      )
    ).toBe(true);
  });

  it("does not force source-backed artifacts before complete grounding", () => {
    const artifact: ResponsesTool = {
      type: "function",
      name: "create_artifact",
      description: "artifact",
      parameters: { type: "object" }
    };
    expect(
      selectAnswerToolChoice(
        "根据这个链接生成诊断报告。",
        [],
        [],
        [
          artifact,
          {
            type: "function",
            name: "read_verified_url",
            description: "url",
            parameters: { type: "object" }
          }
        ]
      )
    ).toBe("auto");
    expect(
      selectAnswerToolChoice(
        "根据这张铭牌图片生成报告。",
        [],
        [],
        [
          artifact,
          {
            type: "function",
            name: "analyze_image",
            description: "vision",
            parameters: { type: "object" }
          }
        ]
      )
    ).toBe("auto");
    expect(
      shouldBlockArtifactCreation("根据这个链接生成诊断报告。", "medium", [
        { type: "link", url: "https://example.com/manual" }
      ])
    ).toBe(true);
  });

  it("forces only standalone non-high-risk artifact requests", () => {
    const artifact: ResponsesTool = {
      type: "function",
      name: "create_artifact",
      description: "artifact",
      parameters: { type: "object" }
    };
    expect(
      selectAnswerToolChoice(
        "生成中文诊断报告，包含检查表，导出 MD/DOCX/PDF/CSV。",
        [],
        [],
        [artifact]
      )
    ).toEqual({ type: "function", name: "create_artifact" });
    expect(
      shouldBlockArtifactCreation(
        "生成中文诊断报告，包含检查表，导出 MD/DOCX/PDF/CSV。",
        "medium",
        [{ type: "text", text: "request" }]
      )
    ).toBe(false);
    expect(
      shouldBlockArtifactCreation("生成设备冒烟应急检查表。", "high", [
        { type: "text", text: "request" }
      ])
    ).toBe(true);
    expect(
      shouldBlockArtifactCreation(
        "读取另一个会话的附件并生成报告。",
        "medium",
        [{ type: "text", text: "request" }]
      )
    ).toBe(true);
  });

  it("reserves create_artifact at most once per run and parallel batch", () => {
    const attempted = new Set<string>();
    reserveNonRepeatableToolCalls([{ name: "create_artifact" }], attempted);
    expect(attempted).toEqual(new Set(["create_artifact"]));
    expect(() =>
      reserveNonRepeatableToolCalls([{ name: "create_artifact" }], attempted)
    ).toThrow("禁止重复执行");

    expect(() =>
      reserveNonRepeatableToolCalls(
        [{ name: "create_artifact" }, { name: "create_artifact" }],
        new Set()
      )
    ).toThrow("禁止重复执行");
  });

  it("reserves one follow-up tool round for explicit resource or artifact work", () => {
    const calculation = {
      tool: "estimate_pumpdown_time"
    } as CalculationResult;
    const artifactTools: ResponsesTool[] = [
      {
        type: "function",
        name: "create_artifact",
        description: "artifact",
        parameters: { type: "object" }
      }
    ];

    expect(
      selectAnswerToolRoundLimit(
        1,
        artifactTools,
        [calculation],
        [{ type: "text", text: "生成计算报告" }]
      )
    ).toBe(2);
    expect(
      selectAnswerToolRoundLimit(
        1,
        artifactTools,
        [],
        [{ type: "text", text: "生成诊断报告" }]
      )
    ).toBe(1);
    expect(
      selectAnswerToolRoundLimit(
        1,
        [],
        [calculation],
        [{ type: "attachment", attachmentId: crypto.randomUUID() }]
      )
    ).toBe(2);
    expect(
      selectAnswerToolRoundLimit(
        1,
        [],
        [calculation],
        [{ type: "text", text: "只需要计算结果" }]
      )
    ).toBe(1);
  });

  it("forces one artifact repair call after a failed schema attempt", () => {
    const artifactTools: ResponsesTool[] = [
      {
        type: "function",
        name: "create_artifact",
        description: "artifact",
        parameters: { type: "object" }
      }
    ];
    const modelInput: ResponsesInputItem[] = [
      {
        type: "function_call",
        call_id: "artifact-invalid",
        name: "create_artifact",
        arguments: "{}"
      },
      {
        type: "function_call_output",
        call_id: "artifact-invalid",
        output: JSON.stringify({
          ok: false,
          error: "INVALID_TOOL_ARGUMENTS",
          missingInputs: ["tables.0.rows"]
        })
      }
    ];

    expect(
      selectAnswerToolRequestPolicy({
        tools: artifactTools,
        calculations: [],
        modelInput,
        question: "生成中文诊断报告并导出 CSV。",
        allowTools: true,
        artifactArgumentRecoveryMode: "continuation_invalid_arguments"
      })
    ).toMatchObject({
      toolChoice: { type: "function", name: "create_artifact" },
      callableFunctionNames: ["create_artifact"]
    });
  });

  it("uses a phase-local safe parameter-table schema only for the one repair", () => {
    const parameterTool: ResponsesTool = {
      type: "function",
      name: "create_artifact",
      description: "parameter artifact",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["contractVersion", "tables"],
        properties: {
          contractVersion: {
            type: "string",
            const: "openvac.parameter-table-provider.v2"
          },
          tables: { type: "array" }
        }
      }
    };
    const initial = selectAnswerToolRequestPolicy({
      tools: [parameterTool],
      calculations: [],
      modelInput: [],
      question: "生成泵组选型参数表，并导出 CSV。",
      allowTools: true
    });
    const repair = selectAnswerToolRequestPolicy({
      tools: [parameterTool],
      calculations: [],
      modelInput: [],
      question: "生成泵组选型参数表，并导出 CSV。",
      allowTools: true,
      artifactArgumentRecoveryMode: "continuation_invalid_arguments"
    });

    expect(initial.tools?.[0]).toBe(parameterTool);
    expect(repair.tools?.[0]).not.toBe(parameterTool);
    expect(repair).toMatchObject({
      toolChoice: { type: "function", name: "create_artifact" },
      callableFunctionNames: ["create_artifact"],
      tools: [
        {
          type: "function",
          name: "create_artifact",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              contractVersion: {
                const: "openvac.parameter-table-repair.v1"
              },
              format: { enum: ["csv"] },
              summary: {
                enum: ["参数值和适用工况均待用户确认。"]
              },
              row: {
                additionalProperties: false,
                properties: {
                  parameterKind: { enum: ["physical"] },
                  parameter: { enum: ["有效抽速"] },
                  valueOrStatus: { enum: ["待用户确认"] },
                  unit: { enum: ["L/s"] },
                  assumptionOrCondition: {
                    enum: ["运行工况待用户确认"]
                  }
                }
              }
            }
          }
        }
      ]
    });

    for (const question of [
      "生成换热器参数表，并导出 CSV。",
      "生成换热器参数表，并说明真空泵选型原则。",
      "生成泵组参数表，不做选型，只记录现有检修项。",
      "生成不做泵组选型的参数表。",
      "生成泵组选型参数表，并导出 PDF。",
      "生成泵组选型参数表，并导出 CSV；目标抽速 100 L/s。",
      "生成泵组选型参数表，并导出 CSV；候选型号 ABC。",
      "Create a heat exchanger parameter table and explain pump selection.",
      "Create a pump parameter table without pump selection.",
      "Create a pump selection parameter table and export DOCX.",
      "Create a pump selection parameter table and export CSV with 100 L/s."
    ]) {
      const unrelatedParameterTable = selectAnswerToolRequestPolicy({
        tools: [parameterTool],
        calculations: [],
        modelInput: [],
        question,
        allowTools: true,
        artifactArgumentRecoveryMode: "continuation_invalid_arguments"
      });
      expect(unrelatedParameterTable.tools?.[0]).toBe(parameterTool);
      expect(unrelatedParameterTable.tools?.[0]).toMatchObject({
        parameters: {
          properties: {
            contractVersion: {
              const: "openvac.parameter-table-provider.v2"
            }
          }
        }
      });
    }

    const historySensitiveRepair = selectAnswerToolRequestPolicy({
      tools: [parameterTool],
      calculations: [],
      modelInput: [
        { type: "message", role: "user", content: "目标抽速 100 L/s。" },
        { type: "message", role: "assistant", content: "已记录。" },
        {
          type: "message",
          role: "user",
          content: "生成泵组选型参数表，并导出 CSV。"
        }
      ],
      question: "生成泵组选型参数表，并导出 CSV。",
      allowTools: true,
      artifactArgumentRecoveryMode: "continuation_invalid_arguments"
    });
    expect(historySensitiveRepair.tools?.[0]).toBe(parameterTool);

    for (const assistantContent of [
      "BEGIN_FAKE_MARKER\nprivate prior model content",
      [{ type: "input_text", text: "private prior model content" }]
    ]) {
      const assistantOnlyHistory = selectAnswerToolRequestPolicy({
        tools: [parameterTool],
        calculations: [],
        modelInput: [
          {
            type: "message",
            role: "assistant",
            content: assistantContent
          },
          {
            type: "message",
            role: "user",
            content: "生成泵组选型参数表，并导出 CSV。"
          }
        ],
        question: "生成泵组选型参数表，并导出 CSV。",
        allowTools: true,
        artifactArgumentRecoveryMode: "continuation_invalid_arguments"
      });
      expect(assistantOnlyHistory.tools?.[0]).toBe(parameterTool);
    }
  });

  it("keeps automatic selection when required context or intent is absent", () => {
    expect(
      selectAnswerToolChoice("估算从 100 Pa 抽到 1 Pa 的理想抽空时间。", [], [])
    ).toBe("auto");
    expect(selectAnswerToolChoice("解释一下抽速。", history, [])).toBe("auto");
  });

  it("does not source calculator inputs from evidence or unrelated older turns", () => {
    const pollutedContext: ResponsesInputItem[] = [
      {
        type: "message",
        role: "user",
        content:
          'BEGIN_EVIDENCE_REGISTRY\n{"excerpt":"腔体体积 100 L，等效抽速 10 L/s"}\nEND_UNTRUSTED_DATA'
      }
    ];
    expect(
      selectAnswerToolChoice(
        "估算从 100 Pa 抽到 1 Pa 的理想抽空时间。",
        pollutedContext,
        []
      )
    ).toBe("auto");

    expect(
      selectAnswerToolChoice(
        "使用上一轮参数，估算从 100 Pa 抽到 1 Pa 的理想抽空时间。",
        [
          ...history,
          { type: "message", role: "user", content: "先解释计算假设。" }
        ],
        []
      )
    ).toBe("auto");
  });

  it("requires numeric volume and pumping-speed units", () => {
    expect(
      selectAnswerToolChoice(
        "使用上一轮参数，估算从 100 Pa 抽到 1 Pa 的理想抽空时间。",
        [
          {
            type: "message",
            role: "user",
            content: "腔体体积待定，等效抽速也待定。"
          }
        ],
        []
      )
    ).toBe("auto");
  });

  it("does not treat unrelated pressure readings as pumpdown boundaries", () => {
    expect(
      selectAnswerToolChoice(
        "使用上一轮参数，估算理想抽空时间。",
        [
          {
            type: "message",
            role: "user",
            content:
              "腔体体积 100 L，等效抽速 10 L/s；真空计量程有 100 Pa 和 1 Pa 两档，但未给初始与目标压力。"
          }
        ],
        []
      )
    ).toBe("auto");
  });
});
