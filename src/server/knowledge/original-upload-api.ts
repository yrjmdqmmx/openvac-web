import { requireCapability } from "@/server/api/auth";
import { jsonData, parseJson, withApiErrors } from "@/server/api/errors";
import {
  knowledgeOriginalUploadSchema,
  uuidSchema
} from "@/server/api/schemas";
import { apiStore } from "@/server/api/store";
import type { ApiStore } from "@/server/api/types";
import { getObjectStorage } from "@/server/providers";

import { knowledgeOriginalUploadRepository } from "./original-upload-repository";
import { KnowledgeOriginalUploadService } from "./original-upload-service";

const defaultService = new KnowledgeOriginalUploadService(
  knowledgeOriginalUploadRepository,
  getObjectStorage()
);

type InitiateService = Pick<KnowledgeOriginalUploadService, "initiate">;
type CompleteService = Pick<KnowledgeOriginalUploadService, "complete">;

export const handleInitiateKnowledgeOriginalUpload = withApiErrors(
  async (
    request: Request,
    store: ApiStore = apiStore,
    service: InitiateService = defaultService
  ) => {
    const actor = await requireCapability(request, store, "knowledge:draft");
    const input = await parseJson(request, knowledgeOriginalUploadSchema);
    return jsonData(
      await service.initiate({ ...input, uploadedBy: actor.id }),
      { status: 201 }
    );
  }
);

export const handleCompleteKnowledgeOriginalUpload = withApiErrors(
  async (
    request: Request,
    versionId: string,
    store: ApiStore = apiStore,
    service: CompleteService = defaultService
  ) => {
    const actor = await requireCapability(request, store, "knowledge:draft");
    const id = uuidSchema.parse(versionId);
    return jsonData(
      await service.complete({ versionId: id, uploadedBy: actor.id })
    );
  }
);
