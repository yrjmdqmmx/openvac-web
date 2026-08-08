import { readFile, stat } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  KnowledgeReviewAutomationClient,
  parseKnowledgeReviewRunnerArgs,
  writeKnowledgeReviewJob
} from "./automation-review-client";

const runId = "00000000-0000-4000-8000-000000000001";
const versionId = "00000000-0000-4000-8000-000000000002";
const hash = "a".repeat(64);
const leaseToken = "lease-token-012345678901234567890";

describe("KnowledgeReviewAutomationClient", () => {
  it("uses the exact claim contract without exposing the bearer token", async () => {
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://openvac.example/api/internal/knowledge-review/claims"
        );
        expect(init).toMatchObject({
          method: "POST",
          body: JSON.stringify({ phase: "initial", max: 10 })
        });
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer local-plaintext-token"
        );
        return Response.json({ data: { claims: [claim("initial")] } });
      }
    );
    const client = new KnowledgeReviewAutomationClient({
      baseUrl: "https://openvac.example/",
      token: "local-plaintext-token",
      fetch
    });

    await expect(client.claim("initial", 10)).resolves.toEqual([
      claim("initial")
    ]);
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(
      "local-plaintext-token"
    );
  });

  it("gets a strict package with the phase query and lease header", async () => {
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          `https://openvac.example/api/internal/knowledge-review/jobs/${runId}/package?phase=verify`
        );
        expect(new Headers(init?.headers).get("x-knowledge-review-lease")).toBe(
          leaseToken
        );
        return Response.json({ data: reviewPackage("verify") });
      }
    );
    const client = new KnowledgeReviewAutomationClient({
      baseUrl: "https://openvac.example",
      token: "token",
      fetch
    });

    await expect(client.getPackage(claim("verify"))).resolves.toEqual(
      reviewPackage("verify")
    );
  });

  it("submits the strict Task 3 result envelope and rejects unknown report fields locally", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          phase: "initial",
          leaseToken,
          inputVersionId: versionId,
          inputContentHash: hash,
          report: validReport(),
          revisedContent: "revised content"
        });
        return Response.json({
          data: {
            runId,
            status: "completed",
            decision: "approved",
            currentVersionId: versionId,
            queuedPhase: "verify",
            idempotent: false
          }
        });
      }
    );
    const client = new KnowledgeReviewAutomationClient({
      baseUrl: "https://openvac.example",
      token: "token",
      fetch
    });

    await client.submit(claim("initial"), {
      report: validReport(),
      revisedContent: "revised content"
    });
    await expect(
      client.submit(claim("initial"), {
        report: {
          ...validReport(),
          unexpected: true
        } as unknown as ReturnType<typeof validReport>
      })
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("redacts the configured token from HTTP failures", async () => {
    const client = new KnowledgeReviewAutomationClient({
      baseUrl: "https://openvac.example",
      token: "do-not-log-this-token",
      fetch: vi.fn(async () =>
        Response.json(
          { error: { code: "BAD", message: "do-not-log-this-token failed" } },
          { status: 401 }
        )
      )
    });

    await expect(client.claim("initial", 1)).rejects.not.toThrow(
      /do-not-log-this-token/u
    );
  });
});

describe("knowledge review runner files and arguments", () => {
  it("writes lease-bearing job bundles with owner-only permissions", async () => {
    const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp("/tmp/openvac-review-client-")
    );
    const path = await writeKnowledgeReviewJob(directory, {
      claim: claim("initial"),
      package: reviewPackage("initial")
    });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      claim: { id: runId, phase: "initial" },
      package: { inputContentHash: hash }
    });
  });

  it("supports explicit initial and verify claim/submit commands", () => {
    expect(
      parseKnowledgeReviewRunnerArgs(["claim", "--phase", "verify"])
    ).toEqual({
      command: "claim",
      phase: "verify",
      max: 10,
      stateDir: ".openvac/knowledge-review"
    });
    expect(
      parseKnowledgeReviewRunnerArgs([
        "submit",
        "--job",
        "/tmp/job.json",
        "--report",
        "/tmp/report.json"
      ])
    ).toEqual({
      command: "submit",
      jobPath: "/tmp/job.json",
      reportPath: "/tmp/report.json"
    });
  });
});

function claim(phase: "initial" | "verify") {
  return {
    id: runId,
    phase,
    inputVersionId: versionId,
    inputContentHash: hash,
    model: "gpt-5.5-codex" as const,
    attempts: 1,
    leaseExpiresAt: "2026-08-08T12:00:00.000Z",
    leaseToken
  };
}

function reviewPackage(phase: "initial" | "verify") {
  return {
    id: runId,
    phase,
    inputVersionId: versionId,
    inputContentHash: hash,
    content: "knowledge content",
    citationMetadata: {},
    versionMetadata: { reviewStatus: "required" },
    source: null,
    original: null
  };
}

function validReport() {
  return {
    summary: "checked",
    risk: "low" as const,
    decision: "approved" as const,
    findings: [{ code: "OK", message: "consistent" }],
    blockers: [],
    evidence: [
      {
        claim: "P = 10 Pa",
        exactEvidence: "P = 10 Pa",
        sourceLocator: "page 3, paragraph 2"
      }
    ],
    numericClaims: [
      {
        claim: "10 Pa",
        exactEvidence: "P = 10 Pa",
        sourceLocator: "page 3, paragraph 2"
      }
    ]
  };
}
