import { auditContext, requireCapability } from "./auth";
import {
  ApiError,
  jsonData,
  notFound,
  parseJson,
  parseSearchParams,
  withApiErrors
} from "./errors";
import {
  adminRoleMutationSchema,
  budgetsSchema,
  consultationStatusSchema,
  feedbackStatusSchema,
  knowledgeDraftSchema,
  knowledgeDraftUpdateSchema,
  knowledgeReviewSchema,
  metricsSchema,
  pageSchema,
  promptSchema,
  promptUpdateSchema,
  rollbackKnowledgeSchema,
  settingsSchema,
  sourceSchema,
  sourceUpdateSchema,
  userBanSchema,
  userQuotaSchema,
  uuidSchema
} from "./schemas";
import { apiStore } from "./store";
import type { Actor, ApiStore } from "./types";

function pageInput(input: ReturnType<typeof pageSchema.parse>) {
  return {
    page: input.page,
    pageSize: input.pageSize,
    query: input.q,
    status: input.status
  };
}

function budgetTableItems(
  budgets: Awaited<ReturnType<ApiStore["getBudgets"]>>
) {
  return budgets.map((budget) => ({
    key: budget.model,
    value: {
      dailyLimitCents: budget.dailyLimitCents,
      monthlyLimitCents: budget.monthlyLimitCents,
      enabled: budget.enabled
    },
    updatedBy: null,
    updatedAt: null
  }));
}

async function assertCanManageUser(
  actor: Actor,
  targetUserId: string,
  store: ApiStore,
  destructive: boolean
): Promise<void> {
  if (destructive && actor.id === targetUserId) {
    throw new ApiError(
      409,
      "SELF_MANAGEMENT_FORBIDDEN",
      "不能对当前登录账号执行该操作。"
    );
  }

  const targetRole = await store.getAdminRole(targetUserId);
  if (targetRole === "owner" && actor.role !== "owner") {
    throw new ApiError(
      403,
      "OWNER_PROTECTED",
      "只有 owner 可以管理 owner 账号。"
    );
  }

  if (targetRole === "admin" && actor.role !== "owner") {
    throw new ApiError(
      403,
      "ADMIN_PROTECTED",
      "只有 owner 可以管理 admin 账号。"
    );
  }
}

export const handleListAdminConversations = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "conversations:read");
    const input = parseSearchParams(request, pageSchema);
    return jsonData(await store.listAdminConversations(pageInput(input)));
  }
);

export const handleListAdmins = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "admins:read");
    const input = parseSearchParams(request, pageSchema);
    return jsonData(await store.listAdmins(pageInput(input)));
  }
);

export const handleGrantAdminRole = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "admins:write");
    const input = await parseJson(request, adminRoleMutationSchema);
    const created = await store.grantAdminRole(
      input.userId,
      input.role,
      auditContext(request, actor)
    );

    if (!created) throw notFound("用户");
    return jsonData(created, { status: 201 });
  }
);

export const handleRevokeAdminRole = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "admins:write");
    const input = await parseJson(request, adminRoleMutationSchema);
    const removed = await store.revokeAdminRole(
      input.userId,
      input.role,
      auditContext(request, actor)
    );

    if (!removed) throw notFound("管理员角色");
    return jsonData(removed);
  }
);

export const handleListUsers = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "users:read");
    const input = parseSearchParams(request, pageSchema);
    return jsonData(await store.listUsers(pageInput(input)));
  }
);

export const handleSetUserBan = withApiErrors(
  async (request: Request, userId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "users:write");
    const input = await parseJson(request, userBanSchema);
    await assertCanManageUser(actor, userId, store, input.banned);
    const updated = await store.setUserBan(
      userId,
      {
        banned: input.banned,
        reason: input.reason,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined
      },
      auditContext(request, actor)
    );

    if (!updated) throw notFound("用户");
    return jsonData(updated);
  }
);

