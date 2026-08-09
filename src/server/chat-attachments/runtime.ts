import { getObjectStorage } from "@/server/providers";

import { chatAttachmentRepository } from "./repository";
import { ChatAttachmentService } from "./service";

export const chatAttachmentService = new ChatAttachmentService(
  chatAttachmentRepository,
  getObjectStorage()
);
