import { describe, expect, it } from "vitest";

import type { ResponsesInputItem, ResponsesTool } from "@/server/providers";
import type { CalculationResult } from "@/types/chat";

import {
  selectAnswerToolChoice,
  selectAnswerToolRoundLimit,
  selectAnswerTools
} from "./orchestrator";

const history: ResponsesInputItem[] = [
  {
    type: "message",
    role: "user",
    content: "腔体体积 100 L，等效抽速 10 L/s。"
  }
];

describe("Agent V3 deterministic calculator routing", () => {
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
