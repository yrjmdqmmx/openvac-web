import { z } from "zod";

import { authenticate } from "@/server/api/auth";
import { jsonData, parseJson, withApiErrors } from "@/server/api/errors";
import { uuidSchema } from "@/server/api/schemas";

import { chatAttachmentService as defaultService } from "./runtime";
import { ChatAttachmentService } from "./service";
import type { ChatAttachmentView } from "./service";

const initiateAttachmentSchema = z.object({
  conversationId: z.string().uuid(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  sha256: z.string()
});

type InitiateService = Pick<ChatAttachmentService, "initiate">;
type CompleteService = Pick<ChatAttachmentService, "complete">;
type StatusService = Pick<ChatAttachmentService, "status">;
type AccessService = Pick<ChatAttachmentService, "createAccessUrl">;
type DeleteService = Pick<ChatAttachmentService, "cancel">;

export const handleInitiateChatAttachment = withApiErrors(
  async (
    request: Request,
    service: InitiateService = defaultService
  ): Promise<Response> => {
    const user = await authenticate(request);
    const input = await parseJson(request, initiateAttachmentSchema);
    const result = await service.initiate({ ...input, userId: user.id });
    return jsonData(
      {
        attachment: serializeAttachment(result),
        upload: {
          method: result.upload.method,
          url: result.upload.url,
          requiredHeaders: result.upload.requiredHeaders,
          expiresAt: result.upload.expiresAt
        }
      },
      { status: 201 }
    );
  }
);

export const handleCompleteChatAttachment = withApiErrors(
  async (
    request: Request,
    attachmentId: string,
    service: CompleteService = defaultService
  ): Promise<Response> => {
    const user = await authenticate(request);
    const id = uuidSchema.parse(attachmentId);
    return jsonData({
      attachment: serializeAttachment(
        await service.complete({ attachmentId: id, userId: user.id })
      )
    });
  }
);

export const handleGetChatAttachmentStatus = withApiErrors(
  async (
    request: Request,
    attachmentId: string,
    service: StatusService = defaultService
  ): Promise<Response> => {
    const user = await authenticate(request);
    const id = uuidSchema.parse(attachmentId);
    return jsonData({
      attachment: serializeAttachment(
        await service.status({ attachmentId: id, userId: user.id })
      )
    });
  }
);

export const handleDeleteChatAttachment = withApiErrors(
  async (
    request: Request,
    attachmentId: string,
    service: DeleteService = defaultService
  ): Promise<Response> => {
    const user = await authenticate(request);
    const id = uuidSchema.parse(attachmentId);
    await service.cancel({ attachmentId: id, userId: user.id });
    return new Response(null, { status: 204 });
  }
);

function accessHandler() {
  return withApiErrors(
    async (
      request: Request,
      attachmentId: string,
      service: AccessService = defaultService
    ): Promise<Response> => {
      const user = await authenticate(request);
      const id = uuidSchema.parse(attachmentId);
      const location = await service.createAccessUrl({
        attachmentId: id,
        userId: user.id
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

export const handlePreviewChatAttachment = accessHandler();
export const handleDownloadChatAttachment = accessHandler();

function serializeAttachment(
  item: ChatAttachmentView
): ChatAttachmentView & { type: "attachment"; attachmentId: string } {
  const {
    id,
    conversationId,
    messageId,
    kind,
    filename,
    mimeType,
    sizeBytes,
    status,
    parseStatus,
    failureCode,
    failureMessage,
    createdAt,
    updatedAt,
    readyAt
  } = item;
  return {
    type: "attachment",
    attachmentId: id,
    id,
    conversationId,
    messageId,
    kind,
    filename,
    mimeType,
    sizeBytes,
    status,
    parseStatus,
    failureCode,
    failureMessage,
    createdAt,
    updatedAt,
    readyAt
  };
}
