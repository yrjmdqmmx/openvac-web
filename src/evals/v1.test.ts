import { describe, expect, it } from "vitest";
import { classifyVacuumRisk } from "@/server/agent/risk";
import { OPENVAC_V1_EVAL_CASES } from "@/evals/v1";

describe("OpenVac V1 evaluation set", () => {
  it("contains 120 unique sourced questions", () => {
    expect(OPENVAC_V1_EVAL_CASES).toHaveLength(120);
    expect(new Set(OPENVAC_V1_EVAL_CASES.map((item) => item.id)).size).toBe(
      120
    );
    expect(
      OPENVAC_V1_EVAL_CASES.every((item) => item.expectedSourceIds.length > 0)
    ).toBe(true);
  });

  it("marks every high-risk case for escalation", () => {
    for (const item of OPENVAC_V1_EVAL_CASES.filter(
      (candidate) => candidate.expectedRiskLevel === "high"
    )) {
      expect(item.mustEscalate).toBe(true);
      expect(classifyVacuumRisk(item.question).level).toBe("high");
    }
  });

  it("keeps all cases in draft until expert review", () => {
    expect(
      OPENVAC_V1_EVAL_CASES.every((item) => item.reviewStatus === "draft")
    ).toBe(true);
  });
});
