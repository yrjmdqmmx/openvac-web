import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/server/api/errors";

import {
  authorizeKnowledgeReviewAutomation,
  handleClaimKnowledgeReviews,
  handleSubmitKnowledgeReviewResult
} from "./automation-review-api";
import {
  KnowledgeReviewAutomationService,
  type KnowledgeReviewAutomationRepository
} from "./automation-review-service";

const hash = "a".repeat(64);
const versionId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";

describe("knowledge review automation token", () => {
  it("rejects a missing configured token hash", () => {
    const request = new Request(
      "https://openvac.cn/api/internal/knowledge-review/claims",
      {
        headers: { authorization: "Bearer secret" }
      }
    );

    expect(() =>
      authorizeKnowledgeReviewAutomation(request, undefined)
    ).toThrowError(
      expect.objectContaining({
        status: 503,
        code: "KNOWLEDGE_REVIEW_AUTH_UNAVAILABLE"
      })
    );
  });

  it("rejects missing and wrong bearer tokens without consulting a session", () => {
    const expected = createHash("sha256").update("correct").digest("hex");
    for (const authorization of [undefined, "Basic abc", "Bearer wrong"]) {
      const request = new Request(
        "https://openvac.cn/api/internal/knowledge-review/claims",
        {
          headers: authorization ? { authorization } : undefined
        }
      );
      expect(() =>
        authorizeKnowledgeReviewAutomation(request, expected)
      ).toThrowError(
        expect.objectContaining({
          status: 401,
          code: "KNOWLEDGE_REVIEW_UNAUTHENTICATED"
        })
      );
    }
  });

  it("accepts only the bearer token whose SHA-256 matches", () => {
    const expected = createHash("sha256").update("correct").digest("hex");
    const request = new Request(
      "https://openvac.cn/api/internal/knowledge-review/claims",
      {
        headers: { authorization: "Bearer correct" }
      }
    );

    expect(
      authorizeKnowledgeReviewAutomation(request, expected)
    ).toBeUndefined();
  });
});

describe("knowledge review automation API", () => {
  it("validates claim phase and caps max at ten", async () => {
    const service = { claim: vi.fn(async () => []) };
    const tokenHash = createHash("sha256").update("correct").digest("hex");

    const response = await handleClaimKnowledgeReviews(
      new Request("https://openvac.cn/api/internal/knowledge-review/claims", {
        method: "POST",
        headers: {
          authorization: "Bearer correct",
          "content-type": "application/json"
        },
        body: JSON.stringify({ phase: "initial", max: 11 })
      }),
      service,
      tokenHash
    );

    expect(response.status).toBe(422);
    expect(service.claim).not.toHaveBeenCalled();
  });

  it("rejects unknown fields in the result envelope before calling the service", async () => {
    const service = { submitResult: vi.fn() };
    const tokenHash = createHash("sha256").update("correct").digest("hex");

    const response = await handleSubmitKnowledgeReviewResult(
      new Request(
        `https://openvac.cn/api/internal/knowledge-review/jobs/${runId}/result`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer correct",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            phase: "initial",
            leaseToken: "raw-lease-token-01234567890123456789",
            inputVersionId: versionId,
            inputContentHash: hash,
            report: validReport(),
            unexpectedEnvelopeField: "must not be stripped"
          })
        }
      ),
      runId,
      service,
      tokenHash
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" }
    });
    expect(service.submitResult).not.toHaveBeenCalled();
  });
});

