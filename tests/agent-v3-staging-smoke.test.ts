import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AGENT_V3_STAGING_ORIGIN,
  publicSmokeReport,
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
});
