import { asUserActor, auditContext, authenticate } from "./auth";
import {
  jsonData,
  notFound,
  parseJson,
  parseSearchParams,
  withApiErrors
} from "./errors";
import {
  conversationSearchSchema,
  createConversationSchema,
  pageSchema,
  renameConversationSchema,
  uuidSchema
} from "./schemas";
import { apiStore } from "./store";
import type { ApiStore } from "./types";

function pageInput(input: ReturnType<typeof pageSchema.parse>) {
  return {
    page: input.page,
    pageSize: input.pageSize,
    query: input.q,
    status: input.status
  };
}

export const handleListConversations = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const user = await authenticate(request);
    const query = parseSearchParams(request, pageSchema);
    const result = await store.listConversations(user.id, pageInput(query));
    return jsonData(result);
  }
);

export const handleSearchConversations = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const user = await authenticate(request);
    const query = parseSearchParams(request, conversationSearchSchema);
    const result = await store.listConversations(user.id, pageInput(query));
    return jsonData(result);
  }
);

export const handleCreateConversation = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const user = await authenticate(request);
    const actor = asUserActor(user);
    const input = await parseJson(request, createConversationSchema);
    const conversation = await store.createConversation(
      user.id,
      input.title,
      auditContext(request, actor)
    );
    return jsonData(conversation, { status: 201 });
  }
);

export const handleGetConversation = withApiErrors(
  async (
    request: Request,
    conversationId: string,
    store: ApiStore = apiStore
  ) => {
    const user = await authenticate(request);
    const id = uuidSchema.parse(conversationId);
    const conversation = await store.getConversation(user.id, id);

    if (!conversation) {
      throw notFound("会话");
    }

    return jsonData(conversation);
  }
);

export const handleRenameConversation = withApiErrors(
  async (
    request: Request,
    conversationId: string,
    store: ApiStore = apiStore
  ) => {
    const user = await authenticate(request);
    const actor = asUserActor(user);
    const id = uuidSchema.parse(conversationId);
    const input = await parseJson(request, renameConversationSchema);
    const conversation = await store.renameConversation(
      user.id,
      id,
      input.title,
      auditContext(request, actor)
    );

    if (!conversation) {
      throw notFound("会话");
    }

    return jsonData(conversation);
  }
);

export const handleDeleteConversation = withApiErrors(
  async (
    request: Request,
    conversationId: string,
    store: ApiStore = apiStore
  ) => {
    const user = await authenticate(request);
    const actor = asUserActor(user);
    const id = uuidSchema.parse(conversationId);
    const deleted = await store.deleteConversation(
      user.id,
      id,
      auditContext(request, actor)
    );

    if (!deleted) {
      throw notFound("会话");
    }

    return new Response(null, { status: 204 });
  }
);
