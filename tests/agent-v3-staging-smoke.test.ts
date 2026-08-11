import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  AGENT_V3_STAGING_ORIGIN,
  assertNoForbiddenFields,
  publicSmokeFailureDiagnostic,
  publicSmokeReport,
  runtimeEvidenceValidationFailureDiagnostic,
  runtimeTerminalFailureDiagnostic,
  signBetterAuthSessionCookie,
  validateStagingOrigin,
  withTemporaryPrincipal
} from "../scripts/smoke-agent-v3-staging";

describe("Agent V3 staging runtime smoke safety", () => {
  it("allows only the canonical staging APP_URL", () => {
    expect(validateStagingOrigin(AGENT_V3_STAGING_ORIGIN).origin).toBe(
      AGENT_V3_STAGING_ORIGIN
    );
    for (const value of [
      "https://openvac.cn",
      "http://staging-openvac.openvac.cn",
      "https://staging-openvac.openvac.cn/acceptance"
    ]) {
      expect(() => validateStagingOrigin(value)).toThrow(
        /staging-only|canonical/u
      );
    }
  });

  it("never puts the temporary cookie or token into the public report", () => {
    const token = "temporary-token-value";
    const cookie = signBetterAuthSessionCookie(token, "s".repeat(32));
    const report = JSON.stringify(
      publicSmokeReport({
        gitSha: "a".repeat(40),
        imageDigest: `sha256:${"b".repeat(64)}`,
        baseUrl: AGENT_V3_STAGING_ORIGIN,
        runtimeEvidenceSha256: "c".repeat(64),
        runtimeCaseCount: 10
      })
    );
    expect(cookie).toContain("__Secure-better-auth.session_token=");
    expect(report).not.toContain(token);
    expect(report).not.toContain(cookie);
    expect(report).not.toContain("session_token");
  });

  it("deletes the temporary principal even when runtime capture fails", async () => {
    const principal = {
      userId: "user",
      sessionId: "session",
      sessionToken: "token",
      cookieHeader: "cookie"
    };
    const destroy = vi.fn(async () => undefined);
    await expect(
      withTemporaryPrincipal({
        create: async () => principal,
        destroy,
        run: async () => {
          throw new Error("capture failed");
        }
      })
    ).rejects.toThrow("capture failed");
    expect(destroy).toHaveBeenCalledExactlyOnceWith(principal);
  });

  it("binds ownership denial to the denied client request and exact API code", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../scripts/smoke-agent-v3-staging.ts"),
      "utf8"
    );
    expect(source).toContain("response.status !== 409");
    expect(source).toContain('error.code !== "ATTACHMENT_BIND_CONFLICT"');
    expect(source).toContain("eq(agentRuns.clientRequestId, clientRequestId)");
    expect(source).toContain("calls.length !== 0");
    expect(source).not.toContain("00000000-0000-4000-8000-000000000000");
  });

  it("runs the audited eight-case visual benchmark before runtime evidence capture", () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, "../.github/workflows/release.yml"),
      "utf8"
    );
    const benchmark = workflow.indexOf("QWEN_VL_SMOKE_MODE=benchmark");
    const runtime = workflow.indexOf("pnpm smoke:agent:v3:staging");
    expect(benchmark).toBeGreaterThan(-1);
    expect(runtime).toBeGreaterThan(benchmark);
    expect(workflow).toContain(
      "QWEN_VL_BENCHMARK_EVIDENCE=$container_dir/qwen-vision-benchmark.json"
    );
    expect(workflow).not.toContain("QWEN_VL_API_KEY: ${{ secrets.");
    expect(workflow).not.toContain("DASHSCOPE_API_KEY: ${{ secrets.");
  });

  it("keeps the long-running staging acceptance SSH session alive", () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, "../.github/workflows/release.yml"),
      "utf8"
    );
    const options = workflow.indexOf("ssh_options=(");
    const acceptance = workflow.indexOf("<<'REMOTE_ACCEPTANCE'");
    expect(options).toBeGreaterThan(-1);
    expect(acceptance).toBeGreaterThan(options);
    expect(workflow).toContain("-o ServerAliveInterval=30");
    expect(workflow).toContain("-o ServerAliveCountMax=20");
    expect(workflow).toContain("-o TCPKeepAlive=yes");
    expect(workflow).toContain('ssh "${ssh_options[@]}" "$ssh_base"');
    expect(workflow).toContain('scp "${ssh_options[@]}"');
    expect(workflow).not.toContain(
      'ssh -i "$HOME/.ssh/openvac" -o BatchMode=yes "$ssh_base"'
    );
  });

  it("reports only allowlisted staging failure fields", () => {
    const diagnostic = publicSmokeFailureDiagnostic({
      stage: "chat_terminal",
      caseId: "v3-text-safety-01",
      step: "final",
      terminalType: "run.failed",
      code: "PROVIDER_TIMEOUT",
      retryable: true,
      suggestedAction: "retry",
      settlement: "released"
    });
    expect(diagnostic).toEqual({
      schemaVersion: "openvac.agent-v3-staging-failure.v1",
      stage: "chat_terminal",
      caseId: "v3-text-safety-01",
      step: "final",
      terminalType: "run.failed",
      code: "PROVIDER_TIMEOUT",
      retryable: true,
      suggestedAction: "retry",
      settlement: "released"
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /message|request|session|cookie|secret|provider[_-]?request/iu
    );
  });

  it("keeps report finalization failures separate from principal cleanup", () => {
    expect(
      publicSmokeFailureDiagnostic({
        stage: "report_finalize",
        code: "ACCEPTANCE_SECRET_SCAN_FAILED"
      })
    ).toEqual({
      schemaVersion: "openvac.agent-v3-staging-failure.v1",
      stage: "report_finalize",
      code: "ACCEPTANCE_SECRET_SCAN_FAILED"
    });
  });

  it("maps runtime evidence schema failures to a bounded case and field code", () => {
    const validation = z
      .object({
        cases: z.array(
          z.object({
            toolAudit: z.array(
              z.object({ resultDigest: z.string().regex(/^[0-9a-f]{64}$/u) })
            )
          })
        )
      })
      .safeParse({
        cases: [
          { toolAudit: [] },
          { toolAudit: [] },
          { toolAudit: [] },
          { toolAudit: [] },
          { toolAudit: [{ resultDigest: "provider secret detail" }] }
        ]
      });
    expect(validation.success).toBe(false);
    if (validation.success) throw new Error("Expected invalid fixture.");
    const diagnostic = runtimeEvidenceValidationFailureDiagnostic(
      validation.error,
      [
        { caseId: "v3-text-safety-01" },
        { caseId: "v3-text-citation-link-02" },
        { caseId: "v3-multiturn-permission-01" },
        { caseId: "v3-multiturn-tool-02" },
        { caseId: "v3-visual-gauge-01" }
      ]
    );
    expect(diagnostic).toEqual({
      stage: "runtime_evidence_validation",
      caseId: "v3-visual-gauge-01",
      code: "RUNTIME_TOOL_RESULT_DIGEST_INVALID"
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|provider detail/iu);
  });

  it("does not echo unknown runtime evidence paths or validation messages", () => {
    const validation = z
      .object({ providerSecret: z.string() })
      .safeParse({ providerSecret: 42 });
    expect(validation.success).toBe(false);
    if (validation.success) throw new Error("Expected invalid fixture.");
    expect(
      runtimeEvidenceValidationFailureDiagnostic(validation.error, [])
    ).toEqual({
      stage: "runtime_evidence_validation",
      code: "RUNTIME_EVIDENCE_INVALID"
    });
  });

  it("reports a bounded attachment substage without object or URL details", () => {
    const diagnostic = publicSmokeFailureDiagnostic({
      stage: "attachment_ready",
      caseId: "v3-document-manual-01",
      attachmentStatus: "processing",
      parseStatus: "queued",
      code: "ATTACHMENT_PARSE_FAILED"
    });
    expect(diagnostic).toEqual({
      schemaVersion: "openvac.agent-v3-staging-failure.v1",
      stage: "attachment_ready",
      caseId: "v3-document-manual-01",
      attachmentStatus: "processing",
      parseStatus: "queued",
      code: "ATTACHMENT_PARSE_FAILED"
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /object|url|filename|message|request|session|secret/iu
    );
  });

  it("drops untrusted diagnostic values instead of echoing them", () => {
    const diagnostic = publicSmokeFailureDiagnostic({
      stage: "chat_terminal",
      caseId: "unknown-case-with-token",
      terminalType: "run.failed",
      code: "bad code: bearer secret",
      httpStatus: 999,
      attachmentStatus: "leak-secret",
      parseStatus: "unknown",
      suggestedAction: "dump-session",
      settlement: "unknown"
    });
    expect(diagnostic).toEqual({
      schemaVersion: "openvac.agent-v3-staging-failure.v1",
      stage: "chat_terminal",
      terminalType: "run.failed"
    });
  });

  it("recognizes public failed terminals without retaining messages or ids", () => {
    const terminal = runtimeTerminalFailureDiagnostic(
      "v3-text-safety-01",
      {
        type: "run.failed",
        code: "PROVIDER_TIMEOUT",
        retryable: true,
        suggestedAction: "retry",
        settlement: "released",
        message: "provider request secret detail",
        runId: "should-not-be-retained"
      },
      "history_1"
    );
    expect(terminal).toEqual({
      stage: "chat_terminal",
      caseId: "v3-text-safety-01",
      step: "history_1",
      terminalType: "run.failed",
      code: "PROVIDER_TIMEOUT",
      retryable: true,
      suggestedAction: "retry",
      settlement: "released"
    });
    expect(JSON.stringify(publicSmokeFailureDiagnostic(terminal!))).not.toMatch(
      /message|runId|secret detail/iu
    );
  });

  it("allows the public reasoning stage without allowing private provider fields", () => {
    expect(() =>
      assertNoForbiddenFields([
        {
          type: "stage.changed",
          stage: "reasoning",
          label: "正在结合对话与证据",
          runId: "run-1",
          sequence: 2
        }
      ])
    ).not.toThrow();

    for (const value of [
      { reasoning: "private" },
      { reasoning_content: "private" },
      { nested: { providerRequestId: "provider-request" } },
      { nested: [{ tool_arguments: "{}" }] }
    ]) {
      expect(() => assertNoForbiddenFields(value)).toThrow(
        "Agent V3 runtime SSE exposed a forbidden internal field."
      );
    }
  });
});
