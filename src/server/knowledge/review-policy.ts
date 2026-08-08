import { z } from "zod";

import {
  automationReviewDecisionSchema,
  automationReviewRiskSchema,
  knowledgeSha256Schema as sharedKnowledgeSha256Schema,
  storedAutomationReviewReportSchema
} from "./automation-review-schema";

export const ACTIVE_PENDING_REVIEW = "active_pending_review";
export const ACTIVE_REVIEWED = "active_reviewed";
export const KNOWLEDGE_AUTOMATION_POLICY_VERSION = "codex_automation_v1";
export const MAX_KNOWLEDGE_ORIGINAL_BYTES = 50 * 1024 * 1024;

export const KNOWLEDGE_FILE_MIME_BY_EXTENSION = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  jpg: "image/jpeg",
  png: "image/png"
} as const;

export const knowledgeFileExtensionSchema = z.enum([
  "pdf",
  "docx",
  "xlsx",
  "csv",
  "txt",
  "md",
  "jpg",
  "png"
]);
export const knowledgeFileMimeSchema = z.enum(
  Object.values(KNOWLEDGE_FILE_MIME_BY_EXTENSION)
);
export const knowledgeSha256Schema = sharedKnowledgeSha256Schema;
export const privateKnowledgeObjectKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSafePrivateKnowledgeObjectKey, "unsafe private object key");

export const knowledgeOriginalInputSchema = z
  .object({
    versionId: z.uuid(),
    objectKey: privateKnowledgeObjectKeySchema,
    originalFilename: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\\/\u0000]/u.test(value), "invalid filename"),
    mimeType: knowledgeFileMimeSchema,
    sizeBytes: z.number().int().positive().max(MAX_KNOWLEDGE_ORIGINAL_BYTES),
    sha256: knowledgeSha256Schema,
    uploadedBy: z.string().trim().min(1)
  })
  .superRefine((input, context) => {
    const extension = filenameExtension(input.originalFilename);
    if (
      !extension ||
      !(extension in KNOWLEDGE_FILE_MIME_BY_EXTENSION) ||
      KNOWLEDGE_FILE_MIME_BY_EXTENSION[
        extension as keyof typeof KNOWLEDGE_FILE_MIME_BY_EXTENSION
      ] !== input.mimeType
    ) {
      context.addIssue({
        code: "custom",
        path: ["mimeType"],
        message: "MIME type does not match a supported file extension."
      });
    }
  });

export const knowledgeAutomationReviewPhaseSchema = z.enum([
  "initial",
  "verify"
]);
export const knowledgeAutomationReviewStatusSchema = z.enum([
  "queued",
  "leased",
  "completed",
  "needs_human",
  "failed"
]);
export const knowledgeAutomationReviewRiskSchema = automationReviewRiskSchema;
export const knowledgeAutomationReviewDecisionSchema =
  automationReviewDecisionSchema;
export const knowledgeAutomationReviewReportSchema =
  storedAutomationReviewReportSchema;

const knowledgeAutomationReviewRunBaseSchema = z.object({
  id: z.uuid(),
  phase: knowledgeAutomationReviewPhaseSchema,
  inputVersionId: z.uuid(),
  inputContentHash: knowledgeSha256Schema,
  model: z.string().trim().min(1),
  promptVersion: z.string().trim().min(1),
  leaseTokenHash: knowledgeSha256Schema.nullable().optional(),
  leaseExpiresAt: z.union([z.date(), z.iso.datetime()]).nullable().optional(),
  attempts: z.number().int().nonnegative().optional(),
  revisedVersionId: z.uuid().nullable().optional(),
  completedAt: z.union([z.date(), z.iso.datetime()]).nullable().optional()
});

