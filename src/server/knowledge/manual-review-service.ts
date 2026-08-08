import { z } from "zod";

import { ApiError } from "@/server/api/errors";
import type { AdminRole } from "@/server/api/types";

import { knowledgeSha256Schema } from "./automation-review-schema";

const targetSchema = z
  .object({
    documentId: z.uuid(),
    expectedVersionId: z.uuid(),
    expectedContentHash: knowledgeSha256Schema,
    actorId: z.string().trim().min(1).max(128),
    actorRole: z.enum(["owner", "admin", "knowledge_editor"]),
    requestId: z.string().trim().min(1).max(200)
  })
  .strict();

const resolutionSchema = z.discriminatedUnion("action", [
  targetSchema.extend({
    action: z.literal("adopt_revision_and_retry"),
    note: z.string().trim().min(1).max(2_000).optional()
  }),
  targetSchema.extend({
    action: z.literal("manual_edit_and_retry"),
    revisedContent: z.string().trim().min(1).max(5_000_000),
    note: z.string().trim().min(1).max(2_000).optional()
  }),
  targetSchema.extend({
    action: z.literal("manual_approve_with_note"),
    note: z.string().trim().min(1).max(2_000)
  }),
  targetSchema.extend({
    action: z.literal("archive"),
    note: z.string().trim().min(1).max(2_000).optional()
  })
]);

export type KnowledgeManualReviewTarget = {
  documentId: string;
  expectedVersionId: string;
  expectedContentHash: string;
  actorId: string;
  actorRole: Extract<AdminRole, "owner" | "admin" | "knowledge_editor">;
  requestId: string;
};

export type KnowledgeManualResolutionInput =
  | (KnowledgeManualReviewTarget & {
      action: "adopt_revision_and_retry";
      note?: string;
    })
  | (KnowledgeManualReviewTarget & {
      action: "manual_edit_and_retry";
      revisedContent: string;
      note?: string;
    })
  | (KnowledgeManualReviewTarget & {
      action: "manual_approve_with_note";
      note: string;
    })
  | (KnowledgeManualReviewTarget & { action: "archive"; note?: string });

export type KnowledgeManualReviewOutcome = {
  action: "retry" | KnowledgeManualResolutionInput["action"];
  documentId: string;
  versionId: string;
  contentHash: string;
  status: "queued" | "approved" | "archived";
  taskId?: string;
};

export interface KnowledgeManualReviewRepository {
  retry(
    input: KnowledgeManualReviewTarget
  ): Promise<KnowledgeManualReviewOutcome>;
  resolve(
    input: KnowledgeManualResolutionInput
  ): Promise<KnowledgeManualReviewOutcome>;
}

export class KnowledgeManualReviewService {
  constructor(private readonly repository: KnowledgeManualReviewRepository) {}

  async retry(input: KnowledgeManualReviewTarget) {
    return this.repository.retry(parse(targetSchema, input));
  }

  async resolve(input: KnowledgeManualResolutionInput) {
    return this.repository.resolve(parse(resolutionSchema, input));
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(
      422,
      "KNOWLEDGE_MANUAL_RESOLUTION_INVALID",
      "人工处理参数不符合要求。",
      result.error.issues
    );
  }
  return result.data;
}
