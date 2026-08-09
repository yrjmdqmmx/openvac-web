import { z } from "zod";

import { authenticate } from "@/server/api/auth";
import {
  jsonData,
  parseSearchParams,
  withApiErrors
} from "@/server/api/errors";
import { uuidSchema } from "@/server/api/schemas";
import type { ArtifactFormat } from "@/types/chat-v3";

import { chatArtifactStorageService as defaultService } from "./artifact-runtime";
import type {
  ChatArtifactStorageService,
  ChatArtifactView
} from "./artifact-storage";

const artifactFormatQuerySchema = z
  .object({ format: z.enum(["md", "docx", "pdf", "csv"]) })
  .strict();

type StatusService = Pick<ChatArtifactStorageService, "status">;
type AccessService = Pick<ChatArtifactStorageService, "createAccessUrl">;

export const handleGetChatArtifactStatus = withApiErrors(
  async (
    request: Request,
    artifactId: string,
    service: StatusService = defaultService
  ): Promise<Response> => {
    const user = await authenticate(request);
    const id = uuidSchema.parse(artifactId);
    const artifact = await service.status({
      artifactId: id,
      userId: user.id
    });
    const response = jsonData(serializeArtifact(artifact));
    response.headers.set("cache-control", "no-store, private");
    return response;
  }
);

function accessHandler() {
  return withApiErrors(
    async (
      request: Request,
      artifactId: string,
      service: AccessService = defaultService
    ): Promise<Response> => {
      const user = await authenticate(request);
      const id = uuidSchema.parse(artifactId);
      const { format } = parseSearchParams(request, artifactFormatQuerySchema);
      const location = await service.createAccessUrl({
        artifactId: id,
        userId: user.id,
        format: format as ArtifactFormat
      });
      return new Response(null, {
        status: 302,
        headers: {
          location,
          "cache-control": "no-store, private",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff"
        }
      });
    }
  );
}

export const handlePreviewChatArtifact = accessHandler();
export const handleDownloadChatArtifact = accessHandler();

function serializeArtifact(artifact: ChatArtifactView): ChatArtifactView {
  const {
    id,
    conversationId,
    sourceTurnId,
    kind,
    title,
    formats,
    status,
    createdAt,
    updatedAt,
    readyAt
  } = artifact;
  return {
    id,
    conversationId,
    sourceTurnId,
    kind,
    title,
    formats,
    status,
    createdAt,
    updatedAt,
    readyAt
  };
}
