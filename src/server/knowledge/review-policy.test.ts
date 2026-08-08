import { describe, expect, it } from "vitest";

import * as reviewPolicy from "./review-policy";
import {
  ACTIVE_PENDING_REVIEW,
  isPendingReviewRetrievalActive,
  RETRIEVAL_REVIEW_POLICY_SQL
} from "./review-policy";

const hash = "a".repeat(64);

type ParseResult = { success: boolean };
type SharedSchema = { safeParse: (value: unknown) => ParseResult };
type PublicationResult = {
  ready: boolean;
  path: "codex_automation_v1" | "legacy_sections" | null;
  reasons: string[];
};
type PublicationEvaluator = (input: Record<string, unknown>) => PublicationResult;

function requiredPolicyExport<T>(name: string): T {
  const value = (reviewPolicy as Record<string, unknown>)[name];
  expect(value, `missing policy export ${name}`).toBeDefined();
  return value as T;
}

const versionId = "00000000-0000-4000-8000-000000000001";
const validUpload = {
  versionId,
  objectKey: `private/knowledge-originals/${versionId}/${hash}.pdf`,
  originalFilename: "真空手册.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1024,
  sha256: hash,
  uploadedBy: "owner-1"
};

function completedRun(input: {
  id: string;
  phase: "initial" | "verify";
  contentHash?: string;
  risk?: "low" | "medium" | "high";
  blockers?: Array<{ code: string; message: string }>;
  numericClaims?: Array<{
    claim: string;
    exactEvidence?: string;
    sourceLocator?: string;
  }>;
}) {
  return {
    id: input.id,
    phase: input.phase,
    status: "completed",
    inputVersionId: versionId,
    inputContentHash: input.contentHash ?? hash,
    model: "gpt-5.5-codex",
    promptVersion: "codex_automation_v1",
    risk: input.risk ?? "low",
    structuredReport: {
      summary: "reviewed",
      blockers: input.blockers ?? [],
      numericClaims: input.numericClaims ?? []
    },
    decision: "approved"
  };
}

function evaluate(input: Record<string, unknown>): PublicationResult {
  return requiredPolicyExport<PublicationEvaluator>(
    "evaluateKnowledgePublicationReadiness"
  )(input);
}

describe("pending-review retrieval policy", () => {
  it("allows only an explicitly activated, hash-pinned pending review", () => {
    expect(
      isPendingReviewRetrievalActive({
        metadata: {
          reviewStatus: "required",
          retrievalStatus: ACTIVE_PENDING_REVIEW,
          retrievalContentHash: hash
        },
        contentHash: hash
      })
    ).toBe(true);
  });

  it("fails closed when content changes or activation is absent", () => {
    expect(
      isPendingReviewRetrievalActive({
        metadata: {
          reviewStatus: "required",
          retrievalStatus: ACTIVE_PENDING_REVIEW,
          retrievalContentHash: hash
        },
        contentHash: "b".repeat(64)
      })
    ).toBe(false);
    expect(
      isPendingReviewRetrievalActive({
        metadata: { reviewStatus: "required" },
        contentHash: hash
      })
    ).toBe(false);
  });

  it("keeps the SQL predicate pinned to review and content state", () => {
    expect(RETRIEVAL_REVIEW_POLICY_SQL).toContain(ACTIVE_PENDING_REVIEW);
    expect(RETRIEVAL_REVIEW_POLICY_SQL).toContain("retrievalContentHash");
    expect(RETRIEVAL_REVIEW_POLICY_SQL).toContain("kv.content_hash");
  });
});

