import { createHash } from "node:crypto";

import {
  asUserActor,
  authenticate,
  auditContext,
  buildAdminContext,
  requireCapability
} from "./auth";
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
  adminRoleReplaceSchema,
  adminInvitationAcceptSchema,
  adminInvitationCreateSchema,
  adminInvitationDeleteSchema,
  adminTaskStateUpdateSchema,
  budgetsSchema,
  feedbackStatusSchema,
  knowledgeDraftSchema,
  knowledgeDraftUpdateSchema,
  metricsSchema,
  pageSchema,
  problemReportStatusSchema,
  promptSchema,
  promptUpdateSchema,
  rollbackKnowledgeSchema,
  settingsSchema,
  sourceSchema,
  sourceUpdateSchema,
  userBanSchema,
  userQuotaSchema,
  userSessionRevokeSchema,
  uuidSchema
} from "./schemas";
import { apiStore } from "./store";
import type { Actor, ApiStore } from "./types";
import { knowledgeCandidateSchema } from "@/server/knowledge/candidate-schema";

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

function hashAdminInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function parseAdminInvitationToken(request: Request): Promise<string> {
  const url = new URL(request.url);
  const searchToken = url.searchParams.get("token");
  if (searchToken) {
    return adminInvitationAcceptSchema.parse({ token: searchToken }).token;
  }

  const input = await parseJson(request, adminInvitationAcceptSchema);
  return input.token;
}

export const handleListAdminConversations = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "conversations:read");
    const input = parseSearchParams(request, pageSchema);
    return jsonData(await store.listAdminConversations(pageInput(input)));
  }
);

export const handleGetAdminConversation = withApiErrors(
  async (
    request: Request,
    conversationId: string,
    store: ApiStore = apiStore
  ) => {
    await requireCapability(request, store, "conversations:read");
    const id = uuidSchema.parse(conversationId);
    const conversation = await store.getAdminConversation(id);
    if (!conversation) throw notFound("对话");
    return jsonData(conversation);
  }
);

export const handleListAdmins = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "admins:read");
    const input = parseSearchParams(request, pageSchema);
    return jsonData(await store.listAdmins(pageInput(input)));
  }
);

export const handleListAdminInvitations = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "admins:read");
    const input = parseSearchParams(request, pageSchema);
    return jsonData(await store.listAdminInvitations(pageInput(input)));
  }
);

export const handleListAdminTasks = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    await requireCapability(request, store, "tasks:read");
    const input = parseSearchParams(request, pageSchema);
    return jsonData(await store.listAdminTasks(pageInput(input)));
  }
);

export const handleUpdateAdminTaskState = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "tasks:write");
    const input = await parseJson(request, adminTaskStateUpdateSchema);
    const state = await store.updateAdminTaskState(
      input.taskKey,
      {
        expectedRevision: input.expectedRevision,
        ...(input.assigneeUserId === undefined
          ? {}
          : { assigneeUserId: input.assigneeUserId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.dueAt === undefined
          ? {}
          : { dueAt: input.dueAt === null ? null : new Date(input.dueAt) }),
        ...(input.snoozedUntil === undefined
          ? {}
          : {
              snoozedUntil:
                input.snoozedUntil === null
                  ? null
                  : new Date(input.snoozedUntil)
            }),
        ...(input.note === undefined ? {} : { note: input.note })
      },
      auditContext(request, actor)
    );
    return jsonData(state);
  }
);

export const handleGetAdminContext = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const user = await authenticate(request);
    const role = await store.getAdminRole(user.id);
    if (!role) {
      throw new ApiError(403, "FORBIDDEN", "当前账号没有运营后台权限。");
    }

    const actor = { ...user, role };
    const context = buildAdminContext(actor);
    const { requestId } = auditContext(request, actor);
    return new Response(JSON.stringify({ data: context, requestId }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    });
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

export const handleCreateAdminInvitation = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "admins:write");
    const input = await parseJson(request, adminInvitationCreateSchema);
    const token = crypto.randomUUID();
    const created = await store.createAdminInvitation(
      {
        email: input.email,
        role: input.role,
        tokenHash: hashAdminInvitationToken(token)
      },
      auditContext(request, actor)
    );

    if (!created) throw notFound("管理员邀请");
    return jsonData(
      {
        invitation: created,
        token,
        acceptUrl: new URL(
          `/accept-admin-invitation?token=${token}`,
          request.url
        ).toString()
      },
      { status: 201 }
    );
  }
);

export const handleDeleteAdminInvitation = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "admins:write");
    const input = await parseJson(request, adminInvitationDeleteSchema);
    const removed = await store.revokeAdminInvitation(
      input.invitationId,
      auditContext(request, actor)
    );

    if (!removed) throw notFound("管理员邀请");
    return jsonData(removed);
  }
);

