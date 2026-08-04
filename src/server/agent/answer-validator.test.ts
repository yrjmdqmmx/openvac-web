import { describe, expect, it } from "vitest";

import type { AnswerV2 } from "@/types/chat";

import {
  AnswerValidator,
  buildDeterministicCalculationAnswer
} from "./answer-validator";
import { EvidenceRegistry } from "./evidence-registry";

const numericAnswer = (evidenceIds: string[]): AnswerV2 => ({
  schemaVersion: "openvac.answer.v2",
  answerKind: "grounded",
  conclusion: [{ text: "该工作点抽速为 100 L/s。", evidenceIds }],
  assumptions: [],
  evidence: evidenceIds.length
    ? [{ claim: "制造商给出的工作点抽速为 100 L/s。", evidenceIds }]
    : [],
  missingInputs: [],
  nextSteps: [],
  calculationRefs: []
});

describe("AnswerValidator V2 evidence boundaries", () => {
  it("accepts a calculation-only grounded answer when the calculation ID is registered", () => {
    const answer: AnswerV2 = {
      ...numericAnswer([]),
      conclusion: [
        { text: "按标准化输入计算，气体通量为 1 Pa·m³/s。", evidenceIds: [] }
      ],
      calculationRefs: ["calc_known"]
    };

    expect(
      new AnswerValidator().validate({
        value: answer,
        evidence: new EvidenceRegistry(),
        riskLevel: "low",
        calculationIds: new Set(["calc_known"]),
        requiresEvidence: true
      })
    ).toMatchObject({ valid: true });
  });

  it("rejects a numeric claim supported only by pending-review Tier A knowledge", () => {
    const evidence = new EvidenceRegistry();
    const id = addTierA(evidence, "pending_review");

    const result = new AnswerValidator().validate({
      value: numericAnswer([id]),
      evidence,
      riskLevel: "low",
      calculationIds: new Set(),
      requiresEvidence: true
    });

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(" ")).toContain("Tier A");
  });

  it("accepts a numeric claim with independently runtime-verified Tier A evidence", () => {
    const evidence = new EvidenceRegistry();
    const id = addTierA(evidence, "runtime_verified");

    expect(
      new AnswerValidator().validate({
        value: numericAnswer([id]),
        evidence,
        riskLevel: "low",
        calculationIds: new Set(),
        requiresEvidence: true
      })
    ).toMatchObject({ valid: true });
  });

  it("does not allow a calculation reference to replace evidence for high-risk advice", () => {
    const answer: AnswerV2 = {
      ...numericAnswer([]),
      conclusion: [{ text: "可以继续运行设备。", evidenceIds: [] }],
      calculationRefs: ["calc_known"]
    };
    const result = new AnswerValidator().validate({
      value: answer,
      evidence: new EvidenceRegistry(),
      riskLevel: "high",
      calculationIds: new Set(["calc_known"]),
      requiresEvidence: true
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain(
        "A high-risk answer requires verified evidence."
      );
    }
  });

  it("rejects model-authored URLs and citation numbers", () => {
    const answer: AnswerV2 = {
      ...numericAnswer([]),
      answerKind: "general_guidance",
      conclusion: [
        {
          text: "请查看 https://unregistered.example [99]。",
          evidenceIds: []
        }
      ]
    };
    const result = new AnswerValidator().validate({
      value: answer,
      evidence: new EvidenceRegistry(),
      riskLevel: "low",
      calculationIds: new Set(),
      requiresEvidence: false
    });

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.join(" ")).toContain("URLs");
  });
});

describe("buildDeterministicCalculationAnswer", () => {
  it("produces a valid grounded fallback from validated local calculations", () => {
    const calculation = {
      id: "calc_pumpdown",
      tool: "estimate_pumpdown_time",
      formulaId: "openvac.formula.pumpdown.constant-speed-load.v1",
      formulaVersion: "1.1.0",
      normalizedInputs: {
        volumeM3: 0.1,
        speedM3S: 0.01,
        initialPa: 100_000,
        targetPa: 100,
        gasLoadPaM3S: 0
      },
      result: {
        reachable: true,
        equilibriumPressurePa: 0,
        time: 69.07755278982137,
        unit: "s"
      },
      assumptions: ["容器充分混合；抽速与气载恒定。"],
      warnings: ["这是理想化估算。"],
      sourceIds: ["openvac.formula.pumpdown.constant-speed-load.v1"]
    };
    const answer = buildDeterministicCalculationAnswer([calculation]);
    expect(answer.calculationRefs).toEqual(["calc_pumpdown"]);
    expect(answer.conclusion[0]?.text).toContain("69.07755278982137");
    expect(
      new AnswerValidator().validate({
        value: answer,
        evidence: new EvidenceRegistry(),
        riskLevel: "low",
        calculationIds: new Set(["calc_pumpdown"]),
        requiresEvidence: true
      })
    ).toEqual({ valid: true, answer });
  });

  it("rejects construction without a validated calculation", () => {
    expect(() => buildDeterministicCalculationAnswer([])).toThrow(
      "At least one validated calculation is required."
    );
  });
});

function addTierA(
  registry: EvidenceRegistry,
  reviewStatus: "pending_review" | "runtime_verified"
): string {
  const id = registry.add(
    {
      citation: {
        sourceId: `source-${reviewStatus}`,
        title: "制造商性能数据",
        publisher: "Manufacturer",
        url: "https://www.leybold.com/reference",
        fetchedAt: new Date("2026-08-04T00:00:00Z"),
        licenseClass: "metadata_only"
      },
      excerpt: "该工作点抽速为 100 L/s。"
    },
    {
      trustTier: "tier_a",
      reviewStatus,
      runtimeValidated: reviewStatus === "runtime_verified"
    }
  );
  if (!id) throw new Error("Expected Tier A evidence to be registered.");
  return id;
}
