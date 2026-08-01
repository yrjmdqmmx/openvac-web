import { sendProblemReportNotification } from "@/server/problem-reports/notification";

import { asUserActor, auditContext, authenticate } from "./auth";
import { notFound, parseJson, withApiErrors } from "./errors";
import { problemReportSchema } from "./schemas";
import { apiStore } from "./store";
import type { ApiStore } from "./types";

export const handleCreateProblemReport = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const user = await authenticate(request);
    const actor = asUserActor(user);
    const parsed = await parseJson(request, problemReportSchema);
    const report = await store.createProblemReport(
      user.id,
      {
        conversationId: parsed.conversationId,
        messageId: parsed.messageId,
        category: parsed.category,
        description: parsed.description,
        includeContext: parsed.includeContext,
        contactType: parsed.contactType,
        contactValue: parsed.contactValue,
        consentToContact: parsed.consentToContact
      },
      auditContext(request, actor)
    );

    if (!report) {
      throw notFound("关联会话或消息");
    }

    try {
      await sendProblemReportNotification({
        id: report.id,
        category: parsed.category,
        createdAt: report.createdAt
      });
    } catch {
      // Notification is best-effort. The persisted report and its audit row
      // remain the source of truth, and mail failure must not affect the user.
    }

    return new Response(
      JSON.stringify({
        reportId: report.id,
        receivedAt: report.createdAt
      }),
      {
        status: 201,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        }
      }
    );
  }
);