export const handleAcceptAdminInvitation = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const user = await authenticate(request);
    const actor = asUserActor(user);
    const token = await parseAdminInvitationToken(request);
    const accepted = await store.acceptAdminInvitation(
      {
        tokenHash: hashAdminInvitationToken(token),
        userId: user.id,
        userEmail: user.email ?? "",
        emailVerified: Boolean(user.emailVerified)
      },
      auditContext(request, actor)
    );

    if (!accepted) throw notFound("管理员邀请");
    return jsonData(accepted);
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

export const handleReplaceAdminRole = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "admins:write");
    const input = await parseJson(request, adminRoleReplaceSchema);
    const updated = await store.replaceAdminRole(
      input.userId,
      input.expectedRole,
      input.role,
      auditContext(request, actor)
    );

    if (!updated) throw notFound("管理员角色");
    return jsonData(updated);
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

export const handleRevokeUserSessions = withApiErrors(
  async (request: Request, userId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "users:write");
    await assertCanManageUser(actor, userId, store, true);
    const input = await parseJson(request, userSessionRevokeSchema);
    const revoked = await store.revokeUserSessions(
      userId,
      input.reason,
      auditContext(request, actor)
    );

    if (!revoked) throw notFound("用户");
    return jsonData(revoked);
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

export const handleListAdminProblemReports = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(
      request,
      store,
      "problem_reports:read"
    );
    const input = parseSearchParams(request, pageSchema);
    return jsonData(
      await store.listAdminProblemReports(
        pageInput(input),
        auditContext(request, actor)
      )
    );
  }
);

export const handleSetProblemReportStatus = withApiErrors(
  async (
    request: Request,
    problemReportId: string,
    store: ApiStore = apiStore
  ) => {
    const actor = await requireCapability(
      request,
      store,
      "problem_reports:write"
    );
    const id = uuidSchema.parse(problemReportId);
    const input = await parseJson(request, problemReportStatusSchema);
    const updated = await store.setProblemReportStatus(
      id,
      input,
      auditContext(request, actor)
    );

    if (!updated) throw notFound("问题反馈");
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
    const actor = await requireCapability(request, store, "knowledge:draft");
    const input = await parseJson(request, knowledgeDraftSchema);
    const created = await store.createKnowledgeDraft(
      input,
      auditContext(request, actor)
    );
    return jsonData(created, { status: 201 });
  }
);

export const handleImportKnowledgeCandidate = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "knowledge:draft");
    const input = await parseJson(request, knowledgeCandidateSchema);
    const created = await store.importKnowledgeCandidate(
      input,
      auditContext(request, actor)
    );
    return jsonData(created, { status: 201 });
  }
);

export const handleUpdateKnowledgeDraft = withApiErrors(
  async (request: Request, documentId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "knowledge:draft");
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
    await requireCapability(request, store, "knowledge:review");
    uuidSchema.parse(documentId);
    throw new ApiError(
      409,
      "KNOWLEDGE_SECTION_REVIEW_REQUIRED",
      "整份哈希批准已停用，请在逐段审核工作台完成全部段落审核。"
    );
  }
);

export const handlePublishKnowledge = withApiErrors(
  async (request: Request, documentId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "knowledge:publish");
    const id = uuidSchema.parse(documentId);
    const published = await store.publishKnowledgeDraft(
      id,
      auditContext(request, actor)
    );

    if (!published) throw notFound("可发布的知识草稿");
    return jsonData(published);
  }
);

export const handleArchiveKnowledge = withApiErrors(
  async (request: Request, documentId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "knowledge:rollback");
    const id = uuidSchema.parse(documentId);
    const archived = await store.archiveKnowledgeDocument(
      id,
      auditContext(request, actor)
    );

    if (!archived) throw notFound("知识文档");
    return jsonData(archived);
  }
);

export const handleRollbackKnowledge = withApiErrors(
  async (request: Request, documentId: string, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "knowledge:rollback");
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
    const budgets = await store.getBudgetOverview(new Date());
    return jsonData({ budgets, items: budgetTableItems(budgets) });
  }
);

export const handleUpdateBudgets = withApiErrors(
  async (request: Request, store: ApiStore = apiStore) => {
    const actor = await requireCapability(request, store, "budgets:write");
    const input = await parseJson(request, budgetsSchema);
    await store.updateBudgets(input.budgets, auditContext(request, actor));
    const overview = await store.getBudgetOverview(new Date());
    return jsonData({ budgets: overview, items: budgetTableItems(overview) });
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
    const allowedKeys = new Set(["agent_responses_v2_enabled"]);
    const forbiddenKeys = Object.keys(input.settings).filter(
      (key) => !allowedKeys.has(key)
    );
    if (forbiddenKeys.length > 0) {
      throw new ApiError(
        422,
        "SETTING_KEY_NOT_ALLOWED",
        "通用设置接口只允许修改经过审核的非敏感配置项。"
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