export const knowledgeAutomationReviewRunSchema = z.discriminatedUnion(
  "status",
  [
    knowledgeAutomationReviewRunBaseSchema.extend({
      status: z.enum(["queued", "leased", "needs_human", "failed"]),
      risk: knowledgeAutomationReviewRiskSchema.nullable().optional(),
      structuredReport: z.record(z.string(), z.unknown()).default({}),
      decision: knowledgeAutomationReviewDecisionSchema.nullable().optional()
    }),
    knowledgeAutomationReviewRunBaseSchema.extend({
      status: z.literal("completed"),
      risk: knowledgeAutomationReviewRiskSchema,
      structuredReport: knowledgeAutomationReviewReportSchema,
      decision: knowledgeAutomationReviewDecisionSchema
    })
  ]
);

export type KnowledgeOriginalInput = z.infer<
  typeof knowledgeOriginalInputSchema
>;
export type KnowledgeAutomationReviewRun = z.infer<
  typeof knowledgeAutomationReviewRunSchema
>;
export type KnowledgeAutomationReviewReport = z.infer<
  typeof knowledgeAutomationReviewReportSchema
>;

export type KnowledgePublicationReadinessReason =
  | "SOURCE_RIGHTS_INVALID"
  | "AUTOMATION_REVIEW_PAIR_MISSING_OR_MISMATCHED"
  | "AUTOMATION_REVIEW_HIGH_RISK"
  | "AUTOMATION_REVIEW_BLOCKERS"
  | "AUTOMATION_REVIEW_NUMERIC_EVIDENCE_MISSING";

export type KnowledgePublicationReadiness = {
  ready: boolean;
  path: typeof KNOWLEDGE_AUTOMATION_POLICY_VERSION | "legacy_sections" | null;
  reasons: KnowledgePublicationReadinessReason[];
};

/**
 * Knowledge can be used by the answer agent in either of two explicit states:
 *
 * 1. a normal human-approved publication; or
 * 2. a product-owner-activated Phase 1 publication whose exact content hash is
 *    pinned while human review is still pending.
 *
 * The second state is deliberately narrow. Changing the content hash, removing
 * the activation marker, rejecting the review, or archiving the document makes
 * the row ineligible immediately.
 */
export const RETRIEVAL_REVIEW_POLICY_SQL = `(
  (
    kv.metadata ->> 'reviewStatus' = 'approved'
    AND kv.metadata #>> '{review,status}' = 'approved'
  )
  OR (
    kv.metadata ->> 'reviewStatus' = 'required'
    AND kv.metadata ->> 'retrievalStatus' = '${ACTIVE_PENDING_REVIEW}'
    AND kv.metadata ->> 'retrievalContentHash' = kv.content_hash
  )
)`;

export function isPendingReviewRetrievalActive(input: {
  metadata: Record<string, unknown>;
  contentHash: string | null;
}): boolean {
  const configuredHash = input.metadata.retrievalContentHash;
  return (
    input.metadata.reviewStatus === "required" &&
    input.metadata.retrievalStatus === ACTIVE_PENDING_REVIEW &&
    typeof configuredHash === "string" &&
    configuredHash.length === 64 &&
    configuredHash === input.contentHash
  );
}

/**
 * Pure publication decision. `legacySectionReviewReady` is accepted only as
 * the result of the existing section-level gate; legacy metadata and old
 * whole-document hashes deliberately have no authority here.
 */
