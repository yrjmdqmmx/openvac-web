import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import { ApiError } from "@/server/api/errors";
import type { ObjectStorage } from "@/server/providers";

import {
  KNOWLEDGE_AUTOMATION_POLICY_VERSION,
  knowledgeAutomationReviewPhaseSchema,
  knowledgeSha256Schema
} from "./review-policy";
import {
  automationReviewReportSchema,
  type AutomationReviewReport
} from "./automation-review-schema";

export { automationReviewReportSchema } from "./automation-review-schema";

const uuid = z.uuid();

export type ReviewPhase = z.infer<typeof knowledgeAutomationReviewPhaseSchema>;

export type LeaseCandidate = {
  id: string;
  phase: ReviewPhase;
  inputVersionId: string;
  inputContentHash: string;
  model: string;
  attempts: number;
  tokenSlot: number;
  leaseExpiresAt: string;
};

export type ReviewPackageRecord = {
  id: string;
  phase: ReviewPhase;
  inputVersionId: string;
  inputContentHash: string;
  content: string;
  citationMetadata: Record<string, unknown>;
  versionMetadata: Record<string, unknown>;
  source: Record<string, unknown> | null;
  original: {
    objectKey: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  } | null;
};

export type AutomationReviewOutcome = {
  runId: string;
  status: "completed" | "needs_human" | "failed";
  decision: "approved" | "rejected" | "needs_human";
  currentVersionId: string;
  queuedPhase: "verify" | "embedding" | null;
  idempotent: boolean;
};

export interface KnowledgeReviewAutomationRepository {
  claim(input: {
    phase: ReviewPhase;
    max: number;
    leaseTokenHashes: string[];
    leaseSeconds: number;
    promptVersion: typeof KNOWLEDGE_AUTOMATION_POLICY_VERSION;
  }): Promise<LeaseCandidate[]>;
  loadPackage(input: {
    id: string;
    phase: ReviewPhase;
    leaseTokenHash: string;
  }): Promise<ReviewPackageRecord | null>;
  complete(input: {
    id: string;
    phase: ReviewPhase;
    leaseTokenHash: string;
    inputVersionId: string;
    inputContentHash: string;
    report: AutomationReviewReport;
    revisedContent?: string;
  }): Promise<AutomationReviewOutcome>;
}

export class KnowledgeReviewAutomationService {
  private readonly tokenFactory: (slot: number) => string;

  constructor(
    private readonly repository: KnowledgeReviewAutomationRepository,
    private readonly storage: ObjectStorage,
    options: { tokenFactory?: (slot: number) => string } = {}
  ) {
    this.tokenFactory =
      options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  async claim(input: { phase: ReviewPhase; max: number }) {
    const result = z
      .object({
        phase: knowledgeAutomationReviewPhaseSchema,
        max: z.number().int().min(1).max(10)
      })
      .safeParse(input);
    if (!result.success) {
      throw new ApiError(
        422,
        "KNOWLEDGE_REVIEW_CLAIM_INVALID",
        "Knowledge review claim parameters are invalid.",
        result.error.issues
      );
    }
    const parsed = result.data;
    const tokens = Array.from({ length: parsed.max }, (_, slot) =>
      this.tokenFactory(slot)
    );
    const rows = await this.repository.claim({
      ...parsed,
      leaseTokenHashes: tokens.map(sha256),
      leaseSeconds: 2 * 60 * 60,
      promptVersion: KNOWLEDGE_AUTOMATION_POLICY_VERSION
    });
    return rows.map(({ tokenSlot, ...row }) => ({
      ...row,
      leaseToken: tokens[tokenSlot]
    }));
  }

  async getPackage(input: {
    id: string;
    phase: ReviewPhase;
    leaseToken: string;
  }) {
    const result = z
      .object({
        id: uuid,
        phase: knowledgeAutomationReviewPhaseSchema,
        leaseToken: z.string().min(20).max(1_000)
      })
      .safeParse(input);
    if (!result.success) {
      throw new ApiError(
        422,
        "KNOWLEDGE_REVIEW_RESULT_INVALID",
        "Knowledge review result does not match the required structured report.",
        result.error.issues
      );
    }
    const parsed = result.data;
    const row = await this.repository.loadPackage({
      id: parsed.id,
      phase: parsed.phase,
      leaseTokenHash: sha256(parsed.leaseToken)
    });
    if (!row) {
      throw new ApiError(
        409,
        "KNOWLEDGE_REVIEW_LEASE_INVALID",
        "Review lease is expired, stale, or invalid."
      );
    }
    const original = row.original
      ? {
          originalFilename: row.original.originalFilename,
          mimeType: row.original.mimeType,
          sizeBytes: row.original.sizeBytes,
          sha256: row.original.sha256,
          downloadUrl: await this.storage.createPrivateDownloadUrl(
            row.original.objectKey,
            300
          )
        }
      : null;
    return { ...row, original };
  }

  async submitResult(input: {
    id: string;
    phase: ReviewPhase;
    leaseToken: string;
    inputVersionId: string;
    inputContentHash: string;
    report: AutomationReviewReport;
    revisedContent?: string;
  }): Promise<AutomationReviewOutcome> {
    const result = z
      .object({
        id: uuid,
        phase: knowledgeAutomationReviewPhaseSchema,
        leaseToken: z.string().min(20).max(1_000),
        inputVersionId: uuid,
        inputContentHash: knowledgeSha256Schema,
        report: automationReviewReportSchema,
        revisedContent: z.string().trim().min(1).max(5_000_000).optional()
      })
      .strict()
      .safeParse(input);
    if (!result.success) {
      throw new ApiError(
        422,
        "KNOWLEDGE_REVIEW_RESULT_INVALID",
        "Knowledge review result does not match the required structured report.",
        result.error.issues
      );
    }
    const parsed = result.data;
    if (parsed.phase === "verify" && parsed.revisedContent !== undefined) {
      throw new ApiError(
        422,
        "KNOWLEDGE_REVIEW_REVISION_NOT_ALLOWED",
        "Verification runs cannot revise content."
      );
    }
    return this.repository.complete({
      ...parsed,
      leaseTokenHash: sha256(parsed.leaseToken)
    });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
