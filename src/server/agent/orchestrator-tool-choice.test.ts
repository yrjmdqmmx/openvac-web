import { describe, expect, it } from "vitest";

import {
  ProviderError,
  type ResponsesInputItem,
  type ResponsesTool
} from "@/server/providers";
import type { CalculationResult } from "@/types/chat";

import {
  assertAuthorizedFunctionCalls,
  reserveNonRepeatableToolCalls,
  safeModelInvocationErrorMessage,
  safeProviderTerminalErrorCode,
  selectAnswerToolRequestPolicy,
  selectAnswerToolChoice,
  selectAnswerToolRoundLimit,
  selectAnswerTools,
  selectContinuationTools
} from "./orchestrator";

const history: ResponsesInputItem[] = [
  {
    type: "message",
    role: "user",
    content: "腔体体积 100 L，等效抽速 10 L/s。"
  }
];

describe("Agent V3 deterministic calculator routing", () => {
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
      allowTools: true
    });
    expect(mixed.toolChoice).toBe("auto");
    expect(
      mixed.tools?.map((tool) => ("name" in tool ? tool.name : tool.type))
    ).toEqual(["create_artifact", "estimate_pumpdown_time"]);
    expect(mixed.callableFunctionNames).toEqual(["create_artifact"]);
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
    ).not.toThrow();

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
