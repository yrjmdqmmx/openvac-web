import { describe, expect, it } from "vitest";

import type { CalculationResult } from "@/types/chat";

import { localizeKnownCalculationBlocks } from "./orchestrator";

describe("Agent V3 orchestrator output boundary", () => {
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
});