export const handleSetUserQuota = withApiErrors(
  async (request: Request, userId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "users:write");
    await assertCanManageUser(actor, userId, store, false);
    const input = await parseJson(request, userQuotaSchema);
    const updated = await store.setUserQuotaBonus(
      userId,
      input,
      auditContext(request, actor)
    );

    if (!updated) throw notFound("用户");
    return jsonData(updated);
  }
);

export const handleListFeedback = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "feedback:read");
    const input = parseSearchParams(request, pageSchema);
    return jsonData(await store.listFeedback(pageInput(input)));
  }
);

export const handleSetFeedbackStatus = withApiErrors(
  async (request: Request, feedbackId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "feedback:write");
    const id = uuidSchema.parse(feedbackId);
    const input = await parseJson(request, feedbackStatusSchema);
    const updated = await store.setFeedbackStatus(
      id,
      input,
      auditContext(request, actor)
    );

    if (!updated) throw notFound("反馈");
    return jsonData(updated);
  }
);

export const handleListAdminConsultations = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "consultations:read");
    const input = parseSearchParams(request, pageSchema);
    return jsonData(await store.listAdminConsultations(pageInput(input)));
  }
);

export const handleSetConsultationStatus = withApiErrors(
  async (
    request: Request,
    consultationId: string,
    store: ApiStore = apiStore
  ) => {
    const actor = await requireCapability(
      request,
      store,
      "consultations:write"
    );
    const id = uuidSchema.parse(consultationId);
    const input = await parseJson(request, consultationStatusSchema);
    if (input.assignedTo && !(await store.getAdminRole(input.assignedTo))) {
      throw new ApiError(
        422,
        "INVALID_ASSIGNEE",
        "咨询单只能分配给有效的管理员账号。"
      );
    }
    const updated = await store.setConsultationStatus(
      id,
      input,
      auditContext(request, actor)
    );

    if (!updated) throw notFound("咨询单");
    return jsonData(updated);
  }
);

export const handleListKnowledge = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "knowledge:read");
    const input = parseSearchParams(request, pageSchema);
    return jsonData(await store.listKnowledgeDocuments(pageInput(input)));
  }
);

export const handleGetKnowledgeDocument = withApiErrors(
  async (request: Request, documentId: string, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "knowledge:read");
    const id = uuidSchema.parse(documentId);
    const document = await store.getKnowledgeDocument(id);
    if (!document) throw notFound("知识文档");
    return jsonData(document);
  }
);

export const handleCreateKnowledgeDraft = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "knowledge:write");
    const input = await parseJson(request, knowledgeDraftSchema);
    const created = await store.createKnowledgeDraft(
      input,
      auditContext(request, actor)
    );
    return jsonData(created, { status: 201 });
  }
);

export const handleUpdateKnowledgeDraft = withApiErrors(
  async (request: Request, documentId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "knowledge:write");
    const id = uuidSchema.parse(documentId);
    const input = await parseJson(request, knowledgeDraftUpdateSchema);
    const updated = await store.updateKnowledgeDraft(
      id,
      input,
      auditContext(request, actor)
    );

    if (!updated) throw notFound("知识草稿");
    return jsonData(updated);
  }
);

export const handleReviewKnowledgeDocument = withApiErrors(
  async (request: Request, documentId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "knowledge:write");
    const id = uuidSchema.parse(documentId);
    const input = await parseJson(request, knowledgeReviewSchema);
    const reviewed = await store.reviewKnowledgeDocument(
      id,
      input,
      auditContext(request, actor)
    );
    if (!reviewed) throw notFound("知识文档");
    return jsonData(reviewed);
  }
);

export const handlePublishKnowledge = withApiErrors(
  async (request: Request, documentId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "knowledge:write");
    const id = uuidSchema.parse(documentId);
    const published = await store.publishKnowledgeDraft(
      id,
      auditContext(request, actor)
    );

    if (!published) throw notFound("可发布的知识草稿");
    return jsonData(published);
  }
);

export const handleRollbackKnowledge = withApiErrors(
  async (request: Request, documentId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "knowledge:write");
    const id = uuidSchema.parse(documentId);
    const input = await parseJson(request, rollbackKnowledgeSchema);
    const updated = await store.rollbackKnowledgeDocument(
      id,
      input.versionId,
      auditContext(request, actor)
    );

    if (!updated) throw notFound("知识版本");
    return jsonData(updated);
  }
);

