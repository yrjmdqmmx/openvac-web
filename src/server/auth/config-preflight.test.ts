import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("authentication configuration preflight", () => {
  it("reports only presence and validity without returning configuration values", async () => {
    const { inspectAuthConfig } = await import("./config-preflight");
    const sensitiveValues = [
      "https://auth.secret.example",
      "https://trusted.secret.example",
      "super-secret-value-that-is-at-least-32-characters",
      "direct-mail-access-id",
      "direct-mail-access-secret",
      "sender@secret.example"
    ];
    const report = inspectAuthConfig({
      BETTER_AUTH_URL: sensitiveValues[0],
      AUTH_TRUSTED_ORIGINS: `${sensitiveValues[0]},${sensitiveValues[1]}`,
      BETTER_AUTH_SECRET: sensitiveValues[2],
      ALIBABA_DIRECTMAIL_ACCESS_KEY_ID: sensitiveValues[3],
      ALIBABA_DIRECTMAIL_ACCESS_KEY_SECRET: sensitiveValues[4],
      ALIBABA_DIRECTMAIL_ACCOUNT_NAME: sensitiveValues[5],
      ALIBABA_DIRECTMAIL_REGION: "cn-hangzhou",
      ALIBABA_DIRECTMAIL_ENDPOINT: "dm.aliyuncs.com"
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        { name: "betterAuthUrl", present: true, valid: true },
        { name: "trustedOrigins", present: true, valid: true },
        { name: "betterAuthSecret", present: true, valid: true },
        { name: "directMail", present: true, valid: true }
      ])
    );
    const serialized = JSON.stringify(report);
    for (const sensitiveValue of sensitiveValues) {
      expect(serialized).not.toContain(sensitiveValue);
    }
  });

  it("marks malformed or incomplete configuration without echoing it", async () => {
    const { inspectAuthConfig } = await import("./config-preflight");
    const invalidUrl = "postgres://user:password@secret-db.example/openvac";
    const report = inspectAuthConfig({
      BETTER_AUTH_URL: invalidUrl,
      AUTH_TRUSTED_ORIGINS: "https://allowed.example/path",
      BETTER_AUTH_SECRET: "short",
      ALIBABA_DIRECTMAIL_ACCESS_KEY_ID: "only-one-field"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        { name: "betterAuthUrl", present: true, valid: false },
        { name: "trustedOrigins", present: true, valid: false },
        { name: "betterAuthSecret", present: true, valid: false },
        { name: "directMail", present: false, valid: false }
      ])
    );
    expect(JSON.stringify(report)).not.toContain(invalidUrl);
  });

  it("provides a secret-safe command-line preflight", () => {
    const secret = "cli-secret-value-that-is-at-least-32-characters";
    const result = spawnSync(
      "pnpm",
      ["exec", "tsx", join(process.cwd(), "scripts/check-auth-config.ts")],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          BETTER_AUTH_URL: "https://auth.example.com",
          AUTH_TRUSTED_ORIGINS:
            "https://auth.example.com,https://app.example.com",
          BETTER_AUTH_SECRET: secret,
          ALIBABA_DIRECTMAIL_ACCESS_KEY_ID: "access-id",
          ALIBABA_DIRECTMAIL_ACCESS_KEY_SECRET: "access-secret",
          ALIBABA_DIRECTMAIL_ACCOUNT_NAME: "sender@example.com",
          ALIBABA_DIRECTMAIL_REGION: "cn-hangzhou",
          ALIBABA_DIRECTMAIL_ENDPOINT: "dm.aliyuncs.com"
        }
      }
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain("auth.example.com");
    expect(result.stdout).not.toContain("access-secret");
  });

  it("requires the auth origin to be present in trusted origins", async () => {
    const { inspectAuthConfig } = await import("./config-preflight");
    const report = inspectAuthConfig({
      BETTER_AUTH_URL: "https://openvac.example",
      AUTH_TRUSTED_ORIGINS: "https://staging.openvac.example",
      BETTER_AUTH_SECRET: "a-secret-value-that-is-at-least-32-characters",
      ALIBABA_ACCESS_KEY_ID: "fallback-access-id",
      ALIBABA_ACCESS_KEY_SECRET: "fallback-access-secret",
      ALIBABA_DIRECTMAIL_ACCOUNT_NAME: "sender@openvac.example"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual({
      name: "trustedOrigins",
      present: true,
      valid: false
    });
  });

  it("accepts DirectMail's generic Alibaba credential fallback", async () => {
    const { inspectAuthConfig } = await import("./config-preflight");
    const report = inspectAuthConfig({
      BETTER_AUTH_URL: "https://openvac.example",
      AUTH_TRUSTED_ORIGINS: "https://openvac.example",
      BETTER_AUTH_SECRET: "a-secret-value-that-is-at-least-32-characters",
      ALIBABA_ACCESS_KEY_ID: "fallback-access-id",
      ALIBABA_ACCESS_KEY_SECRET: "fallback-access-secret",
      ALIBABA_DIRECTMAIL_ACCOUNT_NAME: "sender@openvac.example"
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual({
      name: "directMail",
      present: true,
      valid: true
    });
  });
});
