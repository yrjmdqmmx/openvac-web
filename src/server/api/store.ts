import { createHash } from "node:crypto";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql
} from "drizzle-orm";

import { db } from "@/server/db";
import {
  serializeStoredCitation,
  serializeStoredMessage
} from "@/server/chat/stored-message";
import {
  adminRoles,
  auditLogs,
  backgroundTasks,
  citations,
  conversations,
  dailyUsage,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeSources,
  knowledgeVersions,
  messageCitations,
  messageFeedback,
  messages,
  promptVersions,
  problemReports,
  systemSettings,
  user as users
} from "@/server/db/schema";
import {
  assertKnowledgeSourceAuthorized,
  KnowledgeSourcePolicyError,
  type GovernedKnowledgeSource
} from "@/server/knowledge/source-policy";
import {
  problemReportClosureTransition,
  problemReportRetentionUntil
} from "@/server/problem-reports/retention";
import { storedProblemReportAssociations } from "@/server/problem-reports/context-policy";
import {
  PROBLEM_REPORT_SUBMISSION_LIMIT,
  PROBLEM_REPORT_SUBMISSION_WINDOW_MS
} from "@/server/problem-reports/submission-policy";

import { ApiError } from "./errors";
import { auditLogReadPolicy } from "./audit-policy";
import {
  assertCurrentOwnerRole,
  assertOwnerRoleRevocationAllowed
} from "./role-policy";
import {
  ADMIN_ROLES,
  type AdminRole,
  type ApiStore,
  type AuditContext,
  type ConversationDetail,
  type ConversationSummary,
  type KnowledgeReviewInput,
  type ModelBudgetInput,
  type PageInput,
  type PageResult,
  type SourceInput
} from "./types";

function auditValues(
  context: AuditContext,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {}
): typeof auditLogs.$inferInsert {
  return {
    id: crypto.randomUUID(),
    actorUserId: context.actor.id,
    actorRole: context.actor.role,
    action,
    targetType,
    targetId,
    requestId: context.requestId,
    metadata: {
      requestId: context.requestId,
      path: context.path,
      method: context.method,
      ...metadata
    },
    createdAt: new Date()
  };
}

export function serializeProblemReportContextMessages(
  recentMessages: ReadonlyArray<{
    id: string;
    role: string;
    content: string;
    sequence: number;
    createdAt: Date;
  }>
) {
  return [...recentMessages]
    .sort((left, right) => left.sequence - right.sequence)
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt.toISOString()
    }));
}

export function orderConversationMessages<T extends { sequence: number }>(
  messageRows: ReadonlyArray<T>
): T[] {
  return [...messageRows].sort((left, right) => left.sequence - right.sequence);
}

export function existingKnowledgeEmbeddingMatchesReview(input: {
  ingestionMode: unknown;
  reviewedContentHash: unknown;
  nextContentHash: string;
}): boolean {
  return (
    input.ingestionMode === "full_text" &&
    typeof input.reviewedContentHash === "string" &&
    input.reviewedContentHash.toLowerCase() ===
      input.nextContentHash.toLowerCase()
  );
}

export function hasCompleteKnowledgeEmbeddingSet(input: {
  totalChunks: number;
  embeddedChunks: number;
}): boolean {
  return (
    Number.isSafeInteger(input.totalChunks) &&
    Number.isSafeInteger(input.embeddedChunks) &&
    input.totalChunks > 0 &&
    input.embeddedChunks === input.totalChunks
  );
}

function pageResult<T>(
  items: T[],
  input: PageInput,
  total: number
): PageResult<T> {
  return {
    items,
    page: input.page,
    pageSize: input.pageSize,
    total
  };
}

function offset(input: PageInput): number {
  return (input.page - 1) * input.pageSize;
}

function effectiveAdminRole(
  results: ReadonlyArray<{ role: AdminRole }>
): AdminRole | null {
  const assigned = new Set(results.map((result) => result.role));
  return ADMIN_ROLES.find((role) => assigned.has(role)) ?? null;
}

function assertUserMutationAllowed(input: {
  actorUserId: string;
  actorRole: AdminRole | null;
  targetUserId: string;
  targetRole: AdminRole | null;
  destructive: boolean;
}): "owner" | "admin" {
  if (input.actorRole !== "owner" && input.actorRole !== "admin") {
    throw new ApiError(403, "FORBIDDEN", "当前管理员角色无权执行此操作。");
  }

  if (input.destructive && input.actorUserId === input.targetUserId) {
    throw new ApiError(
      409,
      "SELF_MANAGEMENT_FORBIDDEN",
      "不能对当前登录账号执行该操作。"
    );
  }

  if (input.targetRole === "owner" && input.actorRole !== "owner") {
    throw new ApiError(
      403,
      "OWNER_PROTECTED",
      "只有 owner 可以管理 owner 账号。"
    );
  }

  if (input.targetRole === "admin" && input.actorRole !== "owner") {
    throw new ApiError(
      403,
      "ADMIN_PROTECTED",
      "只有 owner 可以管理 admin 账号。"
    );
  }

  return input.actorRole;
}

function queryPattern(query: string): string {
  return `%${query}%`;
}

