import { describe, expect, it } from "vitest";

import {
  ANSWER_V3_EVAL_CASES,
  createFixtureEvalDependencies,
  runAnswerV3Eval,
  type AnswerV3CandidateOutput,
  type AnswerV3Judge
} from ".";

describe("Answer V3 automated release gate", () => {
  it("defines the multi-turn calculator case with complete inputs and an exact tool audit", () => {
    const testCase = ANSWER_V3_EVAL_CASES.find(
      (item) => item.id === "v3-multiturn-tool-02"
    );

    expect(testCase).toMatchObject({
      turns: [expect.stringContaining("100 L")],
      deterministicGates: expect.arrayContaining([
        "permission",
        "tool_protocol"
      ]),
      expected: {
        permissionAudit: [
          {
            name: "estimate_pumpdown_time",
            permission: "allowed",
            executed: true
          }
        ]
      }
    });
    expect(testCase?.prompt).toContain("100 Pa");
    expect(testCase?.prompt).toContain("1 Pa");
    expect(testCase?.prompt).toContain("秒");
  });

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

  it.each([
    [
      "empty permission audit",
      (output: AnswerV3CandidateOutput) => {
        output.toolAudit = [];
        output.authorizationAudit = [];
      }
    ],
    [
      "wrong permission tool",
      (output: AnswerV3CandidateOutput) => {
        output.authorizationAudit = (output.authorizationAudit ?? []).map(
          (audit) => ({ ...audit, name: "wrong_attachment_tool" })
        );
      }
    ],
    [
      "duplicate permission audit",
      (output: AnswerV3CandidateOutput) => {
        output.authorizationAudit = [
          ...(output.authorizationAudit ?? []),
          ...(output.authorizationAudit ?? [])
        ];
      }
    ]
  ])("fails the permission gate for %s", async (_label, mutate) => {
    const dependencies = mutateCandidate("v3-multiturn-permission-01", mutate);
    const report = await runAnswerV3Eval({ dependencies, gitSha: "test" });

    expect(report.passed).toBe(false);
    expect(report.deterministicGates.permission.passed).toBe(false);
    expect(report.failureIds).toContain(
      "v3-multiturn-permission-01:permission"
    );
  });

  it("ignores unrelated real tool rows when exact-matching expected permission names", async () => {
    const dependencies = mutateCandidate("v3-document-manual-01", (output) => {
      output.toolAudit.push({
        name: "search_knowledge",
        permission: "allowed",
        executed: true
      });
    });
    const report = await runAnswerV3Eval({ dependencies, gitSha: "test" });

    expect(report.deterministicGates.permission).toMatchObject({
      passed: true,
      score: 100
    });
  });

  it("fails closed when the multi-turn calculation tool audit is absent", async () => {
    const dependencies = mutateCandidate("v3-multiturn-tool-02", (output) => {
      output.toolAudit = [];
    });
    const report = await runAnswerV3Eval({ dependencies, gitSha: "test" });

    expect(report.passed).toBe(false);
    expect(report.deterministicGates.permission.passed).toBe(false);
    expect(report.failureIds).toContain("v3-multiturn-tool-02:permission");
  });

  it("fails closed when the required multi-turn calculator failed", async () => {
    const dependencies = mutateCandidate("v3-multiturn-tool-02", (output) => {
      output.toolAudit = output.toolAudit.map((audit) =>
        audit.name === "estimate_pumpdown_time"
          ? { ...audit, status: "failed" }
          : audit
      );
    });
    const report = await runAnswerV3Eval({ dependencies, gitSha: "test" });

    expect(report.passed).toBe(false);
    expect(report.deterministicGates.permission.passed).toBe(false);
    expect(report.failureIds).toContain("v3-multiturn-tool-02:permission");
  });
});

function unavailableJudge(provider: "qwen" | "deepseek"): AnswerV3Judge {
  return {
    provider,
    model: `${provider}-unavailable`,
    available: async () => false,
    score: async () => Promise.reject(new Error("judge unavailable"))
  };
}

function mutateCandidate(
  caseId: string,
  mutate: (output: AnswerV3CandidateOutput) => void
) {
  const dependencies = createFixtureEvalDependencies();
  const candidate = dependencies.candidate;
  dependencies.candidate = {
    provider: candidate.provider,
    model: candidate.model,
    execute: async (testCase) => {
      const output = await candidate.execute(testCase);
      if (testCase.id === caseId) mutate(output);
      return output;
    }
  };
  return dependencies;
}
