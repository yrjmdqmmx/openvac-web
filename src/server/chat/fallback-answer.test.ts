import { describe, expect, it } from "vitest";

import {
  classifyVacuumRisk,
  hasRequiredAnswerSections,
  validateCitations
} from "@/server/agent";
import { buildNoEvidenceAnswer } from "./fallback-answer";

describe("no-evidence answer fallback", () => {
  it("returns a friendly, valid five-section answer for a greeting", () => {
    const answer = buildNoEvidenceAnswer({
      question: "你好",
      risk: classifyVacuumRisk("你好")
    });

    expect(answer).toContain("我是 OpenVac 真空泵专家");
    expect(hasRequiredAnswerSections(answer)).toBe(true);
    expect(validateCitations(answer, []).valid).toBe(true);
  });

  it("does not invent facts or citation markers for an unsupported question", () => {
    const answer = buildNoEvidenceAnswer({
      question: "旋片泵返油怎么办？",
      risk: classifyVacuumRisk("旋片泵返油怎么办？")
    });

    expect(answer).toContain("暂无可核验的直接证据");
    expect(answer).not.toMatch(/\[\d+\]/u);
    expect(validateCitations(answer, []).valid).toBe(true);
  });

  it("keeps high-risk requests stopped and routes to an external professional", () => {
    const question = "氧气系统的真空泵可以带电拆修吗？";
    const answer = buildNoEvidenceAnswer({
      question,
      risk: classifyVacuumRisk(question)
    });

    expect(answer).toContain("停机、隔离能源");
    expect(answer).toContain("不得指导带电拆修");
    expect(answer).toContain("设备制造商");
    expect(hasRequiredAnswerSections(answer)).toBe(true);
  });
});