describe("KnowledgeReviewAutomationService", () => {
  it("claims with independent raw tokens while persisting only their hashes", async () => {
    const repository = makeRepository();
    repository.claim = vi.fn(async (input) => [
      {
        id: runId,
        phase: input.phase,
        inputVersionId: versionId,
        inputContentHash: hash,
        model: "gpt-5.5-codex",
        attempts: 1,
        tokenSlot: 1,
        leaseExpiresAt: "2026-08-08T12:00:00.000Z"
      }
    ]);
    const service = new KnowledgeReviewAutomationService(
      repository,
      makeStorage(),
      {
        tokenFactory: (slot) => `raw-token-${slot}-01234567890123456789`
      }
    );

    const claimed = await service.claim({ phase: "initial", max: 2 });

    expect(repository.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "initial",
        max: 2,
        leaseTokenHashes: [
          sha256("raw-token-0-01234567890123456789"),
          sha256("raw-token-1-01234567890123456789")
        ]
      })
    );
    expect(claimed[0]).toMatchObject({
      id: runId,
      leaseToken: "raw-token-1-01234567890123456789"
    });
    expect(JSON.stringify(claimed)).not.toContain(
      sha256("raw-token-1-01234567890123456789")
    );
  });

  it("loads a package with a short signed private URL after lease/hash validation", async () => {
    const repository = makeRepository();
    repository.loadPackage = vi.fn(async () => ({
      id: runId,
      phase: "verify" as const,
      inputVersionId: versionId,
      inputContentHash: hash,
      content: "extracted",
      citationMetadata: { sourceUrl: "https://example.com/manual" },
      versionMetadata: { reviewStatus: "required" },
      source: { id: "source-1", rightsStatus: "approved" },
      original: {
        objectKey: "private/knowledge-originals/file.pdf",
        originalFilename: "file.pdf",
        mimeType: "application/pdf",
        sizeBytes: 12,
        sha256: hash
      }
    }));
    const storage = makeStorage();
    const service = new KnowledgeReviewAutomationService(repository, storage);

    const result = await service.getPackage({
      id: runId,
      phase: "verify",
      leaseToken: "raw-lease-token-01234567890123456789"
    });

    expect(repository.loadPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseTokenHash: sha256("raw-lease-token-01234567890123456789")
      })
    );
    expect(storage.createPrivateDownloadUrl).toHaveBeenCalledWith(
      "private/knowledge-originals/file.pdf",
      300
    );
    expect(result.original).toMatchObject({
      downloadUrl: "https://signed.invalid/file"
    });
    expect(JSON.stringify(result)).not.toContain("credential");
  });

  it("submits a strict report with the hashed lease and preserves idempotent outcomes", async () => {
    const repository = makeRepository();
    repository.complete = vi.fn(async () => ({
      runId,
      status: "completed" as const,
      decision: "approved" as const,
      currentVersionId: versionId,
      queuedPhase: "verify" as const,
      idempotent: true
    }));
    const service = new KnowledgeReviewAutomationService(
      repository,
      makeStorage()
    );

    const result = await service.submitResult({
      id: runId,
      phase: "initial",
      leaseToken: "raw-lease-token-01234567890123456789",
      inputVersionId: versionId,
      inputContentHash: hash,
      report: {
        summary: "checked",
        risk: "low",
        decision: "approved",
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
      }
    });

    expect(repository.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseTokenHash: sha256("raw-lease-token-01234567890123456789")
      })
    );
    expect(result.idempotent).toBe(true);
  });

  it("rejects reports whose evidence lacks an exact locator", async () => {
    const service = new KnowledgeReviewAutomationService(
      makeRepository(),
      makeStorage()
    );

    await expect(
      service.submitResult({
        id: runId,
        phase: "verify",
        leaseToken: "raw-lease-token-01234567890123456789",
        inputVersionId: versionId,
        inputContentHash: hash,
        report: {
          summary: "checked",
          risk: "low",
          decision: "approved",
          findings: [],
          blockers: [],
          evidence: [
            { claim: "claim", exactEvidence: "quote", sourceLocator: "" }
          ],
          numericClaims: []
        }
      })
    ).rejects.toBeInstanceOf(ApiError);
  });

  it.each([
    ["report", { ...validReport(), unexpected: true }],
    [
      "finding",
      {
        ...validReport(),
        findings: [{ code: "OK", message: "consistent", unexpected: true }]
      }
    ],
    [
      "blocker",
      {
        ...validReport(),
        blockers: [{ code: "BLOCK", message: "blocked", unexpected: true }]
      }
    ],
    [
      "evidence",
      {
        ...validReport(),
        evidence: [
          {
            claim: "claim",
            exactEvidence: "quote",
            sourceLocator: "page 1",
            unexpected: true
          }
        ]
      }
    ],
    [
      "numeric claim",
      {
        ...validReport(),
        numericClaims: [
          {
            claim: "10 Pa",
            exactEvidence: "10 Pa",
            sourceLocator: "page 1",
            unexpected: true
          }
        ]
      }
    ]
  ])("rejects unknown fields in the %s object", async (_level, report) => {
    const repository = makeRepository();
    const service = new KnowledgeReviewAutomationService(
      repository,
      makeStorage()
    );

    await expect(
      service.submitResult({
        id: runId,
        phase: "initial",
        leaseToken: "raw-lease-token-01234567890123456789",
        inputVersionId: versionId,
        inputContentHash: hash,
        report
      })
    ).rejects.toMatchObject({
      status: 422,
      code: "KNOWLEDGE_REVIEW_RESULT_INVALID"
    });
    expect(repository.complete).not.toHaveBeenCalled();
  });
});

function makeRepository(): KnowledgeReviewAutomationRepository {
  return {
    claim: vi.fn(async () => []),
    loadPackage: vi.fn(async () => null),
    complete: vi.fn(async () => {
      throw new Error("not configured");
    })
  };
}

function makeStorage() {
  return {
    id: "test",
    putPrivate: vi.fn(),
    getPrivate: vi.fn(),
    deletePrivate: vi.fn(),
    createPrivateDownloadUrl: vi.fn(async () => "https://signed.invalid/file")
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
