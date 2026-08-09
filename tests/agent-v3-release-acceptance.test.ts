import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const verifier = join(repositoryRoot, "deploy/agent-v3-acceptance.mjs");
const commitSha = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;

describe("Agent V3 release acceptance provenance", () => {
  it("creates and strictly verifies the complete staging evidence set", () => {
    const fixture = createFixture();

    runVerifier("create", fixture);
    expect(JSON.parse(readFileSync(fixture.acceptance, "utf8"))).toMatchObject({
      schemaVersion: "openvac.agent-v3-acceptance.v1",
      commitSha,
      imageDigest,
      deployment: {
        migration: "passed",
        health: "passed",
        rollback: "passed"
      },
      runtimeEvidence: { status: "passed", caseCount: 10 },
      liveEval: { status: "passed" },
      artifacts: { status: "passed" },
      smoke: { status: "passed", authenticated: true },
      passed: true
    });

    expect(() => runVerifier("verify", fixture)).not.toThrow();
  });

  it("refuses tampered raw evidence even when the acceptance JSON is unchanged", () => {
    const fixture = createFixture();
    runVerifier("create", fixture);
    writeFileSync(fixture.eval, '{"passed":true}\n', "utf8");

    const result = spawnSync(
      process.execPath,
      [
        verifier,
        "verify",
        "--acceptance",
        fixture.acceptance,
        "--commit",
        commitSha,
        "--digest",
        imageDigest,
        "--run-id",
        "123",
        "--run-attempt",
        "2"
      ],
      { cwd: repositoryRoot, encoding: "utf8" }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed checksum validation");
  });

  it("refuses a deployment receipt without a completed rollback rehearsal", () => {
    const fixture = createFixture({ rollback: "not-required" });

    expect(() => runVerifier("create", fixture)).toThrow(
      /does not prove migration, health, and rollback/u
    );
  });
});

type Fixture = ReturnType<typeof createFixture>;

function createFixture(options: { rollback?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "openvac-v3-acceptance-"));
  const acceptance = join(directory, "agent-v3-acceptance.json");
  const receipt = join(directory, "deployment-receipt");
  const evalReport = join(directory, "answer-v3-live-report.json");
  const runtime = join(directory, "answer-v3-runtime-evidence.json");
  const artifacts = join(directory, "agent-v3-artifacts.json");
  const smoke = join(directory, "agent-v3-staging-smoke.json");
  writeFileSync(
    receipt,
    [
      `release=${commitSha}`,
      `web_image=sha256:${"c".repeat(64)}`,
      "migration=passed",
      "health=passed",
      `rollback_rehearsal=${options.rollback ?? "passed"}`,
      "status=healthy",
      `activation=${commitSha}-${"d".repeat(32)}`,
      ""
    ].join("\n"),
    "utf8"
  );
  const caseIds = [
    "v3-text-safety-01",
    "v3-text-citation-link-02",
    "v3-multiturn-permission-01",
    "v3-multiturn-tool-02",
    "v3-visual-gauge-01",
    "v3-visual-nameplate-02",
    "v3-document-manual-01",
    "v3-document-injection-02",
    "v3-artifact-diagnosis-01",
    "v3-artifact-parameter-02"
  ];
  writeJson(runtime, {
    schemaVersion: "openvac.answer-v3-runtime-evidence.v1",
    caseVersion: "test-cases-v1",
    gitSha: commitSha,
    imageDigest,
    generatedAt: "2026-08-09T00:00:00.000Z",
    source: {
      environment: "staging",
      baseUrl: "https://staging-openvac.openvac.cn"
    },
    cases: caseIds.map((caseId, index) => {
      const runId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      return {
        caseId,
        runId,
        browserEvents: [
          { type: "run.accepted", runId, sequence: 1 },
          { type: "run.completed", runId, sequence: 2 }
        ],
        provenance: {
          fixture: false,
          gitSha: commitSha,
          imageDigest,
          runId,
          chatSource: "staging_api_chat_sse",
          toolAuditSource: "postgres_agent_tool_call"
        },
        ...(caseId === "v3-multiturn-permission-01"
          ? {
              authorizationOutcome: {
                httpStatus: 409,
                machineErrorCode: "ATTACHMENT_BIND_CONFLICT",
                deniedRunStatus: "failed",
                forbiddenAttachmentToolCallCount: 0,
                boundToTargetMessage: false,
                agentToolCallQueryRunId: "00000000-0000-4000-8000-999999999999"
              }
            }
          : {})
      };
    })
  });
  writeJson(evalReport, {
    schemaVersion: "openvac.answer-eval-report.v3",
    caseVersion: "test-cases-v1",
    gitSha: commitSha,
    generatedAt: "2026-08-09T00:00:00.000Z",
    models: {
      candidate: "deepseek/deepseek-chat",
      outputs: ["deepseek/deepseek-chat"],
      qwenJudge: "qwen/qwen-max",
      deepseekJudge: "deepseek/deepseek-reasoner"
    },
    thresholds: { aggregate: 90, category: 85, deterministic: 100 },
    aggregateScore: 95,
    categories: Object.fromEntries(
      ["text", "multi_turn", "visual", "document_qa", "artifact"].map(
        (name) => [name, { score: 95, passed: true }]
      )
    ),
    deterministicGates: Object.fromEntries(
      ["safety", "citation", "link", "permission", "tool_protocol"].map(
        (name) => [name, { score: 100, passed: true }]
      )
    ),
    failureIds: [],
    passed: true
  });
  writeJson(artifacts, {
    schemaVersion: "openvac.agent-v3-artifact-check.v1",
    gitSha: commitSha,
    generatedAt: "2026-08-09T00:00:00.000Z",
    formats: ["md", "docx", "pdf", "csv"],
    checksums: Object.fromEntries(
      ["md", "docx", "pdf", "csv"].map((format, index) => [
        format,
        String(index + 1).repeat(64)
      ])
    ),
    deterministic: true,
    chineseText: true,
    tableStructure: true,
    csvFormulaHardened: true,
    pdfPageCount: 1,
    passed: true
  });
  const runtimeEvidenceSha256 = createHash("sha256")
    .update(readFileSync(runtime))
    .digest("hex");
  writeJson(smoke, {
    schemaVersion: "openvac.agent-v3-staging-smoke.v1",
    gitSha: commitSha,
    imageDigest,
    generatedAt: "2026-08-09T00:00:00.000Z",
    baseUrl: "https://staging-openvac.openvac.cn",
    authenticated: true,
    authenticationMode: "temporary_better_auth_session",
    protocolVersion: 3,
    health: "passed",
    runStatus: "completed",
    runtimeCaseCount: 10,
    runtimeEvidenceSha256,
    internalLeakCheck: "passed",
    conversationDeleted: true,
    temporarySessionDeleted: true,
    temporaryUserDeleted: true,
    passed: true
  });
  return { acceptance, receipt, runtime, eval: evalReport, artifacts, smoke };
}

function runVerifier(command: "create" | "verify", fixture: Fixture) {
  const common = [
    verifier,
    command,
    "--acceptance",
    fixture.acceptance,
    "--commit",
    commitSha,
    "--digest",
    imageDigest,
    "--run-id",
    "123",
    "--run-attempt",
    "2"
  ];
  if (command === "create") {
    common.push(
      "--receipt",
      fixture.receipt,
      "--runtime",
      fixture.runtime,
      "--eval",
      fixture.eval,
      "--artifacts",
      fixture.artifacts,
      "--smoke",
      fixture.smoke
    );
  }
  return execFileSync(process.execPath, common, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe"
  });
}

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
