import type { ChatMessage } from "@/types/chat";

export const ADMIN_ROLES = [
  "owner",
  "admin",
  "knowledge_editor",
  "support",
  "analyst"
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_CAPABILITIES = [
  "conversations:read",
  "admins:read",
  "admins:write",
  "users:read",
  "users:write",
  "feedback:read",
  "feedback:write",
  "problem_reports:read",
  "problem_reports:write",
  "knowledge:read",
  "knowledge:write",
  "sources:read",
  "sources:write",
  "prompts:read",
  "prompts:write",
  "budgets:read",
  "budgets:write",
  "settings:read",
  "settings:write",
  "metrics:read",
  "audit:read"
] as const;

export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

export type AuthenticatedUser = {
  id: string;
  email: string | null;
  name: string | null;
  banned: boolean;
  roleHint: AdminRole | null;
};

export type Actor = AuthenticatedUser & {
  role: AdminRole | "user";
};

export type AdminActor = AuthenticatedUser & {
  role: AdminRole;
};

export type AuditContext = {
  actor: Actor;
  requestId: string;
  path: string;
  method: string;
};

export type PageInput = {
  page: number;
  pageSize: number;
  query?: string;
  status?: string;
};

export type PageResult<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

export type ConversationSummary = {
  id: string;
  title: string;
  summary: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ConversationDetail = ConversationSummary & {
  messages: ChatMessage[];
};

export const PROBLEM_REPORT_CATEGORIES = [
  "answer_incorrect",
  "citation_problem",
  "unsafe_answer",
  "system_error",
  "product_suggestion",
  "other"
] as const;

export type ProblemReportCategory = (typeof PROBLEM_REPORT_CATEGORIES)[number];

export type ProblemReportInput = {
  conversationId?: string;
  messageId?: string;
  category: ProblemReportCategory;
  description: string;
  includeContext: boolean;
  contactType?: "phone" | "email" | "wechat";
  contactValue?: string;
  consentToContact: boolean;
};

export type KnowledgeDraftInput = {
  title: string;
  sourceId?: string;
  ingestionMode: "full_text" | "metadata_only";
  content: string;
  citationMetadata: Record<string, unknown>;
};

export type KnowledgeDraftUpdate = Partial<KnowledgeDraftInput>;

export type KnowledgeReviewInput = {
  versionId: string;
  expectedContentHash: string;
  decision: "approved" | "rejected";
  note?: string;
};

export type SourceRightsDecisionInput = {
  status: "approved" | "pending" | "rejected";
  scope: "full_text" | "metadata_only";
  basis: string;
  evidenceUrl: string;
  appliesToRecordUrl: string;
};

export type SourceInput = {
  kind: "upload" | "manual" | "manufacturer" | "standard" | "patent" | "web";
  name: string;
  publisher: string;
  canonicalUrl: string;
  baseUrl: string;
  sourceTier:
    | "open_license"
    | "metadata_only"
    | "manufacturer_metadata"
    | "standard_metadata"
    | "internal";
  licensePolicy: string;
  rightsDecision?: SourceRightsDecisionInput;
  notes?: string;
  enabled: boolean;
};

export type PromptInput = {
  key: string;
  content: string;
  notes?: string;
};

export type ModelBudgetInput = {
  model: string;
  dailyLimitCents: number;
  monthlyLimitCents: number;
  enabled: boolean;
};

export type ApiStore = {
  getAdminRole(userId: string): Promise<AdminRole | null>;
  listAdminConversations(
    input: PageInput
  ): Promise<PageResult<Record<string, unknown>>>;
  listAdmins(input: PageInput): Promise<PageResult<Record<string, unknown>>>;
  grantAdminRole(
    userId: string,
    role: AdminRole,
    audit: AuditContext
  ): Promise<Record<string, unknown> | null>;
  revokeAdminRole(
    userId: string,
    role: AdminRole,
    audit: AuditContext
  ): Promise<Record<string, unknown> | null>;

  listConversations(
    userId: string,
    input: PageInput
  ): Promise<PageResult<ConversationSummary>>;
  getConversation(
    userId: string,
    conversationId: string
  ): Promise<ConversationDetail | null>;
  createConversation(
    userId: string,
    title: string,
    audit: AuditContext
  ): Promise<ConversationSummary>;
  renameConversation(
    userId: string,
    conversationId: string,
    title: string,
    audit: AuditContext
  ): Promise<ConversationSummary | null>;
  deleteConversation(
    userId: string,
    conversationId: string,
    audit: AuditContext
  ): Promise<boolean>;
  clearConversationData(
    userId: string,
    audit: AuditContext
  ): Promise<{
    conversationsDeleted: number;
    messagesDeleted: number;
    candidateCitationsDeleted: number;
  }>;

  saveMessageFeedback(
    userId: string,
    messageId: string,
    input: {
      kind: "feedback";
      rating: "helpful" | "not_helpful";
      reason?: string;
      comment?: string;
    },
    audit: AuditContext
  ): Promise<{ id: string; status: string } | null>;
  reportMessage(
    userId: string,
    messageId: string,
    input: {
      kind: "report";
      category:
        "unsafe" | "incorrect" | "privacy" | "copyright" | "spam" | "other";
      details?: string;
    },
    audit: AuditContext
  ): Promise<{ id: string; status: string } | null>;

  createProblemReport(
    userId: string,
    input: ProblemReportInput,
    audit: AuditContext
  ): Promise<{ id: string; status: string; createdAt: Date } | null>;

  listUsers(input: PageInput): Promise<PageResult<Record<string, unknown>>>;
  setUserBan(
    userId: string,
    input: { banned: boolean; reason?: string; expiresAt?: Date },
    audit: AuditContext
  ): Promise<Record<string, unknown> | null>;
  setUserQuotaBonus(
    userId: string,
    input: { dailyBonus: number; reason: string },
    audit: AuditContext
  ): Promise<Record<string, unknown> | null>;

  listFeedback(input: PageInput): Promise<PageResult<Record<string, unknown>>>;
  setFeedbackStatus(
    feedbackId: string,
    input: {
      status: "open" | "reviewing" | "resolved" | "dismissed";
      note?: string;
    },
    audit: AuditContext
  ): Promise<Record<string, unknown> | null>;
  listAdminProblemReports(
    input: PageInput,
    audit: AuditContext
  ): Promise<PageResult<Record<string, unknown>>>;
  setProblemReportStatus(
    problemReportId: string,
    input: {
      status: "new" | "reviewing" | "closed";
      note?: string;
    },
    audit: AuditContext
  ): Promise<Record<string, unknown> | null>;

  listKnowledgeDocuments(
    input: PageInput
  ): Promise<PageResult<Record<string, unknown>>>;
  getKnowledgeDocument(
    documentId: string
  ): Promise<Record<string, unknown> | null>;
  createKnowledgeDraft(
    input: KnowledgeDraftInput,
    audit: AuditContext
  ): Promise<Record<string, unknown>>;
  updateKnowledgeDraft(
    documentId: string,
    input: KnowledgeDraftUpdate,
    audit: AuditContext
  ): Promise<Record<string, unknown> | null>;
  reviewKnowledgeDocument(
    documentId: string,
    input: KnowledgeReviewInput,
    audit: AuditContext
  ): Promise<Record<string, unknown> | null>;
  publishKnowledgeDraft(
    documentId: string,
    audit: AuditContext
  ): Promise<Record<string, unknown> | null>;
  archiveKnowledgeDocument(
    documentId: string,
    audit: AuditContext
  ): Promise<Record<string, unknown> | null>;
  rollbackKnowledgeDocument(
    documentId: string,
    versionId: string,
    audit: AuditContext
  ): Promise<Record<string, unknown> | null>;

  listSources(input: PageInput): Promise<PageResult<Record<string, unknown>>>;
  createSource(
    input: SourceInput,
    audit: AuditContext
  ): Promise<Record<string, unknown>>;
  updateSource(
    sourceId: string,
    input: Partial<SourceInput>,
    audit: AuditContext
  ): Promise<Record<string, unknown> | null>;
  deleteSource(sourceId: string, audit: AuditContext): Promise<boolean>;

  listPrompts(input: PageInput): Promise<PageResult<Record<string, unknown>>>;
  createPromptVersion(
    input: PromptInput,
    audit: AuditContext
  ): Promise<Record<string, unknown>>;
  updatePromptVersion(
    promptId: string,
    input: {
      content?: string;
      notes?: string;
      status?: "draft" | "active" | "archived";
    },
    audit: AuditContext
  ): Promise<Record<string, unknown> | null>;

  getBudgets(): Promise<ModelBudgetInput[]>;
  updateBudgets(
    input: ModelBudgetInput[],
    audit: AuditContext
  ): Promise<ModelBudgetInput[]>;
  getSettings(): Promise<Record<string, unknown>>;
  updateSettings(
    input: Record<string, boolean | number | string>,
    audit: AuditContext
  ): Promise<Record<string, unknown>>;
  getMetrics(input: { from: Date; to: Date }): Promise<Record<string, unknown>>;
  listAuditLogs(
    input: PageInput,
    viewerRole: AdminRole
  ): Promise<PageResult<Record<string, unknown>>>;
};
