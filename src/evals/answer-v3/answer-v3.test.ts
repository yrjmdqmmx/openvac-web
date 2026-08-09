import { describe, expect, it } from "vitest";

import {
  createFixtureEvalDependencies,
  runAnswerV3Eval,
  type AnswerV3Judge
} from ".";

describe("Answer V3 automated release gate", () => {
  it("passes the complete fixture gate at 100% deterministic coverage", async () => {
    const report = await runAnswerV3Eval({
      dependencies: createFixtureEvalDependencies(),
      gitSha: "4e0d5becbd7a38986da28fc1a6b13b6b9bc6e65c",
      now: () => new Date("2026-08-09T00:00:00.000Z")
    });

    expect(report.passed).toBe(true);
    expect(report.aggregateScore).toBeGreaterThanOrEqual(90);
    expect(Object.values(report.categories)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ passed: true, score: expect.any(Number) })
      ])
    );
    for (const category of Object.values(report.categories)) {
      expect(category.score).toBeGreaterThanOrEqual(85);
    }
    for (const gate of Object.values(report.deterministicGates)) {
      expect(gate).toMatchObject({ score: 100, passed: true });
    }
    expect(report.failureIds).toEqual([]);
    expect(report.models.outputs).toEqual([
      "deepseek/deepseek-text-fixture@1",
      "qwen/qwen-vl-fixture@1"
    ]);
    expect(report.models.qwenJudge).toContain("qwen/");
    expect(report.models.deepseekJudge).toContain("deepseek/");
  }, 30_000);

  it("fails closed when the independent Qwen judge is unavailable", async () => {
    const dependencies = createFixtureEvalDependencies();
    dependencies.qwenJudge = unavailableJudge("qwen");
    const report = await runAnswerV3Eval({
      dependencies,
      gitSha: "test"
    });

    expect(report.passed).toBe(false);
    expect(report.failureIds).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/judge_unavailable:qwen$/u)
      ])
    );
    expect(report.categories.text.passed).toBe(false);
  }, 30_000);

  it("fails closed when the DeepSeek visual cross-judge is unavailable", async () => {
    const dependencies = createFixtureEvalDependencies();
    dependencies.deepseekJudge = unavailableJudge("deepseek");
    const report = await runAnswerV3Eval({
      dependencies,
      gitSha: "test"
    });

    expect(report.passed).toBe(false);
    expect(report.failureIds).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/judge_unavailable:deepseek$/u)
      ])
    );
    expect(report.categories.visual.passed).toBe(false);
  }, 30_000);
});

function unavailableJudge(provider: "qwen" | "deepseek"): AnswerV3Judge {
  return {
    provider,
    model: `${provider}-unavailable`,
    available: async () => false,
    score: async () => Promise.reject(new Error("judge unavailable"))
  };
}