function sourceDomain(value: string | null): string {
  if (!value) return "";
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function assertSourceRightsMutationAllowed(
  audit: AuditContext,
  hasRightsDecision: boolean
): void {
  if (
    hasRightsDecision &&
    audit.actor.role !== "owner" &&
    audit.actor.role !== "admin"
  ) {
    throw new ApiError(
      403,
      "SOURCE_RIGHTS_APPROVAL_FORBIDDEN",
      "只有 owner 或 admin 可以记录来源权利决定。"
    );
  }
}

function reviewedRightsDecision(
  decision: NonNullable<SourceInput["rightsDecision"]>,
  canonicalUrl: string,
  audit: AuditContext,
  reviewedAt: Date
): Record<string, unknown> {
  if (decision.appliesToRecordUrl !== canonicalUrl) {
    throw new ApiError(
      409,
      "SOURCE_RIGHTS_SCOPE_MISMATCH",
      "权利决定必须精确对应当前 canonicalUrl。"
    );
  }
  return {
    ...decision,
    reviewedBy: audit.actor.id,
    reviewedAt: reviewedAt.toISOString()
  };
}

export function sourceAdminTableShape<
  T extends {
    kind?: string;
    publisher: string | null;
    name: string;
    baseUrl: string | null;
    canonicalUrl?: string | null;
    licensePolicy: string | null;
    sourceTier: string;
    metadata?: Record<string, unknown>;
  }
>(item: T) {
  const rightsDecision = recordValue(item.metadata?.rightsDecision);
  return {
    ...item,
    publisher: item.publisher ?? item.name,
    domain: sourceDomain(item.baseUrl),
    licenseClass: item.licensePolicy ?? item.sourceTier,
    rightsStatus:
      typeof rightsDecision.status === "string"
        ? rightsDecision.status
        : "not_recorded",
    rightsScope:
      typeof rightsDecision.scope === "string" ? rightsDecision.scope : null,
    rightsReviewedBy:
      typeof rightsDecision.reviewedBy === "string"
        ? rightsDecision.reviewedBy
        : null,
    rightsReviewedAt:
      typeof rightsDecision.reviewedAt === "string"
        ? rightsDecision.reviewedAt
        : null
  };
}

export function promptAdminTableShape<
  T extends {
    key: string;
  }
>(item: T) {
  return {
    ...item,
    name: item.key,
    evaluationScore: null
  };
}

function enumValue<const T extends readonly string[]>(
  values: T,
  value: string | undefined
): T[number] | undefined {
  return value && values.includes(value) ? (value as T[number]) : undefined;
}

function assertPublishableKnowledgeSource(
  source: GovernedKnowledgeSource | undefined,
  citationMetadata: Record<string, unknown>,
  operation: "发布" | "回滚发布"
): void {
  try {
    assertKnowledgeSourceAuthorized(source, citationMetadata);
  } catch (error) {
    if (error instanceof KnowledgeSourcePolicyError) {
      throw new ApiError(
        409,
        error.code,
        `${error.message} 当前操作：${operation}。`
      );
    }
    throw error;
  }
}

type KnowledgeStatus =
  "draft" | "processing" | "review" | "published" | "failed" | "archived";

export type KnowledgePublicationGateInput = {
  documentStatus: string;
  versionStatus: KnowledgeStatus;
  content: string;
  contentHash: string | null;
  citationMetadata: Record<string, unknown>;
  metadata: Record<string, unknown>;
  chunkCount: number;
};

export function sha256KnowledgeContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function knowledgeEvidenceMetadataChanged(input: {
  currentSourceId: string | null;
  nextSourceId?: string | null;
  ingestionModeProvided: boolean;
  citationMetadataProvided: boolean;
}): boolean {
  return (
    input.ingestionModeProvided ||
    input.citationMetadataProvided ||
    (input.nextSourceId !== undefined &&
      input.nextSourceId !== input.currentSourceId)
  );
}

export type KnowledgeReviewTransition = {
  documentStatus: "draft" | "review";
  versionStatus: "draft" | "review";
  contentHash: string;
  review: {
    status: "approved" | "rejected";
    reviewedBy: string;
    reviewedAt: string;
    contentHash: string;
    note?: string;
  };
  embeddingStatus: "queued" | "not_applicable" | "pending_review";
  task:
    | {
        idempotencyKey: string;
        payload: {
          stage: "embedding_pending";
          documentId: string;
          versionId: string;
          review: KnowledgeReviewTransition["review"];
        };
      }
    | undefined;
};

export function buildKnowledgeReviewTransition(input: {
  documentId: string;
  versionId: string;
  expectedVersionId: string;
  content: string;
  storedContentHash: string | null;
  expectedContentHash: string;
  ingestionMode: unknown;
  reviewerId: string;
  reviewedAt: Date;
  decision?: "approved" | "rejected";
  note?: string;
}): KnowledgeReviewTransition {
  const actualHash = sha256KnowledgeContent(input.content);
  const storedHash = input.storedContentHash?.toLowerCase() ?? null;
  const expectedHash = input.expectedContentHash.toLowerCase();

  if (
    input.versionId !== input.expectedVersionId ||
    !storedHash ||
    storedHash !== expectedHash ||
    actualHash !== expectedHash
  ) {
    throw new ApiError(
      409,
      "KNOWLEDGE_REVIEW_CONFLICT",
      "知识内容或版本已变化，请刷新详情后重新复核。"
    );
  }
  if (
    input.ingestionMode !== "full_text" &&
    input.ingestionMode !== "metadata_only"
  ) {
    throw new ApiError(
      409,
      "KNOWLEDGE_INGESTION_MODE_INVALID",
      "知识版本缺少有效的入库模式。"
    );
  }
  if (input.decision === "rejected" && !input.note?.trim()) {
    throw new ApiError(
      422,
      "KNOWLEDGE_REJECTION_NOTE_REQUIRED",
      "驳回知识时必须填写审核备注。"
    );
  }

  const review = {
    status: input.decision ?? ("approved" as const),
    reviewedBy: input.reviewerId,
    reviewedAt: input.reviewedAt.toISOString(),
    contentHash: actualHash,
    ...(input.note ? { note: input.note } : {})
  };
  if (review.status === "rejected") {
    return {
      documentStatus: "draft",
      versionStatus: "draft",
      contentHash: actualHash,
      review,
      embeddingStatus: "pending_review",
      task: undefined
    };
  }
  const task =
    input.ingestionMode === "full_text"
      ? {
          idempotencyKey: `knowledge-embedding:${input.versionId}:${actualHash}`,
          payload: {
            stage: "embedding_pending" as const,
            documentId: input.documentId,
            versionId: input.versionId,
            review
          }
        }
      : undefined;

  return {
    documentStatus: "review",
    versionStatus: "review",
    contentHash: actualHash,
    review,
    embeddingStatus: task ? "queued" : "not_applicable",
    task
  };
}

export function invalidateKnowledgeReviewAfterHashChange(input: {
  metadata: Record<string, unknown>;
  previousContentHash: string | null;
  nextContentHash: string;
  invalidatedBy: string;
  invalidatedAt: Date;
}): { invalidated: boolean; metadata: Record<string, unknown> } {
  const previousHash = input.previousContentHash?.toLowerCase() ?? null;
  const nextHash = input.nextContentHash.toLowerCase();
  if (previousHash === nextHash) {
    return { invalidated: false, metadata: input.metadata };
  }

  const existingReview = recordValue(input.metadata.review);
  return {
    invalidated: true,
    metadata: {
      ...input.metadata,
      reviewStatus: "required",
      embeddingStatus: "pending_review",
      ...(Object.keys(existingReview).length > 0
        ? {
            review: {
              ...existingReview,
              status: "invalidated",
              invalidatedAt: input.invalidatedAt.toISOString(),
              invalidatedBy: input.invalidatedBy,
              invalidatedReason: "content_hash_changed",
              invalidatedContentHash: nextHash
            }
          }
        : {})
    }
  };
}

export function effectiveKnowledgeReviewStatus(input: {
  metadata: Record<string, unknown>;
  content: string;
  contentHash: string | null;
}): string {
  const review = recordValue(input.metadata.review);
  if (review.status === "invalidated") return "invalidated";

  const configured = stringValue(input.metadata.reviewStatus) ?? "required";
  if (configured !== "approved") return configured;

  const reviewedHash = stringValue(review.contentHash)?.toLowerCase();
  const storedHash = input.contentHash?.toLowerCase() ?? null;
  const actualHash = sha256KnowledgeContent(input.content);
  return reviewedHash &&
    storedHash === reviewedHash &&
    actualHash === storedHash
    ? "approved"
    : "invalidated";
}

export function assertKnowledgePublicationGate(
  input: KnowledgePublicationGateInput
): void {
  if (input.documentStatus !== "review" || input.versionStatus !== "review") {
    throw new ApiError(
      409,
      "KNOWLEDGE_REVIEW_REQUIRED",
      "知识文档和当前版本必须处于人工复核状态后才能发布。"
    );
  }
  assertReviewedKnowledgeEvidence(input);
}

export function assertHistoricalRollbackTarget(input: {
  targetVersionId: string;
  currentVersionId: string | null;
  status: KnowledgeStatus;
  publishedAt: Date | null;
}): void {
  if (
    input.targetVersionId === input.currentVersionId ||
    input.publishedAt === null ||
    (input.status !== "published" && input.status !== "archived")
  ) {
    throw new ApiError(
      409,
      "ROLLBACK_TARGET_NOT_PUBLISHED",
      "只能回滚到曾经正式发布且不是当前版本的历史版本。"
    );
  }
}

function assertReviewedKnowledgeEvidence(
  input:
    | Omit<KnowledgePublicationGateInput, "documentStatus" | "versionStatus">
    | KnowledgePublicationGateInput
): void {
  const review = recordValue(input.metadata.review);
  const reviewedBy = stringValue(review.reviewedBy);
  const reviewedAt = stringValue(review.reviewedAt);
  const reviewHash = stringValue(review.contentHash)?.toLowerCase();
  const contentHash = input.contentHash?.toLowerCase() ?? null;
  const actualHash = sha256KnowledgeContent(input.content);

  if (
    input.metadata.reviewStatus !== "approved" ||
    !reviewedBy ||
    !reviewedAt ||
    Number.isNaN(new Date(reviewedAt).getTime()) ||
    new Date(reviewedAt).getTime() > Date.now() + 5 * 60_000
  ) {
    throw new ApiError(
      409,
      "KNOWLEDGE_HUMAN_REVIEW_REQUIRED",
      "发布前必须记录有效的人工复核人和复核时间。"
    );
  }
  if (
    !contentHash ||
    !reviewHash ||
    !/^[a-f0-9]{64}$/u.test(contentHash) ||
    !/^[a-f0-9]{64}$/u.test(reviewHash) ||
    contentHash !== reviewHash ||
    contentHash !== actualHash
  ) {
    throw new ApiError(
      409,
      "KNOWLEDGE_CONTENT_HASH_MISMATCH",
      "复核哈希与当前知识内容不一致，必须重新人工复核。"
    );
  }

  const ingestionMode = input.citationMetadata.ingestionMode;
  if (ingestionMode === "full_text") {
    if (
      input.metadata.embeddingStatus !== "completed" ||
      !Number.isInteger(input.chunkCount) ||
      input.chunkCount < 1
    ) {
      throw new ApiError(
        409,
        "KNOWLEDGE_EMBEDDING_REQUIRED",
        "全文知识必须完成向量化且至少生成一个检索片段后才能发布。"
      );
    }
    return;
  }
  if (ingestionMode === "metadata_only") {
    if (input.metadata.embeddingStatus !== "not_applicable") {
      throw new ApiError(
        409,
        "KNOWLEDGE_EMBEDDING_STATUS_INVALID",
        "仅元数据知识必须明确标记为无需向量化。"
      );
    }
    return;
  }
  throw new ApiError(
    409,
    "KNOWLEDGE_INGESTION_MODE_INVALID",
    "知识版本缺少有效的入库模式。"
  );
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function messageOwnedByUser(
  userId: string,
  messageId: string
): Promise<boolean> {
  const [owned] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(messages.id, messageId),
        eq(conversations.userId, userId),
        ne(conversations.status, "deleted"),
        isNull(conversations.deletedAt)
      )
    )
    .limit(1);

  return Boolean(owned);
}

async function loadKnowledgeDocumentView(
  document: typeof knowledgeDocuments.$inferSelect,
  includeContent: boolean
): Promise<Record<string, unknown>> {
  const currentVersionId = document.currentVersionId;
  const [versionRows, sourceRows, chunkRows, previousRows] = await Promise.all([
    currentVersionId
      ? db
          .select()
          .from(knowledgeVersions)
          .where(eq(knowledgeVersions.id, currentVersionId))
          .limit(1)
      : Promise.resolve([]),
    document.sourceId
      ? db
          .select()
          .from(knowledgeSources)
          .where(
            and(
              eq(knowledgeSources.id, document.sourceId),
              isNull(knowledgeSources.deletedAt)
            )
          )
          .limit(1)
      : Promise.resolve([]),
    currentVersionId
      ? db
          .select({ value: count() })
          .from(knowledgeChunks)
          .where(eq(knowledgeChunks.versionId, currentVersionId))
      : Promise.resolve([]),
    currentVersionId
      ? db
          .select({
            id: knowledgeVersions.id,
            version: knowledgeVersions.version
          })
          .from(knowledgeVersions)
          .where(
            and(
              eq(knowledgeVersions.documentId, document.id),
              ne(knowledgeVersions.id, currentVersionId),
              isNotNull(knowledgeVersions.publishedAt)
            )
          )
          .orderBy(desc(knowledgeVersions.publishedAt))
          .limit(1)
      : Promise.resolve([])
  ]);

  const version = versionRows[0];
  const source = sourceRows[0];
  const chunkCount = Number(chunkRows[0]?.value ?? 0);
  let publishReady = false;
  const publishBlockers: string[] = [];
  if (
    version &&
    document.status !== "published" &&
    document.status !== "archived"
  ) {
    try {
      assertKnowledgePublicationGate({
        documentStatus: document.status,
        versionStatus: version.status,
        content: version.content,
        contentHash: version.contentHash,
        citationMetadata: version.citationMetadata,
        metadata: version.metadata,
        chunkCount
      });
      assertPublishableKnowledgeSource(
        source,
        version.citationMetadata,
        "发布"
      );
      publishReady = true;
    } catch (error) {
      publishReady = false;
      publishBlockers.push(
        error instanceof ApiError
          ? error.message
          : "发布门禁检查失败，请稍后重试。"
      );
    }
  }

  const versionMetadata = recordValue(version?.metadata);
  const effectiveReviewStatus = version
    ? effectiveKnowledgeReviewStatus({
        metadata: versionMetadata,
        content: version.content,
        contentHash: version.contentHash
      })
    : "required";
  const review = recordValue(versionMetadata.review);
  return {
    ...document,
    sourceTier: source?.sourceTier ?? "internal",
    publisher: source?.publisher ?? source?.name ?? null,
    licenseClass: source?.licensePolicy ?? "unknown",
    version: version?.version ?? null,
    versionStatus: version?.status ?? null,
    contentHash: version?.contentHash ?? null,
    citationMetadata: version?.citationMetadata ?? {},
    versionMetadata,
    reviewStatus: effectiveReviewStatus,
    reviewNote: stringValue(review.note) ?? null,
    reviewInvalidatedAt: stringValue(review.invalidatedAt) ?? null,
    embeddingStatus: versionMetadata.embeddingStatus ?? "pending_review",
    ocrConfidence: versionMetadata.ocrConfidence ?? null,
    chunkCount,
    previousPublishedVersionId: previousRows[0]?.id ?? null,
    publishReady,
    publishBlockers,
    ...(includeContent
      ? {
          content: version?.content ?? "",
          currentVersionStatus: version?.status ?? null,
          review: versionMetadata.review ?? null
        }
      : {})
  };
}

