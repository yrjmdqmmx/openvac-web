import { requireCapability } from "@/server/api/auth";
import {
  ApiError,
  jsonData,
  parseJson,
  withApiErrors
} from "@/server/api/errors";
import {
  knowledgeSectionDecisionSchema,
  knowledgeSectionReviewCompleteSchema,
  uuidSchema
} from "@/server/api/schemas";
import { apiStore } from "@/server/api/store";
import type { ApiStore } from "@/server/api/types";

import { knowledgeSectionReviewRepository } from "./review-sections-repository";
import { KnowledgeSectionReviewService } from "./review-sections-service";

const defaultService = new KnowledgeSectionReviewService(
  knowledgeSectionReviewRepository
);

type WorkspaceService = Pick<KnowledgeSectionReviewService, "getWorkspace">;
type DecisionService = Pick<KnowledgeSectionReviewService, "decide">;
type CompleteService = Pick<KnowledgeSectionReviewService, "complete">;

export const handleGetKnowledgeSectionReview = withApiErrors(
  async (
    request: Request,
    documentId: string,
    store: ApiStore = apiStore,
    service: WorkspaceService = defaultService
  ) => {
    await requireCapability(request, store, "knowledge:review");
    const id = uuidSchema.parse(documentId);
    return jsonData(await service.getWorkspace(id));
  }
);

export const handleKnowledgeSectionDecision = withApiErrors(
  async (
    request: Request,
    ids: { documentId: string; versionId: string; sectionId: string },
    store: ApiStore = apiStore,
    service: DecisionService = defaultService
  ) => {
    const actor = await requireCapability(request, store, "knowledge:review");
    const documentId = uuidSchema.parse(ids.documentId);
    const versionId = uuidSchema.parse(ids.versionId);
    const sectionId = uuidSchema.parse(ids.sectionId);
    const input = await parseJson(request, knowledgeSectionDecisionSchema);
    return jsonData(
      await service.decide({
        documentId,
        versionId,
        sectionId,
        expectedSectionHash: input.expectedSectionHash,
        expectedRevision: input.expectedRevision,
        decision: input.decision,
        ...(input.note ? { note: input.note } : {}),
        reviewerId: actor.id
      })
    );
  }
);

export const handleCompleteKnowledgeSectionReview = withApiErrors(
  async (
    request: Request,
    ids: { documentId: string; versionId: string },
    store: ApiStore = apiStore,
    service: CompleteService = defaultService
  ) => {
    const actor = await requireCapability(request, store, "knowledge:review");
    const documentId = uuidSchema.parse(ids.documentId);
    const versionId = uuidSchema.parse(ids.versionId);
    const input = await parseJson(
      request,
      knowledgeSectionReviewCompleteSchema
    );
    if (input.versionId !== versionId) {
      throw new ApiError(
        409,
        "KNOWLEDGE_VERSION_CHANGED",
        "请求中的知识版本与当前审核路径不一致。"
      );
    }
    return jsonData(
      await service.complete({
        documentId,
        versionId,
        expectedContentHash: input.expectedContentHash,
        reviewerId: actor.id
      })
    );
  }
);
