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
type PublicationEvaluator = (
  input: Record<string, unknown>
) => PublicationResult;

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
  const risk = input.risk ?? "low";
  const blockers = input.blockers ?? [];
  const numericClaims = input.numericClaims ?? [];
  const findings = [{ code: "REVIEWED", message: "Evidence checked." }];
  const evidence = [
    {
      claim: "Reviewed claim",
      exactEvidence: "Reviewed source text",
      sourceLocator: "page 1, paragraph 1"
    }
  ];
  const submittedReport = {
    summary: "reviewed",
    risk,
    decision: "approved" as const,
    findings,
    blockers,
    evidence,
    numericClaims
  };
  return {
    id: input.id,
    phase: input.phase,
    status: "completed",
    inputVersionId: versionId,
    inputContentHash: input.contentHash ?? hash,
    model: "gpt-5.5-codex",
    promptVersion: "codex_automation_v1",
    risk,
    structuredReport: {
      summary: "reviewed",
      outputContentHash: input.contentHash ?? hash,
      blockers,
      numericClaims,
      findings,
      evidence,
      automation: {
        idempotencyTokenHash: "c".repeat(64),
        submittedReport,
        submittedRevisionHash: null,
        actor: "knowledge-review-automation",
        outputVersionId: versionId,
        outputContentHash: input.contentHash ?? hash,
        sourceRightsValid: true,
        queuedPhase: null
      }
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
    expect(
      schema.safeParse({ ...validUpload, sizeBytes: maxBytes }).success
    ).toBe(true);
    expect(
      schema.safeParse({ ...validUpload, sizeBytes: maxBytes + 1 }).success
    ).toBe(false);
    expect(
      schema.safeParse({ ...validUpload, sha256: hash.toUpperCase() }).success
    ).toBe(false);
    expect(
      schema.safeParse({ ...validUpload, sha256: "a".repeat(63) }).success
    ).toBe(false);
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

  it("accepts an immutable initial revision only when its recorded output is the current verify target", () => {
    const revisedInitial = {
      ...initial,
      inputVersionId: "00000000-0000-4000-8000-000000000099",
      inputContentHash: "b".repeat(64),
      revisedVersionId: versionId,
      structuredReport: {
        ...initial.structuredReport,
        outputContentHash: hash,
        automation: {
          ...initial.structuredReport.automation,
          submittedRevisionHash: hash
        }
      }
    };

    expect(
      evaluate({
        currentVersionId: versionId,
        currentContentHash: hash,
        sourceRightsValid: true,
        automationRuns: [revisedInitial, verify]
      })
    ).toEqual({ ready: true, path: "codex_automation_v1", reasons: [] });
  });

  it("fails closed when the submitted report disagrees with its stored review summary", () => {
    const tamperedInitial = {
      ...initial,
      structuredReport: {
        ...initial.structuredReport,
        automation: {
          ...initial.structuredReport.automation,
          submittedReport: {
            ...initial.structuredReport.automation.submittedReport,
            risk: "high" as const,
            blockers: [{ code: "SAFETY", message: "Unresolved hazard." }]
          }
        }
      }
    };

    expect(
      evaluate({
        currentVersionId: versionId,
        currentContentHash: hash,
        sourceRightsValid: true,
        automationRuns: [tamperedInitial, verify]
      }).ready
    ).toBe(false);
  });

  it("requires both independent reviews to be low risk", () => {
    const mediumInitial = completedRun({
      id: initial.id,
      phase: "initial",
      risk: "medium"
    });
    const mediumVerify = completedRun({
      id: verify.id,
      phase: "verify",
      risk: "medium"
    });

    expect(
      evaluate({
        currentVersionId: versionId,
        currentContentHash: hash,
        sourceRightsValid: true,
        automationRuns: [mediumInitial, mediumVerify]
      }).ready
    ).toBe(false);
  });

  it("binds an immutable revision hash to the final current content hash", () => {
    const revisedInitial = {
      ...initial,
      inputVersionId: "00000000-0000-4000-8000-000000000099",
      inputContentHash: "b".repeat(64),
      revisedVersionId: versionId,
      structuredReport: {
        ...initial.structuredReport,
        automation: {
          ...initial.structuredReport.automation,
          submittedRevisionHash: "d".repeat(64)
        }
      }
    };

    expect(
      evaluate({
        currentVersionId: versionId,
        currentContentHash: hash,
        sourceRightsValid: true,
        automationRuns: [revisedInitial, verify]
      }).ready
    ).toBe(false);
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
      automationRuns: [
        initial,
        completedRun({ id: verify.id, phase: "verify", risk: "high" })
      ]
    });
    const blockers = evaluate({
      currentVersionId: versionId,
      currentContentHash: hash,
      sourceRightsValid: true,
      automationRuns: [
        initial,
        completedRun({
          id: verify.id,
          phase: "verify",
          blockers: [{ code: "UNSUPPORTED_CLAIM", message: "claim" }]
        })
      ]
    });

    expect(highRisk.reasons).toContain("AUTOMATION_REVIEW_HIGH_RISK");
    expect(blockers.reasons).toContain("AUTOMATION_REVIEW_BLOCKERS");
  });

  it.each([
    [
      "high-risk",
      completedRun({
        id: "00000000-0000-4000-8000-000000000013",
        phase: "verify",
        risk: "high"
      })
    ],
    [
      "blocker-bearing",
      completedRun({
        id: "00000000-0000-4000-8000-000000000014",
        phase: "verify",
        blockers: [{ code: "CONFLICT", message: "conflicting evidence" }]
      })
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

  it.each([
    [
      "missing findings",
      (report: Record<string, unknown>) => {
        const missingFindings = { ...report };
        delete missingFindings.findings;
        return missingFindings;
      }
    ],
    [
      "unknown evidence field",
      (report: Record<string, unknown>) => ({
        ...report,
        evidence: [
          {
            claim: "Reviewed claim",
            exactEvidence: "Reviewed source text",
            sourceLocator: "page 1",
            unexpected: true
          }
        ]
      })
    ],
    [
      "malformed evidence locator",
      (report: Record<string, unknown>) => ({
        ...report,
        evidence: [
          {
            claim: "Reviewed claim",
            exactEvidence: "Reviewed source text",
            sourceLocator: ""
          }
        ]
      })
    ],
    [
      "unknown automation metadata",
      (report: Record<string, unknown>) => ({
        ...report,
        automation: {
          ...(report.automation as Record<string, unknown>),
          unexpected: true
        }
      })
    ]
  ])("rejects a stored automation report with %s", (_label, mutate) => {
    const invalidVerify = {
      ...verify,
      structuredReport: mutate(
        verify.structuredReport as Record<string, unknown>
      )
    };
    const schema = requiredPolicyExport<SharedSchema>(
      "knowledgeAutomationReviewRunSchema"
    );

    expect(schema.safeParse(invalidVerify).success).toBe(false);
    expect(
      evaluate({
        currentVersionId: versionId,
        currentContentHash: hash,
        sourceRightsValid: true,
        automationRuns: [initial, invalidVerify]
      }).reasons
    ).toContain("AUTOMATION_REVIEW_PAIR_MISSING_OR_MISMATCHED");
  });

  it.each([
    [
      "a mismatched report output hash",
      (report: Record<string, unknown>) => ({
        ...report,
        outputContentHash: "d".repeat(64)
      })
    ],
    [
      "a mismatched automation output hash",
      (report: Record<string, unknown>) => ({
        ...report,
        automation: {
          ...(report.automation as Record<string, unknown>),
          outputContentHash: "d".repeat(64)
        }
      })
    ],
    [
      "a mismatched automation output version",
      (report: Record<string, unknown>) => ({
        ...report,
        automation: {
          ...(report.automation as Record<string, unknown>),
          outputVersionId: "00000000-0000-4000-8000-000000000099"
        }
      })
    ],
    [
      "an invalid automation source-rights snapshot",
      (report: Record<string, unknown>) => ({
        ...report,
        automation: {
          ...(report.automation as Record<string, unknown>),
          sourceRightsValid: false
        }
      })
    ]
  ])("rejects an otherwise valid stored report with %s", (_label, mutate) => {
    const mismatchedVerify = {
      ...verify,
      structuredReport: mutate(
        verify.structuredReport as Record<string, unknown>
      )
    };

    expect(
      evaluate({
        currentVersionId: versionId,
        currentContentHash: hash,
        sourceRightsValid: true,
        automationRuns: [initial, mismatchedVerify]
      }).reasons
    ).toContain("AUTOMATION_REVIEW_PAIR_MISSING_OR_MISMATCHED");
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