describe("knowledge original upload policy", () => {
  it.each([
    ["manual.pdf", "application/pdf"],
    [
      "manual.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ],
    [
      "measurements.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ],
    ["measurements.csv", "text/csv"],
    ["notes.txt", "text/plain"],
    ["notes.md", "text/markdown"],
    ["page.jpg", "image/jpeg"],
    ["page.png", "image/png"]
  ])("accepts the supported %s and MIME pair", (originalFilename, mimeType) => {
    const schema = requiredPolicyExport<SharedSchema>(
      "knowledgeOriginalInputSchema"
    );

    expect(
      schema.safeParse({ ...validUpload, originalFilename, mimeType }).success
    ).toBe(true);
  });

  it("rejects unsupported or mismatched MIME and extensions", () => {
    const schema = requiredPolicyExport<SharedSchema>(
      "knowledgeOriginalInputSchema"
    );

    expect(
      schema.safeParse({
        ...validUpload,
        originalFilename: "manual.exe",
        mimeType: "application/octet-stream"
      }).success
    ).toBe(false);
    expect(
      schema.safeParse({ ...validUpload, mimeType: "image/png" }).success
    ).toBe(false);
  });

  it("enforces the inclusive 50 MB limit and lowercase SHA-256", () => {
    const schema = requiredPolicyExport<SharedSchema>(
      "knowledgeOriginalInputSchema"
    );
    const maxBytes = requiredPolicyExport<number>(
      "MAX_KNOWLEDGE_ORIGINAL_BYTES"
    );

    expect(maxBytes).toBe(50 * 1024 * 1024);
    expect(schema.safeParse({ ...validUpload, sizeBytes: maxBytes }).success).toBe(
      true
    );
    expect(
      schema.safeParse({ ...validUpload, sizeBytes: maxBytes + 1 }).success
    ).toBe(false);
    expect(schema.safeParse({ ...validUpload, sha256: hash.toUpperCase() }).success).toBe(
      false
    );
    expect(schema.safeParse({ ...validUpload, sha256: "a".repeat(63) }).success).toBe(
      false
    );
  });

  it.each([
    "public/knowledge-originals/manual.pdf",
    "/private/knowledge-originals/manual.pdf",
    "private/knowledge-originals/../manual.pdf",
    "private/knowledge-originals\\manual.pdf",
    "private/knowledge-originals/manual.pdf?token=secret"
  ])("rejects unsafe or non-private object key %s", (objectKey) => {
    const schema = requiredPolicyExport<SharedSchema>(
      "knowledgeOriginalInputSchema"
    );

    expect(schema.safeParse({ ...validUpload, objectKey }).success).toBe(false);
  });
});

describe("codex_automation_v1 publication policy", () => {
  const initial = completedRun({
    id: "00000000-0000-4000-8000-000000000011",
    phase: "initial"
  });
  const verify = completedRun({
    id: "00000000-0000-4000-8000-000000000012",
    phase: "verify"
  });

  it("parses a queued review run before a structured report exists", () => {
    const schema = requiredPolicyExport<SharedSchema>(
      "knowledgeAutomationReviewRunSchema"
    );

    expect(
      schema.safeParse({
        id: "00000000-0000-4000-8000-000000000010",
        phase: "initial",
        status: "queued",
        inputVersionId: versionId,
        inputContentHash: hash,
        model: "gpt-5.5-codex",
        promptVersion: "codex_automation_v1",
        risk: null,
        structuredReport: {},
        decision: null,
        attempts: 0
      }).success
    ).toBe(true);
  });

  it("allows distinct completed initial and verify passes on current content", () => {
    expect(
      evaluate({
        currentVersionId: versionId,
        currentContentHash: hash,
        sourceRightsValid: true,
        automationRuns: [initial, verify]
      })
    ).toEqual({
      ready: true,
      path: "codex_automation_v1",
      reasons: []
    });
  });

  it("rejects missing, duplicate, or content-mismatched review pairs", () => {
    for (const automationRuns of [
      [initial],
      [initial, { ...verify, id: initial.id }],
      [initial, { ...verify, inputContentHash: "b".repeat(64) }]
    ]) {
      const result = evaluate({
        currentVersionId: versionId,
        currentContentHash: hash,
        sourceRightsValid: true,
        automationRuns
      });
      expect(result.ready).toBe(false);
      expect(result.reasons).toContain(
        "AUTOMATION_REVIEW_PAIR_MISSING_OR_MISMATCHED"
      );
    }
  });

  it("rejects high-risk and blocker-bearing completed reviews", () => {
    const highRisk = evaluate({
      currentVersionId: versionId,
      currentContentHash: hash,
      sourceRightsValid: true,
      automationRuns: [initial, { ...verify, risk: "high" }]
    });
    const blockers = evaluate({
      currentVersionId: versionId,
      currentContentHash: hash,
      sourceRightsValid: true,
      automationRuns: [
        initial,
        {
          ...verify,
          structuredReport: {
            ...verify.structuredReport,
            blockers: [{ code: "UNSUPPORTED_CLAIM", message: "claim" }]
          }
        }
      ]
    });

    expect(highRisk.reasons).toContain("AUTOMATION_REVIEW_HIGH_RISK");
    expect(blockers.reasons).toContain("AUTOMATION_REVIEW_BLOCKERS");
  });

  it.each([
    ["high-risk", { ...verify, id: "00000000-0000-4000-8000-000000000013", risk: "high" }],
    [
      "blocker-bearing",
      {
        ...verify,
        id: "00000000-0000-4000-8000-000000000014",
        structuredReport: {
          ...verify.structuredReport,
          blockers: [{ code: "CONFLICT", message: "conflicting evidence" }]
        }
      }
    ]
  ])(
    "rejects a clean verify plus a duplicate %s verify run",
    (_label, duplicateVerify) => {
      const result = evaluate({
        currentVersionId: versionId,
        currentContentHash: hash,
        sourceRightsValid: true,
        automationRuns: [initial, verify, duplicateVerify]
      });

      expect(result.ready).toBe(false);
      expect(result.reasons).toContain(
        "AUTOMATION_REVIEW_PAIR_MISSING_OR_MISMATCHED"
      );
    }
  );

  it("requires exact evidence and a source locator for every numeric claim", () => {
    const result = evaluate({
      currentVersionId: versionId,
      currentContentHash: hash,
      sourceRightsValid: true,
      automationRuns: [
        initial,
        completedRun({
          id: verify.id,
          phase: "verify",
          numericClaims: [{ claim: "极限压力为 1 Pa" }]
        })
      ]
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain(
      "AUTOMATION_REVIEW_NUMERIC_EVIDENCE_MISSING"
    );
  });

  it("requires valid source rights for either publication path", () => {
    const result = evaluate({
      currentVersionId: versionId,
      currentContentHash: hash,
      sourceRightsValid: false,
      automationRuns: [initial, verify],
      legacySectionReviewReady: true
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("SOURCE_RIGHTS_INVALID");
  });

  it("preserves the legacy section-review gate as an alternative only", () => {
    expect(
      evaluate({
        currentVersionId: versionId,
        currentContentHash: hash,
        sourceRightsValid: true,
        automationRuns: [],
        legacySectionReviewReady: true
      })
    ).toEqual({ ready: true, path: "legacy_sections", reasons: [] });

    const staleLegacyHash = evaluate({
      currentVersionId: versionId,
      currentContentHash: hash,
      sourceRightsValid: true,
      automationRuns: [],
      legacyReviewMetadata: {
        status: "approved",
        contentHash: "b".repeat(64)
      }
    });
    expect(staleLegacyHash.ready).toBe(false);
    expect(staleLegacyHash.path).toBeNull();
    expect(staleLegacyHash.reasons).toContain(
      "AUTOMATION_REVIEW_PAIR_MISSING_OR_MISMATCHED"
    );
  });
});
