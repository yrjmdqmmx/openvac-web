import { asUserActor, auditContext, authenticate } from "./auth";
import { jsonData, notFound, parseJson, withApiErrors } from "./errors";
import {
  messageFeedbackSchema,
  messageReportSchema,
  uuidSchema
} from "./schemas";
import { apiStore } from "./store";
import type { ApiStore } from "./types";

export const handleMessageFeedback = withApiErrors(
  async (request: Request, messageId: string, store: ApiStore = apiStore) => {
    const user = await authenticate(request);
    const actor = asUserActor(user);
    const id = uuidSchema.parse(messageId);
    const input = await parseJson(request, messageFeedbackSchema);
    const result = await store.saveMessageFeedback(
      user.id,
      id,
      { kind: "feedback", ...input },
      auditContext(request, actor)
    );

    if (!result) {
      throw notFound("消息");
    }

    return jsonData(result);
  }
);

export const handleMessageReport = withApiErrors(
  async (request: Request, messageId: string, store: ApiStore = apiStore) => {
    const user = await authenticate(request);
    const actor = asUserActor(user);
    const id = uuidSchema.parse(messageId);
    const input = await parseJson(request, messageReportSchema);
    const result = await store.reportMessage(
      user.id,
      id,
      { kind: "report", ...input },
      auditContext(request, actor)
    );

    if (!result) {
      throw notFound("消息");
    }

    return jsonData(result, { status: 201 });
  }
);
