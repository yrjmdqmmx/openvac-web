import { describe, expect, it } from "vitest";

import type { AnswerV3 } from "@/types/chat-v3";

import {
  ANSWER_V3_JSON_SCHEMA,
  answerV3JsonSchemaForRisk,
  buildDeterministicAttachmentScopeAnswerV3,
  buildDeterministicCalculationAnswerV3,
  buildDeterministicSafeAnswerV3,
  answerV3Blocks,
  collectAnswerV3References,
  renderAnswerV3,
  requiresExpertAnswer,
  safeParseAnswerV3,
  validateAnswerV3
} from "./answer-v3";

const directAnswer: AnswerV3 = {
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

describe("Answer V3", () => {
  it("publishes a closed provider schema and rejects unknown JSON properties", () => {
    expect(ANSWER_V3_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(
      ANSWER_V3_JSON_SCHEMA.properties.blocks.items.oneOf.every(
        (schema) => schema.additionalProperties === false
      )
    ).toBe(true);
    expect(
      safeParseAnswerV3({ ...directAnswer, providerPayload: "不可透出" })
    ).toBeUndefined();
    expect(
      safeParseAnswerV3({
        ...directAnswer,
        blocks: [{ ...directAnswer.blocks[0], rawKey: "不可透出" }]
      })
    ).toBeUndefined();
  });

  it("binds the provider schema to the server-assessed risk level", () => {
    const schema = answerV3JsonSchemaForRisk("medium") as {
      properties: { riskLevel: unknown };
    };

    expect(schema.properties.riskLevel).toEqual({
      type: "string",
      const: "medium"
    });
    expect(ANSWER_V3_JSON_SCHEMA.properties.riskLevel).toEqual({
      type: "string",
      enum: ["low", "medium", "high"]
    });
  });

  it("collects references and renders a URL-free plain-text projection", () => {
    const answer: AnswerV3 = {
      ...directAnswer,
      blocks: [
        { type: "heading", level: 2, text: "结论" },
        { type: "paragraph", text: "关键结论。", evidenceIds: ["E2"] },
        { type: "link_reference", linkId: "L1", label: "制造商资料" },
        {
          type: "artifact_reference",
          artifactId: "00000000-0000-4000-8000-000000000001",
          label: "检查表"
        }
      ],
      usedEvidenceIds: ["E2"],
      usedLinkIds: ["L1"]
    };
    expect(collectAnswerV3References(answer)).toEqual({
      evidenceIds: ["E2"],
      linkIds: ["L1"],
      artifactIds: ["00000000-0000-4000-8000-000000000001"],
      calculationIds: []
    });
    expect(answerV3Blocks(answer).map(({ index }) => index)).toEqual([
      0, 1, 2, 3
    ]);
    expect(renderAnswerV3(answer, new Map([["E2", 3]]))).toBe(
      "## 结论\n\n关键结论。 [3]\n\n制造商资料\n\n检查表"
    );
  });

  it("accepts a simple low-risk direct answer and rejects direct complex answers", () => {
    expect(
      validateAnswerV3({ value: directAnswer, question: "什么是真空？" }).valid
    ).toBe(true);
    expect(
      validateAnswerV3({
        value: directAnswer,
        question: "这台泵故障原因是什么？"
      }).valid
    ).toBe(false);
    expect(requiresExpertAnswer("什么是真空？", "low")).toBe(false);
    expect(requiresExpertAnswer("如何做故障诊断？", "low")).toBe(true);
    expect(requiresExpertAnswer("简单问题", "medium")).toBe(true);
    expect(
      validateAnswerV3({
        value: { ...directAnswer, riskLevel: "medium" },
        riskLevel: "medium",
        requiresExpert: false
      }).valid
    ).toBe(false);
  });

  it("rejects unknown references, declaration drift, and body leaks", () => {
    const answer: AnswerV3 = {
      ...directAnswer,
      blocks: [
        {
          type: "paragraph",
          text: "provider tool 输出见 https://example.com/a?Signature=secret",
          evidenceIds: ["E9"]
        }
      ],
      usedEvidenceIds: [],
      usedLinkIds: []
    };
    const result = validateAnswerV3({
      value: answer,
      knownEvidenceIds: ["E1"]
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/未知证据 E9/u);
    expect(result.errors.join(" ")).toMatch(/usedEvidenceIds/u);
    expect(result.errors.join(" ")).toMatch(/URL、内部字段/u);
  });

  it("rejects dynamic internal calculation keys in any visible block", () => {
    const result = validateAnswerV3({
      value: {
        ...directAnswer,
        blocks: [
          {
            type: "paragraph",
            text: "原始 pressurePa 为 10。",
            evidenceIds: []
          }
        ]
      },
      forbiddenVisibleTerms: ["pressurePa", "calculate_throughput"]
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("内部计算字段");
  });

  it("requires verified evidence and the shared safety boundary for high-risk expert answers", () => {
    const highAnswer: AnswerV3 = {
      schemaVersion: "openvac.answer.v3",
      answerKind: "expert",
      riskLevel: "high",
      blocks: [
        {
          type: "callout",
          tone: "danger",
          body: "请立即停止设备运行，切断并隔离电源、气源和其他危险能源。联系设备制造商或本单位安全负责人进行现场核验。",
          evidenceIds: ["E1"]
        }
      ],
      missingInputs: [],
      usedEvidenceIds: ["E1"],
      usedLinkIds: []
    };
    expect(
      validateAnswerV3({
        value: highAnswer,
        riskLevel: "high",
        knownEvidenceIds: ["E1"],
        verifiedEvidenceIds: ["E1"]
      }).valid
    ).toBe(true);
    expect(
      validateAnswerV3({
        value: highAnswer,
        riskLevel: "high",
        knownEvidenceIds: ["E1"],
        verifiedEvidenceIds: []
      }).valid
    ).toBe(false);
  });

  it("requires evidence or a deterministic calculation for complex expert answers", () => {
    const expert: AnswerV3 = {
      ...directAnswer,
      answerKind: "expert",
      riskLevel: "medium",
      blocks: [
        {
          type: "paragraph",
          text: "建议按工况进行泵组选型。",
          evidenceIds: []
        }
      ]
    };

    expect(
      validateAnswerV3({
        value: expert,
        riskLevel: "medium",
        question: "请按目标压力为真空泵选型"
      }).valid
    ).toBe(false);
  });

  it("builds a deterministic high-risk safe answer that passes the boundary", () => {
    const answer = buildDeterministicSafeAnswerV3(
      "high",
      "缺少现场绝缘测试结果"
    );
    expect(validateAnswerV3({ value: answer, riskLevel: "high" }).valid).toBe(
      true
    );
    expect(renderAnswerV3(answer)).toContain("立即停机");
    expect(renderAnswerV3(answer)).toContain("隔离电源");
    expect(renderAnswerV3(answer)).toContain("联系设备制造商");
  });

  it("builds a valid non-high fallback after answer repair is exhausted", () => {
    const answer = buildDeterministicSafeAnswerV3(
      "medium",
      "结构化回答修复未完成"
    );

    expect(validateAnswerV3({ value: answer, riskLevel: "medium" }).valid).toBe(
      true
    );
    expect(answer.answerKind).toBe("clarification");
    expect(renderAnswerV3(answer)).not.toContain("已读取");
  });

  it("answers cross-conversation attachment requests from the server-owned permission policy", () => {
    const answer = buildDeterministicAttachmentScopeAnswerV3(
      "继续刚才的方案，直接读取另一个会话的附件。",
      "medium"
    );

    expect(answer).toBeDefined();
    expect(
      validateAnswerV3({
        value: answer,
        riskLevel: "medium",
        question: "继续刚才的方案，直接读取另一个会话的附件。"
      }).valid
    ).toBe(true);
    expect(renderAnswerV3(answer!)).toContain("附件仅限当前会话");
    expect(renderAnswerV3(answer!)).toContain("重新上传");
    expect(
      buildDeterministicAttachmentScopeAnswerV3(
        "读取当前会话的附件并总结。",
        "medium"
      )
    ).toBeUndefined();
    expect(
      buildDeterministicAttachmentScopeAnswerV3(
        "另一个会话讨论了权限；请打开当前会话的附件。",
        "medium"
      )
    ).toBeUndefined();
    expect(
      buildDeterministicAttachmentScopeAnswerV3(
        "Please read the file from another conversation.",
        "medium"
      )
    ).toBeDefined();
    const highRisk = buildDeterministicAttachmentScopeAnswerV3(
      "读取另一个会话的附件，其中描述设备冒烟。",
      "high"
    );
    expect(highRisk).toBeDefined();
    expect(validateAnswerV3({ value: highRisk, riskLevel: "high" }).valid).toBe(
      true
    );
    expect(renderAnswerV3(highRisk!)).toContain("附件仅限当前会话");
    expect(renderAnswerV3(highRisk!)).toContain("立即停机");
    expect(renderAnswerV3(highRisk!)).toContain("隔离电源");
  });

  it("localizes deterministic calculations without exposing internal names or keys", () => {
    const answer = buildDeterministicCalculationAnswerV3([
      {
        id: "calc_1",
        tool: "estimate_pumpdown_time",
        formulaId: "p(t)=secret",
        formulaVersion: "1.0.0",
        normalizedInputs: { rawPressurePa: 100 },
        result: {
          reachable: true,
          equilibriumPressurePa: 0.5,
          time: 90,
          unit: "s"
        },
        assumptions: ["抽速在计算区间内保持不变。"],
        warnings: ["需结合实测抽空曲线复核。"],
        sourceIds: []
      }
    ]);
    const projection = JSON.stringify(answer);
    expect(projection).toContain("抽空时间估算");
    expect(projection).toContain("90 秒");
    expect(projection).not.toContain("estimate_pumpdown_time");
    expect(projection).not.toContain("formulaId");
    expect(projection).not.toContain("equilibriumPressurePa");
    expect(projection).not.toContain("rawPressurePa");
    expect(
      validateAnswerV3({
        value: answer,
        knownCalculationIds: ["calc_1"]
      }).valid
    ).toBe(true);
  });
});
