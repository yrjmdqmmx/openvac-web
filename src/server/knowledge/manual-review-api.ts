import { z } from "zod";

import { requireCapability, auditContext } from "@/server/api/auth";
import { jsonData, parseJson, withApiErrors } from "@/server/api/errors";
import { apiStore } from "@/server/api/store";
import type { ApiStore } from "@/server/api/types";

import { knowledgeSha256Schema } from "./automation-review-schema";
import { knowledgeManualReviewRepository } from "./manual-review-repository";
import { KnowledgeManualReviewService } from "./manual-review-service";

const uuid = z.uuid();
const targetBodySchema = z
  .object({
    expectedVersionId: uuid,
    expectedContentHash: knowledgeSha256Schema
  })
  .strict();
const resolutionBodySchema = z.discriminatedUnion("action", [
  targetBodySchema.extend({
    action: z.literal("adopt_revision_and_retry"),
    note: z.string().trim().min(1).max(2_000).optional()
  }),
  targetBodySchema.extend({
    action: z.literal("manual_edit_and_retry"),
    revisedContent: z.string().trim().min(1).max(5_000_000),
    note: z.string().trim().min(1).max(2_000).optional()
  }),
  targetBodySchema.extend({
    action: z.literal("manual_approve_with_note"),
    note: z.string().trim().min(1).max(2_000)
  }),
  targetBodySchema.extend({
    action: z.literal("archive"),
    note: z.string().trim().min(1).max(2_000).optional()
  })
]);

const defaultService = new KnowledgeManualReviewService(
  knowledgeManualReviewRepository
);
type Service = Pick<KnowledgeManualReviewService, "retry" | "resolve">;

export const handleRetryKnowledgeAutomation = withApiErrors(
  async (
    request: Request,
    documentId: string,
    store: ApiStore = apiStore,
    service: Service = defaultService
  ) => {
    const actor = await requireCapability(request, store, "knowledge:draft");
    const id = uuid.parse(documentId);
    const body = await parseJson(request, targetBodySchema);
    const audit = auditContext(request, actor);
    return jsonData(
      await service.retry({
        documentId: id,
        ...body,
        actorId: actor.id,
        actorRole: actor.role as "owner" | "admin" | "knowledge_editor",
        requestId: audit.requestId
      })
    );
  }
);

export const handleKnowledgeManualResolution = withApiErrors(
  async (
    request: Request,
    documentId: string,
    store: ApiStore = apiStore,
    service: Service = defaultService
  ) => {
    const actor = await requireCapability(request, store, "knowledge:draft");
    const id = uuid.parse(documentId);
    const body = await parseJson(request, resolutionBodySchema);
    const audit = auditContext(request, actor);
    return jsonData(
      await service.resolve({
        documentId: id,
        ...body,
        actorId: actor.id,
        actorRole: actor.role as "owner" | "admin" | "knowledge_editor",
        requestId: audit.requestId
      })
    );
  }
);
