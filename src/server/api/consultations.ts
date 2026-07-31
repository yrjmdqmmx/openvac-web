import { asUserActor, auditContext, authenticate } from "./auth";
import {
  jsonData,
  notFound,
  parseJson,
  parseSearchParams,
  withApiErrors
} from "./errors";
import { consultationSchema, pageSchema } from "./schemas";
import { apiStore } from "./store";
import type { ApiStore } from "./types";

export const handleListConsultations = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const user = await authenticate(request);
    const input = parseSearchParams(request, pageSchema);
    const result = await store.listConsultations(user.id, {
      page: input.page,
      pageSize: input.pageSize,
      query: input.q,
      status: input.status
    });
    return jsonData(result);
  }
);

export const handleCreateConsultation = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const user = await authenticate(request);
    const actor = asUserActor(user);
    const parsed = await parseJson(request, consultationSchema);
    const input = {
      conversationId: parsed.conversationId,
      contactName: parsed.contactName,
      companyName: parsed.companyName,
      contactMethod: parsed.contactMethod,
      contactValue: parsed.contactValue,
      problem: parsed.problem,
      conversationSummary: parsed.conversationSummary
    };
    const consultation = await store.createConsultation(
      user.id,
      input,
      auditContext(request, actor)
    );

    if (!consultation) {
      throw notFound("关联会话");
    }

    return jsonData(consultation, { status: 201 });
  }
);