export const handleListSources = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "sources:read");
    const input = parseSearchParams(request, pageSchema);
    return jsonData(await store.listSources(pageInput(input)));
  }
);

export const handleCreateSource = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "sources:write");
    const input = await parseJson(request, sourceSchema);
    const created = await store.createSource(
      input,
      auditContext(request, actor)
    );
    return jsonData(created, { status: 201 });
  }
);

export const handleUpdateSource = withApiErrors(
  async (request: Request, sourceId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "sources:write");
    const id = uuidSchema.parse(sourceId);
    const input = await parseJson(request, sourceUpdateSchema);
    const updated = await store.updateSource(
      id,
      input,
      auditContext(request, actor)
    );

    if (!updated) throw notFound("来源");
    return jsonData(updated);
  }
);

export const handleDeleteSource = withApiErrors(
  async (request: Request, sourceId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "sources:write");
    const id = uuidSchema.parse(sourceId);
    const deleted = await store.deleteSource(id, auditContext(request, actor));
    if (!deleted) throw notFound("来源");
    return new Response(null, { status: 204 });
  }
);

export const handleListPrompts = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "prompts:read");
    const input = parseSearchParams(request, pageSchema);
    return jsonData(await store.listPrompts(pageInput(input)));
  }
);

export const handleCreatePrompt = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "prompts:write");
    const input = await parseJson(request, promptSchema);
    const created = await store.createPromptVersion(
      input,
      auditContext(request, actor)
    );
    return jsonData(created, { status: 201 });
  }
);

export const handleUpdatePrompt = withApiErrors(
  async (request: Request, promptId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "prompts:write");
    const id = uuidSchema.parse(promptId);
    const input = await parseJson(request, promptUpdateSchema);
    const updated = await store.updatePromptVersion(
      id,
      input,
      auditContext(request, actor)
    );

    if (!updated) throw notFound("提示词版本");
    return jsonData(updated);
  }
);

export const handleGetBudgets = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "budgets:read");
    const budgets = await store.getBudgets();
    return jsonData({ budgets, items: budgetTableItems(budgets) });
  }
);

export const handleUpdateBudgets = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "budgets:write");
    const input = await parseJson(request, budgetsSchema);
    const budgets = await store.updateBudgets(
      input.budgets,
      auditContext(request, actor)
    );
    return jsonData({ budgets, items: budgetTableItems(budgets) });
  }
);

export const handleGetSettings = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "settings:read");
    return jsonData({ settings: await store.getSettings() });
  }
);

export const handleUpdateSettings = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "settings:write");
    const input = await parseJson(request, settingsSchema);
    if (Object.hasOwn(input.settings, "model_budgets")) {
      throw new ApiError(
        422,
        "RESERVED_SETTING_KEY",
        "模型预算必须通过预算接口修改。"
      );
    }
    const settings = await store.updateSettings(
      input.settings,
      auditContext(request, actor)
    );
    return jsonData({ settings });
  }
);

export const handleGetMetrics = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "metrics:read");
    const input = parseSearchParams(request, metricsSchema);
    const now = new Date();
    const to = input.to ? new Date(`${input.to}T23:59:59.999Z`) : now;
    const from = input.from
      ? new Date(`${input.from}T00:00:00.000Z`)
      : new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);

    if (from > to) {
      throw new ApiError(
        422,
        "INVALID_DATE_RANGE",
        "开始日期不能晚于结束日期。"
      );
    }
    if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) {
      throw new ApiError(
        422,
        "DATE_RANGE_TOO_LARGE",
        "指标查询区间最多为 366 天。"
      );
    }

    return jsonData(await store.getMetrics({ from, to }));
  }
);

export const handleListAuditLogs = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "audit:read");
    const input = parseSearchParams(request, pageSchema);
    return jsonData(await store.listAuditLogs(pageInput(input), actor.role));
  }
);