export function evaluateKnowledgePublicationReadiness(input: {
  currentVersionId: string;
  currentContentHash: string;
  sourceRightsValid: boolean;
  automationRuns: unknown[];
  legacySectionReviewReady?: boolean;
  legacyReviewMetadata?: unknown;
}): KnowledgePublicationReadiness {
  void input.legacyReviewMetadata;
  if (!input.sourceRightsValid) {
    return blocked(["SOURCE_RIGHTS_INVALID"]);
  }
  if (input.legacySectionReviewReady === true) {
    return { ready: true, path: "legacy_sections", reasons: [] };
  }

  const runs = input.automationRuns.flatMap((value) => {
    const parsed = knowledgeAutomationReviewRunSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const eligible = runs.flatMap((run) => {
    if (
      run.status !== "completed" ||
      run.decision !== "approved" ||
      run.promptVersion !== KNOWLEDGE_AUTOMATION_POLICY_VERSION
    ) {
      return [];
    }
    const storedTargetMatches =
      run.structuredReport.outputContentHash === input.currentContentHash &&
      run.structuredReport.automation.outputVersionId ===
        input.currentVersionId &&
      run.structuredReport.automation.outputContentHash ===
        input.currentContentHash &&
      run.structuredReport.automation.sourceRightsValid === true;
    const targetsCurrentInput =
      run.inputVersionId === input.currentVersionId &&
      run.inputContentHash === input.currentContentHash;
    const targetsRecordedRevision =
      run.phase === "initial" &&
      run.revisedVersionId === input.currentVersionId &&
      run.structuredReport.outputContentHash === input.currentContentHash;
    const submittedReport = run.structuredReport.automation.submittedReport;
    const submittedRevisionHash =
      run.structuredReport.automation.submittedRevisionHash;
    const submittedReportMatches =
      submittedReport.summary === run.structuredReport.summary &&
      submittedReport.risk === run.risk &&
      submittedReport.decision === run.decision &&
      sameJson(submittedReport.findings, run.structuredReport.findings) &&
      sameJson(submittedReport.blockers, run.structuredReport.blockers) &&
      sameJson(submittedReport.evidence, run.structuredReport.evidence) &&
      sameJson(
        submittedReport.numericClaims,
        run.structuredReport.numericClaims
      );
    const submittedRevisionMatches = targetsRecordedRevision
      ? submittedRevisionHash === input.currentContentHash
      : submittedRevisionHash === null;
    if (
      !storedTargetMatches ||
      (!targetsCurrentInput && !targetsRecordedRevision) ||
      !submittedReportMatches ||
      !submittedRevisionMatches
    ) {
      return [];
    }
    return [run];
  });
  const initialRuns = eligible.filter((run) => run.phase === "initial");
  const verifyRuns = eligible.filter((run) => run.phase === "verify");
  if (initialRuns.length !== 1 || verifyRuns.length !== 1) {
    return blocked(["AUTOMATION_REVIEW_PAIR_MISSING_OR_MISMATCHED"]);
  }
  const initial = initialRuns[0]!;
  const verify = verifyRuns[0]!;
  if (initial.id === verify.id) {
    return blocked(["AUTOMATION_REVIEW_PAIR_MISSING_OR_MISMATCHED"]);
  }

  const pair = [initial, verify];
  const reasons: KnowledgePublicationReadinessReason[] = [];
  if (pair.some((run) => run.risk !== "low")) {
    reasons.push("AUTOMATION_REVIEW_HIGH_RISK");
  }
  if (pair.some((run) => run.structuredReport.blockers.length > 0)) {
    reasons.push("AUTOMATION_REVIEW_BLOCKERS");
  }
  if (
    pair.some((run) =>
      run.structuredReport.numericClaims.some(
        (claim) => !claim.exactEvidence || !claim.sourceLocator
      )
    )
  ) {
    reasons.push("AUTOMATION_REVIEW_NUMERIC_EVIDENCE_MISSING");
  }
  if (reasons.length > 0) return blocked(reasons);

  return {
    ready: true,
    path: KNOWLEDGE_AUTOMATION_POLICY_VERSION,
    reasons: []
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function filenameExtension(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}

function isSafePrivateKnowledgeObjectKey(value: string): boolean {
  if (
    !/^private\/knowledge-originals\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    !value.includes("//") &&
    segments.every((segment) => segment !== "" && segment !== "..")
  );
}

function blocked(
  reasons: KnowledgePublicationReadinessReason[]
): KnowledgePublicationReadiness {
  return { ready: false, path: null, reasons };
}