export const apiStore: ApiStore = {
  async getAdminRole(userId) {
    const results = await db
      .select({ role: adminRoles.role })
      .from(adminRoles)
      .where(eq(adminRoles.userId, userId))
      .orderBy(desc(adminRoles.createdAt));

    return effectiveAdminRole(results);
  },

  async listAdminConversations(input) {
    const status = enumValue(["active", "archived"] as const, input.status);
    const filters = [
      ne(conversations.status, "deleted"),
      isNull(conversations.deletedAt),
      ...(status ? [eq(conversations.status, status)] : []),
      ...(input.query
        ? [
            or(
              ilike(conversations.title, queryPattern(input.query)),
              ilike(conversations.summary, queryPattern(input.query)),
              ilike(users.name, queryPattern(input.query)),
              ilike(users.email, queryPattern(input.query))
            )
          ]
        : [])
    ];

    const [items, totalRows] = await Promise.all([
      db
        .select({
          id: conversations.id,
          userId: conversations.userId,
          userName: users.name,
          userEmail: users.email,
          title: conversations.title,
          summary: conversations.summary,
          status: conversations.status,
          model: conversations.model,
          lastMessageAt: conversations.lastMessageAt,
          createdAt: conversations.createdAt,
          updatedAt: conversations.updatedAt
        })
        .from(conversations)
        .innerJoin(users, eq(conversations.userId, users.id))
        .where(and(...filters))
        .orderBy(desc(conversations.updatedAt), desc(conversations.id))
        .limit(input.pageSize)
        .offset(offset(input)),
      db
        .select({ value: count() })
        .from(conversations)
        .innerJoin(users, eq(conversations.userId, users.id))
        .where(and(...filters))
    ]);

    return pageResult(items, input, Number(totalRows[0]?.value ?? 0));
  },

  async listAdmins(input) {
    const role = enumValue(ADMIN_ROLES, input.status);
    const filters = [
      ...(role ? [eq(adminRoles.role, role)] : []),
      ...(input.query
        ? [
            or(
              ilike(users.name, queryPattern(input.query)),
              ilike(users.email, queryPattern(input.query)),
              sql`${adminRoles.role}::text ilike ${queryPattern(input.query)}`
            )
          ]
        : [])
    ];
    const where = filters.length > 0 ? and(...filters) : undefined;

    const [items, totalRows] = await Promise.all([
      db
        .select({
          userId: adminRoles.userId,
          name: users.name,
          email: users.email,
          banned: users.banned,
          role: adminRoles.role,
          createdBy: adminRoles.createdBy,
          createdAt: adminRoles.createdAt
        })
        .from(adminRoles)
        .innerJoin(users, eq(adminRoles.userId, users.id))
        .where(where)
        .orderBy(desc(adminRoles.createdAt), asc(adminRoles.userId))
        .limit(input.pageSize)
        .offset(offset(input)),
      db
        .select({ value: count() })
        .from(adminRoles)
        .innerJoin(users, eq(adminRoles.userId, users.id))
        .where(where)
    ]);

    return pageResult(items, input, Number(totalRows[0]?.value ?? 0));
  },

  async grantAdminRole(userId, role, audit) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(1967086382)`);
      const [currentActorRole] = await tx
        .select({ role: adminRoles.role })
        .from(adminRoles)
        .where(
          and(
            eq(adminRoles.userId, audit.actor.id),
            eq(adminRoles.role, "owner")
          )
        )
        .limit(1);
      assertCurrentOwnerRole(currentActorRole);

      const [target] = await tx
        .select({
          id: users.id,
          deletionRequestedAt: users.deletionRequestedAt
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("key share");
      if (!target) {
        return null;
      }
      if (target.deletionRequestedAt) {
        throw new ApiError(
          409,
          "ACCOUNT_DELETION_IN_PROGRESS",
          "账号正在删除，不能再授予管理员角色。"
        );
      }

      const [created] = await tx
        .insert(adminRoles)
        .values({
          userId,
          role,
          createdBy: audit.actor.id,
          createdAt: new Date()
        })
        .onConflictDoNothing()
        .returning({
          userId: adminRoles.userId,
          role: adminRoles.role,
          createdBy: adminRoles.createdBy,
          createdAt: adminRoles.createdAt
        });

      if (!created) {
        throw new ApiError(
          409,
          "ADMIN_ROLE_ALREADY_ASSIGNED",
          "该管理员角色已经授予。"
        );
      }

      await tx.insert(auditLogs).values({
        ...auditValues(
          audit,
          "admin_role.grant",
          "admin_role",
          `${userId}:${role}`,
          { targetUserId: userId, role }
        ),
        before: { assigned: false, role },
        after: { assigned: true, role }
      });

      return created;
    });
  },

  async revokeAdminRole(userId, role, audit) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(1967086382)`);
      const [currentActorRole] = await tx
        .select({ role: adminRoles.role })
        .from(adminRoles)
        .where(
          and(
            eq(adminRoles.userId, audit.actor.id),
            eq(adminRoles.role, "owner")
          )
        )
        .limit(1);
      assertCurrentOwnerRole(currentActorRole);

      const [existing] = await tx
        .select({
          userId: adminRoles.userId,
          role: adminRoles.role,
          createdBy: adminRoles.createdBy,
          createdAt: adminRoles.createdAt
        })
        .from(adminRoles)
        .where(and(eq(adminRoles.userId, userId), eq(adminRoles.role, role)))
        .limit(1);
      if (!existing) {
        return null;
      }

      if (role === "owner") {
        const [ownerTotal] = await tx
          .select({ value: count() })
          .from(adminRoles)
          .where(eq(adminRoles.role, "owner"));
        assertOwnerRoleRevocationAllowed({
          role,
          ownerCount: Number(ownerTotal?.value ?? 0),
          targetUserId: userId,
          actorUserId: audit.actor.id
        });
      }

      const [removed] = await tx
        .delete(adminRoles)
        .where(and(eq(adminRoles.userId, userId), eq(adminRoles.role, role)))
        .returning({
          userId: adminRoles.userId,
          role: adminRoles.role,
          createdBy: adminRoles.createdBy,
          createdAt: adminRoles.createdAt
        });
      if (!removed) {
        return null;
      }

      await tx.insert(auditLogs).values({
        ...auditValues(
          audit,
          "admin_role.revoke",
          "admin_role",
          `${userId}:${role}`,
          { targetUserId: userId, role }
        ),
        before: { assigned: true, role },
        after: { assigned: false, role }
      });

      return removed;
    });
  },

  async listConversations(userId, input) {
    const filters = [
      eq(conversations.userId, userId),
      ne(conversations.status, "deleted"),
      isNull(conversations.deletedAt),
      ...(input.query
        ? [
            or(
              ilike(conversations.title, queryPattern(input.query)),
              ilike(conversations.summary, queryPattern(input.query))
            )
          ]
        : [])
    ];

    const [items, totalRows] = await Promise.all([
      db
        .select({
          id: conversations.id,
          title: conversations.title,
          summary: conversations.summary,
          createdAt: conversations.createdAt,
          updatedAt: conversations.updatedAt
        })
        .from(conversations)
        .where(and(...filters))
        .orderBy(desc(conversations.updatedAt), desc(conversations.id))
        .limit(input.pageSize)
        .offset(offset(input)),
      db
        .select({ value: count() })
        .from(conversations)
        .where(and(...filters))
    ]);

    return pageResult(
      items.map((item) => ({ ...item, title: item.title ?? "新对话" })),
      input,
      Number(totalRows[0]?.value ?? 0)
    );
  },

  async getConversation(userId, conversationId) {
    const [conversation] = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        summary: conversations.summary,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.userId, userId),
          ne(conversations.status, "deleted"),
          isNull(conversations.deletedAt)
        )
      )
      .limit(1);

    if (!conversation) {
      return null;
    }

    const messageRows = await db
      .select({
        id: messages.id,
        role: messages.role,
        status: messages.status,
        content: messages.content,
        metadata: messages.metadata,
        sequence: messages.sequence
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.sequence));

    const messageIds = messageRows.map((message) => message.id);
    const citationRows =
      messageIds.length === 0
        ? []
        : await db
            .select({
              messageId: messageCitations.messageId,
              id: citations.id,
              title: citations.title,
              url: citations.url,
              license: citations.license,
              locator: citations.locator,
              metadata: citations.metadata
            })
            .from(messageCitations)
            .innerJoin(citations, eq(messageCitations.citationId, citations.id))
            .where(inArray(messageCitations.messageId, messageIds))
            .orderBy(asc(messageCitations.ordinal));

    const citationsByMessage = new Map<
      string,
      NonNullable<ConversationDetail["messages"][number]["meta"]>["citations"]
    >();
    for (const citation of citationRows) {
      const current = citationsByMessage.get(citation.messageId) ?? [];
      const serialized = serializeStoredCitation(citation);
      if (serialized) current.push(serialized);
      citationsByMessage.set(citation.messageId, current);
    }

    return {
      ...conversation,
      title: conversation.title ?? "新对话",
      messages: orderConversationMessages(messageRows)
        .map((message) =>
          serializeStoredMessage(
            message,
            citationsByMessage.get(message.id) ?? []
          )
        )
        .filter(
          (message): message is ConversationDetail["messages"][number] =>
            message !== null
        )
    };
  },

  async createConversation(userId, title, audit) {
    const now = new Date();
    const id = crypto.randomUUID();

    return db.transaction(async (tx) => {
      const [created] = await tx
        .insert(conversations)
        .values({
          id,
          userId,
          title,
          summary: null,
          createdAt: now,
          updatedAt: now
        })
        .returning({
          id: conversations.id,
          title: conversations.title,
          summary: conversations.summary,
          createdAt: conversations.createdAt,
          updatedAt: conversations.updatedAt
        });

      await tx
        .insert(auditLogs)
        .values(auditValues(audit, "conversation.create", "conversation", id));

      return created as ConversationSummary;
    });
  },

  async renameConversation(userId, conversationId, title, audit) {
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(conversations)
        .set({ title, updatedAt: new Date() })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.userId, userId),
            ne(conversations.status, "deleted"),
            isNull(conversations.deletedAt)
          )
        )
        .returning({
          id: conversations.id,
          title: conversations.title,
          summary: conversations.summary,
          createdAt: conversations.createdAt,
          updatedAt: conversations.updatedAt
        });

      if (!updated) {
        return null;
      }

      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          "conversation.rename",
          "conversation",
          conversationId,
          {
            title
          }
        )
      );

      return { ...updated, title: updated.title ?? "新对话" };
    });
  },

  async deleteConversation(userId, conversationId, audit) {
    return db.transaction(async (tx) => {
      const [deleted] = await tx
        .update(conversations)
        .set({
          status: "deleted",
          deletedAt: new Date(),
          updatedAt: new Date()
        })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.userId, userId),
            ne(conversations.status, "deleted"),
            isNull(conversations.deletedAt)
          )
        )
        .returning({ id: conversations.id });

      if (!deleted) {
        return false;
      }

      await tx
        .insert(auditLogs)
        .values(
          auditValues(
            audit,
            "conversation.delete",
            "conversation",
            conversationId
          )
        );
      return true;
    });
  },

  async clearConversationData(userId, audit) {
    return db.transaction(async (tx) => {
      const conversationRows = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.userId, userId));
      const conversationIds = conversationRows.map((row) => row.id);
      const messageRows =
        conversationIds.length === 0
          ? []
          : await tx
              .select({ id: messages.id })
              .from(messages)
              .where(inArray(messages.conversationId, conversationIds));
      const messageIds = messageRows.map((row) => row.id);
      const citationIds =
        messageIds.length === 0
          ? []
          : (
              await tx
                .selectDistinct({ id: messageCitations.citationId })
                .from(messageCitations)
                .where(inArray(messageCitations.messageId, messageIds))
            ).map((row) => row.id);

      if (conversationIds.length > 0) {
        await tx.delete(conversations).where(eq(conversations.userId, userId));
      }

      if (citationIds.length > 0) {
        await tx.delete(citations).where(
          and(
            inArray(citations.id, citationIds),
            notExists(
              tx
                .select({ value: sql`1` })
                .from(messageCitations)
                .where(eq(messageCitations.citationId, citations.id))
            )
          )
        );
      }

      const result = {
        conversationsDeleted: conversationIds.length,
        messagesDeleted: messageIds.length,
        candidateCitationsDeleted: citationIds.length
      };
      await tx
        .insert(auditLogs)
        .values(
          auditValues(
            audit,
            "account.conversation_data.clear",
            "user",
            userId,
            result
          )
        );
      return result;
    });
  },

  async saveMessageFeedback(userId, messageId, input, audit) {
    if (!(await messageOwnedByUser(userId, messageId))) {
      return null;
    }

    const id = crypto.randomUUID();
    const now = new Date();

    return db.transaction(async (tx) => {
      const [saved] = await tx
        .insert(messageFeedback)
        .values({
          id,
          messageId,
          userId,
          kind: input.kind,
          rating: input.rating,
          reason: input.reason ?? null,
          comment: input.comment ?? null,
          status: "open",
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [
            messageFeedback.messageId,
            messageFeedback.userId,
            messageFeedback.kind
          ],
          set: {
            rating: input.rating,
            reason: input.reason ?? null,
            comment: input.comment ?? null,
            status: "open",
            updatedAt: now
          }
        })
        .returning({ id: messageFeedback.id, status: messageFeedback.status });

      await tx.insert(auditLogs).values(
        auditValues(audit, "message.feedback", "message", messageId, {
          rating: input.rating
        })
      );

      return saved;
    });
  },

  async reportMessage(userId, messageId, input, audit) {
    if (!(await messageOwnedByUser(userId, messageId))) {
      return null;
    }

    const id = crypto.randomUUID();
    const now = new Date();

    return db.transaction(async (tx) => {
      const [saved] = await tx
        .insert(messageFeedback)
        .values({
          id,
          messageId,
          userId,
          kind: input.kind,
          category: input.category,
          details: input.details ?? null,
          status: "open",
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [
            messageFeedback.messageId,
            messageFeedback.userId,
            messageFeedback.kind
          ],
          set: {
            category: input.category,
            details: input.details ?? null,
            status: "open",
            updatedAt: now
          }
        })
        .returning({ id: messageFeedback.id, status: messageFeedback.status });

      await tx.insert(auditLogs).values(
        auditValues(audit, "message.report", "message", messageId, {
          category: input.category
        })
      );

      return saved;
    });
  },

  async createProblemReport(userId, input, audit) {
    return db.transaction(async (tx) => {
      // Serialize submissions for one account across all application replicas.
      // This makes the replay check and sliding-window count one atomic gate.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 1967086383::bigint))`
      );

      const [replay] = await tx
        .select({
          id: problemReports.id,
          status: problemReports.status,
          createdAt: problemReports.createdAt
        })
        .from(problemReports)
        .where(
          and(
            eq(problemReports.userId, userId),
            eq(problemReports.clientRequestId, input.clientRequestId)
          )
        )
        .limit(1);
      if (replay) {
        return { ...replay, created: false };
      }

      const now = new Date();
      const windowStart = new Date(
        now.getTime() - PROBLEM_REPORT_SUBMISSION_WINDOW_MS
      );
      const [recentCount] = await tx
        .select({ value: count() })
        .from(problemReports)
        .where(
          and(
            eq(problemReports.userId, userId),
            gte(problemReports.createdAt, windowStart)
          )
        );
      if (Number(recentCount?.value ?? 0) >= PROBLEM_REPORT_SUBMISSION_LIMIT) {
        throw new ApiError(
          429,
          "PROBLEM_REPORT_RATE_LIMITED",
          "问题反馈提交过于频繁，请稍后再试。",
          {
            limit: PROBLEM_REPORT_SUBMISSION_LIMIT,
            windowSeconds: PROBLEM_REPORT_SUBMISSION_WINDOW_MS / 1000
          }
        );
      }

      let conversationId = input.conversationId;
      if (input.messageId) {
        const [ownedMessage] = await tx
          .select({
            id: messages.id,
            conversationId: messages.conversationId
          })
          .from(messages)
          .innerJoin(
            conversations,
            eq(messages.conversationId, conversations.id)
          )
          .where(
            and(
              eq(messages.id, input.messageId),
              eq(conversations.userId, userId),
              ne(conversations.status, "deleted"),
              isNull(conversations.deletedAt)
            )
          )
          .limit(1);

        if (
          !ownedMessage ||
          (conversationId && conversationId !== ownedMessage.conversationId)
        ) {
          return null;
        }
        conversationId = ownedMessage.conversationId;
      }

      let ownedConversation:
        { id: string; title: string; summary: string | null } | undefined;
      if (conversationId) {
        [ownedConversation] = await tx
          .select({
            id: conversations.id,
            title: conversations.title,
            summary: conversations.summary
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.userId, userId),
              ne(conversations.status, "deleted"),
              isNull(conversations.deletedAt)
            )
          )
          .limit(1);

        if (!ownedConversation) {
          return null;
        }
      }

      if (input.includeContext && !ownedConversation) {
        return null;
      }

      let context: Record<string, unknown> = {};
      if (input.includeContext && ownedConversation) {
        const recentMessages = await tx
          .select({
            id: messages.id,
            role: messages.role,
            content: messages.content,
            sequence: messages.sequence,
            createdAt: messages.createdAt
          })
          .from(messages)
          .where(eq(messages.conversationId, ownedConversation.id))
          .orderBy(desc(messages.sequence))
          .limit(8);

        context = {
          conversationId: ownedConversation.id,
          title: ownedConversation.title,
          summary: ownedConversation.summary,
          messages: serializeProblemReportContextMessages(recentMessages),
          capturedAt: now.toISOString()
        };
      }

      const id = crypto.randomUUID();
      const storedAssociations = storedProblemReportAssociations({
        includeContext: input.includeContext,
        conversationId,
        messageId: input.messageId
      });
      const [created] = await tx
        .insert(problemReports)
        .values({
          id,
          clientRequestId: input.clientRequestId,
          userId,
          conversationId: storedAssociations.conversationId,
          messageId: storedAssociations.messageId,
          category: input.category,
          description: input.description,
          includeContext: input.includeContext,
          context,
          contactType: input.contactType ?? null,
          contactValue: input.contactValue ?? null,
          consentToContact: input.consentToContact,
          status: "new",
          retentionUntil: problemReportRetentionUntil(now),
          createdAt: now,
          updatedAt: now
        })
        .returning({
          id: problemReports.id,
          status: problemReports.status,
          createdAt: problemReports.createdAt
        });

      await tx.insert(auditLogs).values(
        auditValues(audit, "problem_report.create", "problem_report", id, {
          conversationId: storedAssociations.conversationId,
          messageId: storedAssociations.messageId,
          category: input.category,
          includeContext: input.includeContext,
          hasContact: Boolean(input.contactValue)
        })
      );

      return { ...created, created: true };
    });
  },

  async listUsers(input) {
    const filters = [
      ...(input.query
        ? [
            or(
              ilike(users.name, queryPattern(input.query)),
              ilike(users.email, queryPattern(input.query))
            )
          ]
        : []),
      ...(input.status === "banned" ? [eq(users.banned, true)] : []),
      ...(input.status === "active" ? [eq(users.banned, false)] : [])
    ].filter((filter) => filter !== undefined);

    const where = filters.length > 0 ? and(...filters) : undefined;
    const [items, totalRows] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          banned: users.banned,
          banReason: users.banReason,
          banExpires: users.banExpires,
          dailyQuotaBonus: users.dailyQuotaBonus,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt
        })
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(input.pageSize)
        .offset(offset(input)),
      db.select({ value: count() }).from(users).where(where)
    ]);

    return pageResult(items, input, Number(totalRows[0]?.value ?? 0));
  },

  async setUserBan(userId, input, audit) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(1967086382)`);
      const actorRoles = await tx
        .select({ role: adminRoles.role })
        .from(adminRoles)
        .where(eq(adminRoles.userId, audit.actor.id));
      const targetRoles = await tx
        .select({ role: adminRoles.role })
        .from(adminRoles)
        .where(eq(adminRoles.userId, userId));
      const actorRole = assertUserMutationAllowed({
        actorUserId: audit.actor.id,
        actorRole: effectiveAdminRole(actorRoles),
        targetUserId: userId,
        targetRole: effectiveAdminRole(targetRoles),
        destructive: input.banned
      });
      const currentAudit = {
        ...audit,
        actor: { ...audit.actor, role: actorRole }
      };

      const [updated] = await tx
        .update(users)
        .set({
          banned: input.banned,
          banReason: input.banned ? (input.reason ?? null) : null,
          banExpires: input.banned ? (input.expiresAt ?? null) : null,
          updatedAt: new Date()
        })
        .where(eq(users.id, userId))
        .returning({
          id: users.id,
          banned: users.banned,
          banReason: users.banReason,
          banExpires: users.banExpires
        });

      if (!updated) {
        return null;
      }

      await tx.insert(auditLogs).values(
        auditValues(
          currentAudit,
          input.banned ? "user.ban" : "user.unban",
          "user",
          userId,
          {
            reason: input.reason ?? null,
            expiresAt: input.expiresAt?.toISOString() ?? null
          }
        )
      );
      return updated;
    });
  },

  async setUserQuotaBonus(userId, input, audit) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(1967086382)`);
      const actorRoles = await tx
        .select({ role: adminRoles.role })
        .from(adminRoles)
        .where(eq(adminRoles.userId, audit.actor.id));
      const targetRoles = await tx
        .select({ role: adminRoles.role })
        .from(adminRoles)
        .where(eq(adminRoles.userId, userId));
      const actorRole = assertUserMutationAllowed({
        actorUserId: audit.actor.id,
        actorRole: effectiveAdminRole(actorRoles),
        targetUserId: userId,
        targetRole: effectiveAdminRole(targetRoles),
        destructive: false
      });
      const currentAudit = {
        ...audit,
        actor: { ...audit.actor, role: actorRole }
      };

      const [updated] = await tx
        .update(users)
        .set({ dailyQuotaBonus: input.dailyBonus, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning({
          id: users.id,
          dailyQuotaBonus: users.dailyQuotaBonus
        });

      if (!updated) {
        return null;
      }

      await tx.insert(auditLogs).values(
        auditValues(currentAudit, "user.quota_bonus.update", "user", userId, {
          dailyBonus: input.dailyBonus,
          reason: input.reason
        })
      );
      return updated;
    });
  },

  async listFeedback(input) {
    const status = enumValue(
      ["open", "reviewing", "resolved", "dismissed"] as const,
      input.status
    );
    const filters = [
      ...(status ? [eq(messageFeedback.status, status)] : []),
      ...(input.query
        ? [
            or(
              ilike(messageFeedback.comment, queryPattern(input.query)),
              ilike(messageFeedback.reason, queryPattern(input.query)),
              ilike(messageFeedback.details, queryPattern(input.query)),
              ilike(messageFeedback.category, queryPattern(input.query))
            )
          ]
        : [])
    ];

    const [items, totalRows] = await Promise.all([
      db
        .select({
          id: messageFeedback.id,
          messageId: messageFeedback.messageId,
          userId: messageFeedback.userId,
          kind: messageFeedback.kind,
          rating: messageFeedback.rating,
          reason: messageFeedback.reason,
          comment: messageFeedback.comment,
          category: messageFeedback.category,
          details: messageFeedback.details,
          status: messageFeedback.status,
          adminNote: messageFeedback.adminNote,
          createdAt: messageFeedback.createdAt,
          updatedAt: messageFeedback.updatedAt
        })
        .from(messageFeedback)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(messageFeedback.createdAt))
        .limit(input.pageSize)
        .offset(offset(input)),
      db
        .select({ value: count() })
        .from(messageFeedback)
        .where(filters.length > 0 ? and(...filters) : undefined)
    ]);

    return pageResult(items, input, Number(totalRows[0]?.value ?? 0));
  },

  async setFeedbackStatus(feedbackId, input, audit) {
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(messageFeedback)
        .set({
          status: input.status,
          adminNote: input.note ?? null,
          updatedAt: new Date()
        })
        .where(eq(messageFeedback.id, feedbackId))
        .returning();

      if (!updated) {
        return null;
      }

      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          "message_feedback.status.update",
          "message_feedback",
          feedbackId,
          {
            status: input.status
          }
        )
      );
      return updated;
    });
  },

  async listAdminProblemReports(input, audit) {
    const status = enumValue(
      ["new", "reviewing", "closed"] as const,
      input.status
    );
    const filters = [
      ...(status ? [eq(problemReports.status, status)] : []),
      ...(input.query
        ? [
            or(
              ilike(problemReports.description, queryPattern(input.query)),
              ilike(problemReports.contactValue, queryPattern(input.query))
            )
          ]
        : [])
    ].filter((filter) => filter !== undefined);

    const where = filters.length > 0 ? and(...filters) : undefined;
    return db.transaction(async (tx) => {
      const [items, totalRows] = await Promise.all([
        tx
          .select()
          .from(problemReports)
          .where(where)
          .orderBy(desc(problemReports.createdAt))
          .limit(input.pageSize)
          .offset(offset(input)),
        tx.select({ value: count() }).from(problemReports).where(where)
      ]);

      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          "problem_report.list.view",
          "problem_report",
          "collection",
          {
            page: input.page,
            pageSize: input.pageSize,
            status: status ?? null,
            searched: Boolean(input.query)
          }
        )
      );

      return pageResult(items, input, Number(totalRows[0]?.value ?? 0));
    });
  },

  async setProblemReportStatus(problemReportId, input, audit) {
    return db.transaction(async (tx) => {
      const now = new Date();
      const [existing] = await tx
        .select({
          status: problemReports.status,
          closedAt: problemReports.closedAt,
          contactPurgeAt: problemReports.contactPurgeAt
        })
        .from(problemReports)
        .where(eq(problemReports.id, problemReportId))
        .limit(1)
        .for("update");
      if (!existing) {
        return null;
      }
      const closure = problemReportClosureTransition({
        previousStatus: existing.status,
        previousClosedAt: existing.closedAt,
        previousContactPurgeAt: existing.contactPurgeAt,
        nextStatus: input.status,
        now
      });
      const [updated] = await tx
        .update(problemReports)
        .set({
          status: input.status,
          adminNote: input.note ?? null,
          closedAt: closure.closedAt,
          contactPurgeAt: closure.contactPurgeAt,
          updatedAt: now
        })
        .where(eq(problemReports.id, problemReportId))
        .returning();

      if (!updated) {
        return null;
      }

      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          "problem_report.status.update",
          "problem_report",
          problemReportId,
          {
            status: input.status
          }
        )
      );
      return updated;
    });
  },

  async listKnowledgeDocuments(input) {
    const status = enumValue(
      [
        "draft",
        "processing",
        "review",
        "published",
        "failed",
        "archived"
      ] as const,
      input.status
    );
    const filters = [
      ...(status ? [eq(knowledgeDocuments.status, status)] : []),
      ...(input.query
        ? [ilike(knowledgeDocuments.title, queryPattern(input.query))]
        : [])
    ];

    const [items, totalRows] = await Promise.all([
      db
        .select()
        .from(knowledgeDocuments)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(knowledgeDocuments.updatedAt))
        .limit(input.pageSize)
        .offset(offset(input)),
      db
        .select({ value: count() })
        .from(knowledgeDocuments)
        .where(filters.length > 0 ? and(...filters) : undefined)
    ]);

    const enriched = await Promise.all(
      items.map((document) => loadKnowledgeDocumentView(document, false))
    );
    return pageResult(enriched, input, Number(totalRows[0]?.value ?? 0));
  },

  async getKnowledgeDocument(documentId) {
    const [document] = await db
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId))
      .limit(1);
    return document ? loadKnowledgeDocumentView(document, true) : null;
  },

  async createKnowledgeDraft(input, audit) {
    const documentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const now = new Date();

    return db.transaction(async (tx) => {
      await tx.insert(knowledgeDocuments).values({
        id: documentId,
        title: input.title,
        sourceId: input.sourceId ?? null,
        status: "draft",
        currentVersionId: versionId,
        createdBy: audit.actor.id,
        createdAt: now,
        updatedAt: now
      });

      await tx.insert(knowledgeVersions).values({
        id: versionId,
        documentId,
        version: 1,
        contentHash: sha256KnowledgeContent(input.content),
        content: input.content,
        citationMetadata: {
          ...input.citationMetadata,
          ingestionMode: input.ingestionMode
        },
        status: "draft",
        metadata: {
          reviewStatus: "required",
          embeddingStatus: "pending_review"
        },
        createdBy: audit.actor.id,
        createdAt: now,
        updatedAt: now
      });

      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          "knowledge.draft.create",
          "knowledge_document",
          documentId,
          {
            versionId,
            sourceId: input.sourceId ?? null
          }
        )
      );

      const [created] = await tx
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, documentId))
        .limit(1);
      return created;
    });
  },

  async updateKnowledgeDraft(documentId, input, audit) {
    return db.transaction(async (tx) => {
      const [document] = await tx
        .select({
          id: knowledgeDocuments.id,
          status: knowledgeDocuments.status,
          sourceId: knowledgeDocuments.sourceId,
          currentVersionId: knowledgeDocuments.currentVersionId
        })
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, documentId))
        .limit(1);

      if (
        !document ||
        (document.status !== "draft" && document.status !== "review") ||
        !document.currentVersionId
      ) {
        return null;
      }

      const [currentVersion] = await tx
        .select()
        .from(knowledgeVersions)
        .where(eq(knowledgeVersions.id, document.currentVersionId))
        .limit(1)
        .for("update");
      if (
        !currentVersion ||
        currentVersion.documentId !== documentId ||
        (currentVersion.status !== "draft" &&
          currentVersion.status !== "review")
      ) {
        return null;
      }

      const now = new Date();
      const previousContentHash =
        currentVersion.contentHash ??
        sha256KnowledgeContent(currentVersion.content);
      const nextContentHash =
        input.content === undefined
          ? previousContentHash
          : sha256KnowledgeContent(input.content);
      const hashTransition = invalidateKnowledgeReviewAfterHashChange({
        metadata: currentVersion.metadata,
        previousContentHash,
        nextContentHash,
        invalidatedBy: audit.actor.id,
        invalidatedAt: now
      });
      const evidenceMetadataChanged = knowledgeEvidenceMetadataChanged({
        currentSourceId: document.sourceId,
        nextSourceId: input.sourceId,
        ingestionModeProvided: input.ingestionMode !== undefined,
        citationMetadataProvided: input.citationMetadata !== undefined
      });
      const reviewInvalidated =
        hashTransition.invalidated || evidenceMetadataChanged;

      const documentPatch: Partial<typeof knowledgeDocuments.$inferInsert> = {
        updatedAt: now,
        ...(reviewInvalidated ? { status: "draft" } : {})
      };
      if (input.title !== undefined) documentPatch.title = input.title;
      if (input.sourceId !== undefined) documentPatch.sourceId = input.sourceId;

      const versionPatch: Partial<typeof knowledgeVersions.$inferInsert> = {
        updatedAt: now,
        ...(reviewInvalidated ? { status: "draft" } : {})
      };
      if (input.content !== undefined) {
        versionPatch.content = input.content;
        versionPatch.contentHash = nextContentHash;
      }
      if (input.citationMetadata !== undefined) {
        versionPatch.citationMetadata = {
          ...input.citationMetadata,
          ...(input.ingestionMode ? { ingestionMode: input.ingestionMode } : {})
        };
      } else if (input.ingestionMode !== undefined) {
        versionPatch.citationMetadata = {
          ...currentVersion.citationMetadata,
          ingestionMode: input.ingestionMode
        };
      }
      if (reviewInvalidated) {
        const existingReview = recordValue(
          hashTransition.metadata.review ?? currentVersion.metadata.review
        );
        versionPatch.metadata = evidenceMetadataChanged
          ? {
              ...hashTransition.metadata,
              reviewStatus: "required",
              embeddingStatus: "pending_review",
              ...(Object.keys(existingReview).length > 0
                ? {
                    review: {
                      ...existingReview,
                      status: "invalidated",
                      invalidatedAt: now.toISOString(),
                      invalidatedBy: audit.actor.id,
                      invalidatedReason: hashTransition.invalidated
                        ? "content_hash_and_evidence_metadata_changed"
                        : "evidence_metadata_changed"
                    }
                  }
                : {})
            }
          : hashTransition.metadata;
      }

      await tx
        .update(knowledgeDocuments)
        .set(documentPatch)
        .where(eq(knowledgeDocuments.id, documentId));
      await tx
        .update(knowledgeVersions)
        .set(versionPatch)
        .where(eq(knowledgeVersions.id, document.currentVersionId));

      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          "knowledge.draft.update",
          "knowledge_document",
          documentId,
          {
            versionId: document.currentVersionId,
            changedFields: Object.keys(input),
            reviewInvalidated,
            previousContentHash,
            nextContentHash
          }
        )
      );

      const [updated] = await tx
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, documentId))
        .limit(1);
      return updated;
    });
  },

  async reviewKnowledgeDocument(
    documentId,
    input: KnowledgeReviewInput,
    audit
  ) {
    const reviewed = await db.transaction(async (tx) => {
      const [document] = await tx
        .select({
          id: knowledgeDocuments.id,
          status: knowledgeDocuments.status,
          sourceId: knowledgeDocuments.sourceId,
          currentVersionId: knowledgeDocuments.currentVersionId
        })
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, documentId))
        .limit(1)
        .for("update");
      if (!document) return null;
      if (
        !document.currentVersionId ||
        (document.status !== "draft" && document.status !== "review")
      ) {
        throw new ApiError(
          409,
          "KNOWLEDGE_REVIEW_STATE_INVALID",
          "只有当前草稿或待复核版本可以完成人工复核。"
        );
      }

      const [version] = await tx
        .select()
        .from(knowledgeVersions)
        .where(eq(knowledgeVersions.id, document.currentVersionId))
        .limit(1)
        .for("update");
      if (!version || version.documentId !== documentId) {
        return null;
      }
      if (version.status !== "draft" && version.status !== "review") {
        throw new ApiError(
          409,
          "KNOWLEDGE_REVIEW_STATE_INVALID",
          "当前知识版本不能完成人工复核。"
        );
      }

      const now = new Date();
      const transition = buildKnowledgeReviewTransition({
        documentId,
        versionId: document.currentVersionId,
        expectedVersionId: input.versionId,
        content: version.content,
        storedContentHash: version.contentHash,
        expectedContentHash: input.expectedContentHash,
        ingestionMode: version.citationMetadata.ingestionMode,
        reviewerId: audit.actor.id,
        reviewedAt: now,
        decision: input.decision,
        note: input.note
      });
      const [source] = document.sourceId
        ? await tx
            .select({
              sourceTier: knowledgeSources.sourceTier,
              enabled: knowledgeSources.enabled,
              deletedAt: knowledgeSources.deletedAt,
              canonicalUrl: knowledgeSources.canonicalUrl,
              publisher: knowledgeSources.publisher,
              metadata: knowledgeSources.metadata
            })
            .from(knowledgeSources)
            .where(eq(knowledgeSources.id, document.sourceId))
            .limit(1)
        : [];
      if (input.decision === "approved") {
        assertPublishableKnowledgeSource(
          source,
          version.citationMetadata,
          "发布"
        );
      }
      const existingReview = recordValue(version.metadata.review);
      const existingEmbeddingMatchesReview =
        existingKnowledgeEmbeddingMatchesReview({
          ingestionMode: version.citationMetadata.ingestionMode,
          reviewedContentHash: existingReview.contentHash,
          nextContentHash: transition.contentHash
        });
      const [existingChunkResult] = existingEmbeddingMatchesReview
        ? await tx
            .select({
              total: count(),
              embedded: sql<number>`count(*) filter (where ${knowledgeChunks.embedding} is not null and ${knowledgeChunks.embeddedAt} is not null)`
            })
            .from(knowledgeChunks)
            .where(eq(knowledgeChunks.versionId, version.id))
        : [];
      const preserveCompletedEmbedding =
        existingEmbeddingMatchesReview &&
        hasCompleteKnowledgeEmbeddingSet({
          totalChunks: Number(existingChunkResult?.total ?? 0),
          embeddedChunks: Number(existingChunkResult?.embedded ?? 0)
        });
      const embeddingStatus = preserveCompletedEmbedding
        ? "completed"
        : transition.embeddingStatus;
      const metadata = {
        ...version.metadata,
        reviewStatus: transition.review.status,
        embeddingStatus,
        review: transition.review
      };

      await tx
        .update(knowledgeVersions)
        .set({
          status: transition.versionStatus,
          contentHash: transition.contentHash,
          metadata,
          updatedAt: now
        })
        .where(eq(knowledgeVersions.id, document.currentVersionId));
      await tx
        .update(knowledgeDocuments)
        .set({ status: transition.documentStatus, updatedAt: now })
        .where(eq(knowledgeDocuments.id, documentId));

      if (transition.task && !preserveCompletedEmbedding) {
        await tx
          .insert(backgroundTasks)
          .values({
            id: crypto.randomUUID(),
            type: "knowledge_ingestion",
            status: "queued",
            priority: 10,
            idempotencyKey: transition.task.idempotencyKey,
            payload: transition.task.payload,
            attempts: 0,
            maxAttempts: 3,
            runAt: now,
            createdByUserId: audit.actor.id,
            createdAt: now,
            updatedAt: now
          })
          .onConflictDoNothing({
            target: backgroundTasks.idempotencyKey
          });
      }

      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          input.decision === "approved"
            ? "knowledge.review.approve"
            : "knowledge.review.reject",
          "knowledge_document",
          documentId,
          {
            versionId: document.currentVersionId,
            contentHash: transition.contentHash,
            embeddingStatus,
            noteProvided: Boolean(input.note)
          }
        )
      );
      return { documentId };
    });

    if (!reviewed) return null;
    return this.getKnowledgeDocument(documentId);
  },

  async publishKnowledgeDraft(documentId, audit) {
    return db.transaction(async (tx) => {
      const [document] = await tx
        .select({
          id: knowledgeDocuments.id,
          currentVersionId: knowledgeDocuments.currentVersionId,
          status: knowledgeDocuments.status,
          sourceId: knowledgeDocuments.sourceId
        })
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, documentId))
        .limit(1)
        .for("update");

      if (!document?.currentVersionId) {
        return null;
      }

      const now = new Date();
      const [version] = await tx
        .select({
          status: knowledgeVersions.status,
          content: knowledgeVersions.content,
          contentHash: knowledgeVersions.contentHash,
          citationMetadata: knowledgeVersions.citationMetadata,
          metadata: knowledgeVersions.metadata
        })
        .from(knowledgeVersions)
        .where(eq(knowledgeVersions.id, document.currentVersionId))
        .limit(1)
        .for("update");
      if (!version) {
        return null;
      }
      const [chunkResult] = await tx
        .select({ value: count() })
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.versionId, document.currentVersionId));
      const chunkCount = Number(chunkResult?.value ?? 0);

      assertKnowledgePublicationGate({
        documentStatus: document.status,
        versionStatus: version.status,
        content: version.content,
        contentHash: version.contentHash,
        citationMetadata: version.citationMetadata,
        metadata: version.metadata,
        chunkCount
      });

      const [source] = document.sourceId
        ? await tx
            .select({
              sourceTier: knowledgeSources.sourceTier,
              enabled: knowledgeSources.enabled,
              deletedAt: knowledgeSources.deletedAt,
              canonicalUrl: knowledgeSources.canonicalUrl,
              publisher: knowledgeSources.publisher,
              metadata: knowledgeSources.metadata
            })
            .from(knowledgeSources)
            .where(eq(knowledgeSources.id, document.sourceId))
            .limit(1)
        : [];
      assertPublishableKnowledgeSource(
        source,
        version.citationMetadata,
        "发布"
      );

      const [publishedVersion] = await tx
        .update(knowledgeVersions)
        .set({ status: "published", publishedAt: now, updatedAt: now })
        .where(
          and(
            eq(knowledgeVersions.id, document.currentVersionId),
            eq(knowledgeVersions.status, "review")
          )
        )
        .returning({ id: knowledgeVersions.id });
      if (!publishedVersion) {
        throw new ApiError(
          409,
          "KNOWLEDGE_PUBLISH_CONFLICT",
          "知识版本状态已变化，请刷新后重试。"
        );
      }
      const [published] = await tx
        .update(knowledgeDocuments)
        .set({ status: "published", updatedAt: now })
        .where(
          and(
            eq(knowledgeDocuments.id, documentId),
            eq(knowledgeDocuments.currentVersionId, document.currentVersionId),
            eq(knowledgeDocuments.status, "review")
          )
        )
        .returning();

      if (!published) {
        throw new ApiError(
          409,
          "KNOWLEDGE_PUBLISH_CONFLICT",
          "知识文档状态已变化，请刷新后重试。"
        );
      }
      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          "knowledge.publish",
          "knowledge_document",
          documentId,
          {
            versionId: document.currentVersionId
          }
        )
      );
      return published;
    });
  },

  async archiveKnowledgeDocument(documentId, audit) {
    const archived = await db.transaction(async (tx) => {
      const [document] = await tx
        .select({
          id: knowledgeDocuments.id,
          status: knowledgeDocuments.status,
          currentVersionId: knowledgeDocuments.currentVersionId
        })
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, documentId))
        .limit(1)
        .for("update");
      if (!document) return null;
      if (document.status === "archived") {
        return { id: document.id, unchanged: true };
      }

      const now = new Date();
      if (document.currentVersionId) {
        await tx
          .update(knowledgeVersions)
          .set({ status: "archived", updatedAt: now })
          .where(eq(knowledgeVersions.id, document.currentVersionId));
      }
      const [updated] = await tx
        .update(knowledgeDocuments)
        .set({ status: "archived", updatedAt: now })
        .where(
          and(
            eq(knowledgeDocuments.id, documentId),
            eq(knowledgeDocuments.status, document.status)
          )
        )
        .returning({ id: knowledgeDocuments.id });
      if (!updated) {
        throw new ApiError(
          409,
          "KNOWLEDGE_ARCHIVE_CONFLICT",
          "知识文档状态已变化，请刷新后重试。"
        );
      }

      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          "knowledge.archive",
          "knowledge_document",
          documentId,
          {
            versionId: document.currentVersionId,
            previousStatus: document.status
          }
        )
      );
      return { id: updated.id, unchanged: false };
    });

    if (!archived) return null;
    return this.getKnowledgeDocument(documentId);
  },

  async rollbackKnowledgeDocument(documentId, versionId, audit) {
    return db.transaction(async (tx) => {
      const [document] = await tx
        .select({
          id: knowledgeDocuments.id,
          sourceId: knowledgeDocuments.sourceId,
          status: knowledgeDocuments.status,
          currentVersionId: knowledgeDocuments.currentVersionId
        })
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.id, documentId))
        .limit(1)
        .for("update");
      if (!document) {
        return null;
      }
      if (document.status !== "published" || !document.currentVersionId) {
        throw new ApiError(
          409,
          "ROLLBACK_REQUIRES_PUBLISHED_DOCUMENT",
          "只能对当前已发布的知识文档执行回滚。"
        );
      }

      const [target] = await tx
        .select()
        .from(knowledgeVersions)
        .where(
          and(
            eq(knowledgeVersions.id, versionId),
            eq(knowledgeVersions.documentId, documentId)
          )
        )
        .limit(1)
        .for("update");

      if (!target) {
        return null;
      }
      assertHistoricalRollbackTarget({
        targetVersionId: target.id,
        currentVersionId: document.currentVersionId,
        status: target.status,
        publishedAt: target.publishedAt
      });

      const [targetChunkResult] = await tx
        .select({ value: count() })
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.versionId, target.id));
      assertReviewedKnowledgeEvidence({
        content: target.content,
        contentHash: target.contentHash,
        citationMetadata: target.citationMetadata,
        metadata: target.metadata,
        chunkCount: Number(targetChunkResult?.value ?? 0)
      });

      const [source] = document.sourceId
        ? await tx
            .select({
              sourceTier: knowledgeSources.sourceTier,
              enabled: knowledgeSources.enabled,
              deletedAt: knowledgeSources.deletedAt,
              canonicalUrl: knowledgeSources.canonicalUrl,
              publisher: knowledgeSources.publisher,
              metadata: knowledgeSources.metadata
            })
            .from(knowledgeSources)
            .where(eq(knowledgeSources.id, document.sourceId))
            .limit(1)
        : [];
      assertPublishableKnowledgeSource(
        source,
        target.citationMetadata,
        "回滚发布"
      );

      const [maxVersion] = await tx
        .select({
          value: sql<number>`coalesce(max(${knowledgeVersions.version}), 0)`
        })
        .from(knowledgeVersions)
        .where(eq(knowledgeVersions.documentId, documentId));

      const newVersionId = crypto.randomUUID();
      const now = new Date();
      await tx
        .update(knowledgeVersions)
        .set({ status: "archived", updatedAt: now })
        .where(
          and(
            eq(knowledgeVersions.documentId, documentId),
            eq(knowledgeVersions.status, "published")
          )
        );
      await tx.insert(knowledgeVersions).values({
        id: newVersionId,
        documentId,
        version: Number(maxVersion?.value ?? 0) + 1,
        contentHash: target.contentHash,
        content: target.content,
        citationMetadata: target.citationMetadata,
        objectKey: target.objectKey,
        parserVersion: target.parserVersion,
        sourceUpdatedAt: target.sourceUpdatedAt,
        metadata: target.metadata,
        status: "published",
        createdBy: audit.actor.id,
        publishedAt: now,
        createdAt: now,
        updatedAt: now
      });
      await tx.execute(sql`
        INSERT INTO ${knowledgeChunks} (
          version_id,
          chunk_index,
          content,
          token_count,
          page_start,
          page_end,
          section_path,
          metadata,
          embedding,
          embedding_model,
          embedded_at,
          created_at
        )
        SELECT
          ${newVersionId},
          ${knowledgeChunks.chunkIndex},
          ${knowledgeChunks.content},
          ${knowledgeChunks.tokenCount},
          ${knowledgeChunks.pageStart},
          ${knowledgeChunks.pageEnd},
          ${knowledgeChunks.sectionPath},
          ${knowledgeChunks.metadata},
          ${knowledgeChunks.embedding},
          ${knowledgeChunks.embeddingModel},
          ${knowledgeChunks.embeddedAt},
          ${now}
        FROM ${knowledgeChunks}
        WHERE ${knowledgeChunks.versionId} = ${target.id}
      `);
      const [updated] = await tx
        .update(knowledgeDocuments)
        .set({
          currentVersionId: newVersionId,
          status: "published",
          updatedAt: now
        })
        .where(
          and(
            eq(knowledgeDocuments.id, documentId),
            eq(knowledgeDocuments.currentVersionId, document.currentVersionId),
            eq(knowledgeDocuments.status, "published")
          )
        )
        .returning();

      if (!updated) {
        throw new ApiError(
          409,
          "KNOWLEDGE_ROLLBACK_CONFLICT",
          "知识文档状态已变化，请刷新后重试。"
        );
      }

      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          "knowledge.rollback",
          "knowledge_document",
          documentId,
          {
            sourceVersionId: versionId,
            newVersionId
          }
        )
      );
      return updated;
    });
  },

  async listSources(input) {
    const filters = [
      isNull(knowledgeSources.deletedAt),
      ...(input.status === "enabled"
        ? [eq(knowledgeSources.enabled, true)]
        : []),
      ...(input.status === "disabled"
        ? [eq(knowledgeSources.enabled, false)]
        : []),
      ...(input.query
        ? [ilike(knowledgeSources.name, queryPattern(input.query))]
        : [])
    ];

    const [items, totalRows] = await Promise.all([
      db
        .select()
        .from(knowledgeSources)
        .where(and(...filters))
        .orderBy(asc(knowledgeSources.name))
        .limit(input.pageSize)
        .offset(offset(input)),
      db
        .select({ value: count() })
        .from(knowledgeSources)
        .where(and(...filters))
    ]);

    return pageResult(
      items.map(sourceAdminTableShape),
      input,
      Number(totalRows[0]?.value ?? 0)
    );
  },

  async createSource(input, audit) {
    const id = crypto.randomUUID();
    const now = new Date();
    assertSourceRightsMutationAllowed(
      audit,
      input.rightsDecision !== undefined
    );

    return db.transaction(async (tx) => {
      const [created] = await tx
        .insert(knowledgeSources)
        .values({
          id,
          kind: input.kind,
          name: input.name,
          publisher: input.publisher,
          canonicalUrl: input.canonicalUrl,
          baseUrl: input.baseUrl,
          sourceTier: input.sourceTier,
          licensePolicy: input.licensePolicy,
          metadata: input.rightsDecision
            ? {
                rightsDecision: reviewedRightsDecision(
                  input.rightsDecision,
                  input.canonicalUrl,
                  audit,
                  now
                )
              }
            : {},
          notes: input.notes ?? null,
          enabled: input.enabled,
          createdBy: audit.actor.id,
          createdAt: now,
          updatedAt: now
        })
        .returning();

      await tx.insert(auditLogs).values(
        auditValues(audit, "knowledge_source.create", "knowledge_source", id, {
          sourceTier: input.sourceTier,
          kind: input.kind,
          rightsDecisionRecorded: input.rightsDecision !== undefined
        })
      );
      return created;
    });
  },

  async updateSource(sourceId, input, audit) {
    assertSourceRightsMutationAllowed(
      audit,
      input.rightsDecision !== undefined
    );

    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          canonicalUrl: knowledgeSources.canonicalUrl,
          metadata: knowledgeSources.metadata
        })
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.id, sourceId),
            isNull(knowledgeSources.deletedAt)
          )
        )
        .limit(1)
        .for("update");
      if (!existing) return null;

      const patch: Partial<typeof knowledgeSources.$inferInsert> = {
        updatedAt: new Date()
      };
      if (input.kind !== undefined) patch.kind = input.kind;
      if (input.name !== undefined) patch.name = input.name;
      if (input.publisher !== undefined) patch.publisher = input.publisher;
      if (input.canonicalUrl !== undefined)
        patch.canonicalUrl = input.canonicalUrl;
      if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl;
      if (input.sourceTier !== undefined) patch.sourceTier = input.sourceTier;
      if (input.licensePolicy !== undefined)
        patch.licensePolicy = input.licensePolicy;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.rightsDecision !== undefined) {
        const canonicalUrl = input.canonicalUrl ?? existing.canonicalUrl;
        if (!canonicalUrl) {
          throw new ApiError(
            409,
            "SOURCE_CANONICAL_URL_REQUIRED",
            "记录权利决定前必须设置 canonicalUrl。"
          );
        }
        patch.metadata = {
          ...existing.metadata,
          rightsDecision: reviewedRightsDecision(
            input.rightsDecision,
            canonicalUrl,
            audit,
            new Date()
          )
        };
      }

      const [updated] = await tx
        .update(knowledgeSources)
        .set(patch)
        .where(
          and(
            eq(knowledgeSources.id, sourceId),
            isNull(knowledgeSources.deletedAt)
          )
        )
        .returning();

      if (!updated) {
        return null;
      }

      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          "knowledge_source.update",
          "knowledge_source",
          sourceId,
          {
            changedFields: Object.keys(input)
          }
        )
      );
      return updated;
    });
  },

  async deleteSource(sourceId, audit) {
    return db.transaction(async (tx) => {
      const [deleted] = await tx
        .update(knowledgeSources)
        .set({ enabled: false, deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(knowledgeSources.id, sourceId),
            isNull(knowledgeSources.deletedAt)
          )
        )
        .returning({ id: knowledgeSources.id });

      if (!deleted) {
        return false;
      }

      await tx
        .insert(auditLogs)
        .values(
          auditValues(
            audit,
            "knowledge_source.delete",
            "knowledge_source",
            sourceId
          )
        );
      return true;
    });
  },

  async listPrompts(input) {
    const status = enumValue(
      ["draft", "active", "archived"] as const,
      input.status
    );
    const filters = [
      ...(status ? [eq(promptVersions.status, status)] : []),
      ...(input.query
        ? [ilike(promptVersions.key, queryPattern(input.query))]
        : [])
    ];

    const [items, totalRows] = await Promise.all([
      db
        .select()
        .from(promptVersions)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(asc(promptVersions.key), desc(promptVersions.version))
        .limit(input.pageSize)
        .offset(offset(input)),
      db
        .select({ value: count() })
        .from(promptVersions)
        .where(filters.length > 0 ? and(...filters) : undefined)
    ]);

    return pageResult(
      items.map(promptAdminTableShape),
      input,
      Number(totalRows[0]?.value ?? 0)
    );
  },

  async createPromptVersion(input, audit) {
    return db.transaction(async (tx) => {
      const [maxVersion] = await tx
        .select({
          value: sql<number>`coalesce(max(${promptVersions.version}), 0)`
        })
        .from(promptVersions)
        .where(eq(promptVersions.key, input.key));

      const id = crypto.randomUUID();
      const [created] = await tx
        .insert(promptVersions)
        .values({
          id,
          key: input.key,
          version: Number(maxVersion?.value ?? 0) + 1,
          content: input.content,
          notes: input.notes ?? null,
          status: "draft",
          createdBy: audit.actor.id,
          createdAt: new Date(),
          updatedAt: new Date()
        })
        .returning();

      await tx.insert(auditLogs).values(
        auditValues(audit, "prompt_version.create", "prompt_version", id, {
          key: input.key,
          version: created.version
        })
      );
      return created;
    });
  },

  async updatePromptVersion(promptId, input, audit) {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(promptVersions)
        .where(eq(promptVersions.id, promptId))
        .limit(1);

      if (!current) {
        return null;
      }

      if (input.status === "active") {
        await tx
          .update(promptVersions)
          .set({ status: "archived", updatedAt: new Date() })
          .where(
            and(
              eq(promptVersions.key, current.key),
              eq(promptVersions.status, "active")
            )
          );
      }

      const patch: Partial<typeof promptVersions.$inferInsert> = {
        updatedAt: new Date()
      };
      if (input.content !== undefined) patch.content = input.content;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.status !== undefined) {
        patch.status = input.status;
        patch.publishedAt = input.status === "active" ? new Date() : null;
      }

      const [updated] = await tx
        .update(promptVersions)
        .set(patch)
        .where(eq(promptVersions.id, promptId))
        .returning();

      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          "prompt_version.update",
          "prompt_version",
          promptId,
          {
            key: current.key,
            status: input.status ?? current.status,
            changedFields: Object.keys(input)
          }
        )
      );
      return updated;
    });
  },

  async getBudgets() {
    const [setting] = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, "model_budgets"))
      .limit(1);

    return Array.isArray(setting?.value)
      ? (setting.value as ModelBudgetInput[])
      : [];
  },

  async updateBudgets(input, audit) {
    return db.transaction(async (tx) => {
      await tx
        .insert(systemSettings)
        .values({
          key: "model_budgets",
          value: input,
          updatedBy: audit.actor.id,
          updatedAt: new Date()
        })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: {
            value: input,
            updatedBy: audit.actor.id,
            updatedAt: new Date()
          }
        });

      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          "model_budgets.update",
          "system_setting",
          "model_budgets",
          {
            models: input.map((budget) => budget.model)
          }
        )
      );
      return input;
    });
  },

  async getSettings() {
    const rows = await db
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings)
      .where(
        and(
          eq(systemSettings.isSecret, false),
          ne(systemSettings.key, "model_budgets")
        )
      );

    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  },

  async updateSettings(input, audit) {
    return db.transaction(async (tx) => {
      const keys = Object.keys(input);
      const secretRows =
        keys.length === 0
          ? []
          : await tx
              .select({ key: systemSettings.key })
              .from(systemSettings)
              .where(
                and(
                  inArray(systemSettings.key, keys),
                  eq(systemSettings.isSecret, true)
                )
              );
      if (secretRows.length > 0) {
        throw new ApiError(
          403,
          "SECRET_SETTING_FORBIDDEN",
          "密钥类设置不能通过通用设置接口读取或修改。"
        );
      }

      for (const [key, value] of Object.entries(input)) {
        await tx
          .insert(systemSettings)
          .values({
            key,
            value,
            updatedBy: audit.actor.id,
            updatedAt: new Date()
          })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: {
              value,
              updatedBy: audit.actor.id,
              updatedAt: new Date()
            },
            setWhere: eq(systemSettings.isSecret, false)
          });
      }

      await tx.insert(auditLogs).values(
        auditValues(audit, "system_settings.update", "system_setting", "bulk", {
          keys: Object.keys(input)
        })
      );
      return input;
    });
  },

  async getMetrics(input) {
    const [
      usage,
      userCount,
      conversationCount,
      openProblemReportCount,
      openFeedbackCount
    ] = await Promise.all([
      db
        .select({
          requests: sql<number>`coalesce(sum(${dailyUsage.requestCount}), 0)`,
          inputTokens: sql<number>`coalesce(sum(${dailyUsage.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${dailyUsage.outputTokens}), 0)`,
          costCents: sql<number>`coalesce(sum(${dailyUsage.costCents}), 0)`
        })
        .from(dailyUsage)
        .where(
          and(gte(dailyUsage.date, input.from), lte(dailyUsage.date, input.to))
        ),
      db.select({ value: count() }).from(users),
      db
        .select({ value: count() })
        .from(conversations)
        .where(
          and(
            isNull(conversations.deletedAt),
            gte(conversations.createdAt, input.from),
            lte(conversations.createdAt, input.to)
          )
        ),
      db
        .select({ value: count() })
        .from(problemReports)
        .where(
          and(
            inArray(problemReports.status, ["new", "reviewing"]),
            gte(problemReports.createdAt, input.from),
            lte(problemReports.createdAt, input.to)
          )
        ),
      db
        .select({ value: count() })
        .from(messageFeedback)
        .where(eq(messageFeedback.status, "open"))
    ]);

    return {
      range: {
        from: input.from.toISOString(),
        to: input.to.toISOString()
      },
      users: Number(userCount[0]?.value ?? 0),
      conversations: Number(conversationCount[0]?.value ?? 0),
      openProblemReports: Number(openProblemReportCount[0]?.value ?? 0),
      openFeedback: Number(openFeedbackCount[0]?.value ?? 0),
      usage: {
        requests: Number(usage[0]?.requests ?? 0),
        inputTokens: Number(usage[0]?.inputTokens ?? 0),
        outputTokens: Number(usage[0]?.outputTokens ?? 0),
        costCents: Number(usage[0]?.costCents ?? 0)
      }
    };
  },

  async listAuditLogs(input, viewerRole) {
    const policy = auditLogReadPolicy(viewerRole);
    const query = input.query ? queryPattern(input.query) : undefined;
    const searchFilter = query
      ? !policy.searchableFields.includes("targetId")
        ? or(ilike(auditLogs.action, query), ilike(auditLogs.targetType, query))
        : or(
            ilike(auditLogs.action, query),
            ilike(auditLogs.targetType, query),
            ilike(auditLogs.targetId, query)
          )
      : undefined;

    if (policy.redacted) {
      const [items, totalRows] = await Promise.all([
        db
          .select({
            id: auditLogs.id,
            actorRole: auditLogs.actorRole,
            action: auditLogs.action,
            targetType: auditLogs.targetType,
            createdAt: auditLogs.createdAt
          })
          .from(auditLogs)
          .where(searchFilter)
          .orderBy(desc(auditLogs.createdAt))
          .limit(input.pageSize)
          .offset(offset(input)),
        db.select({ value: count() }).from(auditLogs).where(searchFilter)
      ]);
      return pageResult(items, input, Number(totalRows[0]?.value ?? 0));
    }

    const [items, totalRows] = await Promise.all([
      db
        .select()
        .from(auditLogs)
        .where(searchFilter)
        .orderBy(desc(auditLogs.createdAt))
        .limit(input.pageSize)
        .offset(offset(input)),
      db.select({ value: count() }).from(auditLogs).where(searchFilter)
    ]);
    return pageResult(items, input, Number(totalRows[0]?.value ?? 0));
  }
};
