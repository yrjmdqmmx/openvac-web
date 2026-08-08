import { z } from "zod";

export const knowledgeSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const automationReviewRiskSchema = z.enum(["low", "medium", "high"]);
export const automationReviewDecisionSchema = z.enum([
  "approved",
  "rejected",
  "needs_human"
]);

const findingSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(4_000)
  })
  .strict();

const evidenceSchema = z
  .object({
    claim: z.string().trim().min(1).max(4_000),
    exactEvidence: z.string().trim().min(1).max(10_000),
    sourceLocator: z.string().trim().min(1).max(1_000)
  })
  .strict();

const numericClaimSchema = z
  .object({
    claim: z.string().trim().min(1).max(4_000),
    exactEvidence: z.string().trim().min(1).max(10_000).optional(),
    sourceLocator: z.string().trim().min(1).max(1_000).optional()
  })
  .strict();

export const automationReviewReportSchema = z
  .object({
    summary: z.string().trim().min(1).max(10_000),
    risk: automationReviewRiskSchema,
    decision: automationReviewDecisionSchema,
    findings: z.array(findingSchema),
    blockers: z.array(findingSchema),
    evidence: z.array(evidenceSchema),
    numericClaims: z.array(numericClaimSchema)
  })
  .strict();

export const storedAutomationReviewReportSchema = z
  .object({
    summary: z.string().trim().min(1).max(10_000),
    outputContentHash: knowledgeSha256Schema,
    findings: z.array(findingSchema),
    blockers: z.array(findingSchema),
    evidence: z.array(evidenceSchema),
    numericClaims: z.array(numericClaimSchema),
    automation: z
      .object({
        idempotencyTokenHash: knowledgeSha256Schema,
        submittedReport: automationReviewReportSchema,
        submittedRevisionHash: knowledgeSha256Schema.nullable(),
        actor: z.literal("knowledge-review-automation"),
        outputVersionId: z.uuid(),
        outputContentHash: knowledgeSha256Schema,
        sourceRightsValid: z.boolean(),
        queuedPhase: z.enum(["verify", "embedding"]).nullable()
      })
      .strict()
  })
  .strict();

export type AutomationReviewReport = z.infer<
  typeof automationReviewReportSchema
>;
export type StoredAutomationReviewReport = z.infer<
  typeof storedAutomationReviewReportSchema
>;
