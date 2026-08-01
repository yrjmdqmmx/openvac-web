import { describe, expect, it } from "vitest";
import { classifyVacuumRisk } from "@/server/agent/risk";
import { OPENVAC_V1_EVAL_CASES } from "@/evals/v1";

const GOVERNED_SOURCE_KEYS = new Set([
  "cern-vacuum-systems-2024",
  "cern-vacuum-superconducting-devices-2014",
  "patent-us7674096b2",
  "patent-cn221568833u",
  "hse-safe-maintenance",
  "hse-dsear",
  "hse-oxygen-safety"
]);

describe("OpenVac V1 evaluation set", () => {
  it("contains 120 sourced questions plus 30 safety-policy questions", () => {
    expect(OPENVAC_V1_EVAL_CASES).toHaveLength(150);
    expect(new Set(OPENVAC_V1_EVAL_CASES.map((item) => item.id)).size).toBe(
      150
    );
    for (const item of OPENVAC_V1_EVAL_CASES) {
      expect(
        item.expectedSourceIds.every((sourceId) =>
          GOVERNED_SOURCE_KEYS.has(sourceId)
        )
      ).toBe(true);
    }
    expect(
      OPENVAC_V1_EVAL_CASES.filter(
        (item) => item.evidenceMode !== "safety_policy"
      )
    ).toHaveLength(120);
    expect(
      OPENVAC_V1_EVAL_CASES.filter(
        (item) => item.evidenceMode === "safety_policy"
      )
    ).toHaveLength(30);
  });

  it("uses only enabled phase-one source records", () => {
    const referencedSources = new Set(
      OPENVAC_V1_EVAL_CASES.flatMap((item) => item.expectedSourceIds)
    );
    expect(referencedSources).toEqual(GOVERNED_SOURCE_KEYS);
    expect(referencedSources.has("nist-si-guide")).toBe(false);
    expect(referencedSources.has("hse-safe-maintenance")).toBe(true);
    expect(referencedSources.has("hse-dsear")).toBe(true);
    expect(referencedSources.has("hse-oxygen-safety")).toBe(true);
    expect(referencedSources.has("manufacturer-product-metadata")).toBe(false);
  });

  it("marks every safety-policy behavior case for external escalation", () => {
    for (const item of OPENVAC_V1_EVAL_CASES.filter(
      (candidate) => candidate.evidenceMode === "safety_policy"
    )) {
      expect(item.mustEscalate).toBe(true);
      expect(classifyVacuumRisk(item.question).level).toBe("high");
      expect(item.expectedSourceIds).toEqual([]);
      expect(item.evidenceMode).toBe("safety_policy");
    }
  });

  it("keeps patent evidence bounded to disclosure rather than performance proof", () => {
    const patentCases = OPENVAC_V1_EVAL_CASES.filter((item) =>
      item.expectedSourceIds.some((sourceId) => sourceId.startsWith("patent-"))
    );
    expect(patentCases).toHaveLength(18);
    for (const item of patentCases) {
      expect(item.evidenceMode).toBe("metadata_reference");
      expect(item.question).toMatch(/(?:US7674096B2|CN221568833U)/iu);
      expect(item.forbiddenClaims.join(" ")).toMatch(
        /(?:通用|性能|法律|选型|故障定案)/u
      );
    }
  });

  it("keeps CERN and HSE cases on retrievable full-text evidence", () => {
    for (const item of OPENVAC_V1_EVAL_CASES.filter(
      (candidate) => candidate.evidenceMode === "retrieval"
    )) {
      expect(item.expectedSourceIds.length).toBeGreaterThan(0);
      expect(
        item.expectedSourceIds.every(
          (sourceId) =>
            sourceId.startsWith("cern-") || sourceId.startsWith("hse-")
        )
      ).toBe(true);
    }
    expect(
      OPENVAC_V1_EVAL_CASES.filter((item) => item.evidenceMode === "retrieval")
    ).toHaveLength(102);
  });

  it("removes unsupported pump-family assertions from phase one", () => {
    const topics = new Set(OPENVAC_V1_EVAL_CASES.map((item) => item.topic));
    expect(topics.has("roots-booster")).toBe(false);
    expect(topics.has("dry-scroll")).toBe(false);
    expect(topics.has("diffusion-pump")).toBe(false);
  });

  it("keeps all cases in draft until expert review", () => {
    expect(
      OPENVAC_V1_EVAL_CASES.every((item) => item.reviewStatus === "draft")
    ).toBe(true);
  });
});
