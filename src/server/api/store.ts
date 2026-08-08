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
import { recoverStaleAgentRuns } from "@/server/agent/retention";
import {
  materializeAdminTasks,
  type AdminTaskCandidate
} from "@/server/admin/tasks";
import {
  serializeStoredCitation,
  serializeStoredMessage
} from "@/server/chat/stored-message";
import {
  adminRoles,
  adminInvitations,
  adminTaskStates,
  auditLogs,
  backgroundTasks,
  citations,
  conversations,
  dailyUsage,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeReviewRun,
  knowledgeReviewSections,
  knowledgeSectionDecisions,
  knowledgeSources,
  knowledgeVersions,
  messageCitations,
  messageFeedback,
  messages,
  promptVersions,
  problemReports,
  systemSettings,
  session as sessions,
  user as users
} from "@/server/db/schema";
import {
  assertKnowledgePublicationEvidence,
  assertKnowledgeSourceAuthorized,
  KnowledgeSourcePolicyError,
  type GovernedKnowledgeSource
} from "@/server/knowledge/source-policy";
import {
  ACTIVE_REVIEWED,
  isPendingReviewRetrievalActive
} from "@/server/knowledge/review-policy";
import { renderKnowledgeCandidate } from "@/server/knowledge/candidate-schema";
import {
  assertKnowledgeSectionPublicationReady,
  buildCandidateKnowledgeReviewSections
} from "@/server/knowledge/review-sections";
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
import { assertOwnerRoleRevocationAllowed } from "./role-policy";
import {
  ADMIN_ROLES,
  type AdminRole,
  type AccountProfile,
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
  if (assigned.size > 1) {
    throw new ApiError(
      409,
      "ADMIN_ROLE_CONFLICT",
      "该账号存在多个管理员角色，请先完成迁移后再继续。"
    );
  }
  return ADMIN_ROLES.find((role) => assigned.has(role)) ?? null;
}

function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase();
}

function invitationExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + 48 * 60 * 60 * 1000);
}

function assertInvitationRoleAllowed(
  actorRole: AdminRole | "user",
  invitationRole: AdminRole
): void {
  if (actorRole !== "owner" && actorRole !== "admin") {
    throw new ApiError(403, "FORBIDDEN", "当前管理员角色无权执行此操作。");
  }

  if (actorRole === "admin" && invitationRole === "owner") {
    throw new ApiError(
      403,
      "OWNER_PROTECTED",
      "只有 owner 可以邀请 owner 角色。"
    );
  }

  if (actorRole === "admin" && invitationRole === "admin") {
    throw new ApiError(
      403,
      "ADMIN_PROTECTED",
      "只有 owner 可以邀请 admin 角色。"
    );
  }
}

function serializeAdminInvitation(row: {
  id: string;
  email: string;
  role: AdminRole;
  createdBy: string | null;
  acceptedBy: string | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
}) {
  const status = row.acceptedAt
    ? "accepted"
    : row.revokedAt
      ? "revoked"
      : invitationIsExpired(row)
        ? "expired"
        : "pending";
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdBy: row.createdBy,
    acceptedBy: row.acceptedBy,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status
  };
}

function invitationIsExpired(row: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): boolean {
  return row.expiresAt.getTime() <= Date.now();
}

function assertAdminRoleMutationAllowed(
  actorRole: AdminRole,
  targetRole: AdminRole
): void {
  if (actorRole !== "owner" && actorRole !== "admin") {
    throw new ApiError(403, "FORBIDDEN", "当前管理员角色无权执行此操作。");
  }

  if (targetRole === "owner" && actorRole !== "owner") {
    throw new ApiError(
      403,
      "OWNER_PROTECTED",
      "只有 owner 可以管理 owner 角色。"
    );
  }

  if (targetRole === "admin" && actorRole !== "owner") {
    throw new ApiError(
      403,
      "ADMIN_PROTECTED",
      "只有 owner 可以管理 admin 角色。"
    );
  }
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
  const hasRightsDecision =
    item.metadata?.rightsDecision !== null &&
    item.metadata?.rightsDecision !== undefined;
  const rightsDecisionMatchesRecord =
    !hasRightsDecision ||
    (typeof rightsDecision.appliesToRecordUrl === "string" &&
      rightsDecision.appliesToRecordUrl === item.canonicalUrl);
  return {
    ...item,
    publisher: item.publisher ?? item.name,
    domain: sourceDomain(item.baseUrl),
    licenseClass: item.licensePolicy ?? item.sourceTier,
    rightsStatus: !rightsDecisionMatchesRecord
      ? "stale"
      : typeof rightsDecision.status === "string"
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

export function assertPromptVersionTransitionAllowed(input: {
  currentStatus: string;
  nextStatus: "active" | "archived";
}): void {
  if (input.currentStatus === "archived") {
    throw new ApiError(
      409,
      "PROMPT_VERSION_ARCHIVED",
      "已归档的提示词版本不可再次变更；请创建新版本。"
    );
  }
  if (input.currentStatus === "active" && input.nextStatus === "active") {
    throw new ApiError(
      409,
      "PROMPT_VERSION_ALREADY_ACTIVE",
      "该提示词版本已激活，不能原地覆盖或重复激活。"
    );
  }
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
    assertKnowledgePublicationEvidence(source, citationMetadata);
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
  const sectionReview =
    review.mode === "section" &&
    Number.isInteger(review.sectionCount) &&
    Number(review.sectionCount) >= 1;
  const manualResolution =
    review.mode === "manual_document_resolution" &&
    Boolean(stringValue(review.note));
  if (!sectionReview && !manualResolution) {
    throw new ApiError(
      409,
      "KNOWLEDGE_SECTION_REVIEW_REQUIRED",
      "发布前必须完成全部稳定段落的逐段人工审核。"
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

function hasManualDocumentResolution(
  metadata: Record<string, unknown>
): boolean {
  const review = recordValue(metadata.review);
  return (
    review.mode === "manual_document_resolution" &&
    Boolean(stringValue(review.note))
  );
}

export function buildKnowledgeAutomationReviewView(
  rows: Array<Record<string, unknown>>,
  currentVersionId: string,
  currentContentHash: string | null
): Record<string, unknown> | undefined {
  if (!currentContentHash) return undefined;
  const currentHash = currentContentHash.toLowerCase();
  const candidates = rows.filter((row) => {
    const report = recordValue(row.structuredReport ?? row.structured_report);
    const automation = recordValue(report.automation);
    const hasStoredTarget =
      stringValue(report.outputContentHash) !== undefined ||
      stringValue(automation.outputVersionId) !== undefined ||
      stringValue(automation.outputContentHash) !== undefined;
    if (hasStoredTarget) {
      return (
        stringValue(report.outputContentHash)?.toLowerCase() === currentHash &&
        stringValue(automation.outputVersionId) === currentVersionId &&
        stringValue(automation.outputContentHash)?.toLowerCase() === currentHash
      );
    }
    return (
      stringValue(row.inputVersionId ?? row.input_version_id) ===
        currentVersionId &&
      stringValue(
        row.inputContentHash ?? row.input_content_hash
      )?.toLowerCase() === currentHash
    );
  });
  const latest = candidates[0];
  if (!latest) return undefined;
  const report = recordValue(
    latest.structuredReport ?? latest.structured_report
  );
  const revisionRow = candidates.find(
    (row) =>
      stringValue(row.revisedVersionId ?? row.revised_version_id) ===
      currentVersionId
  );
  const revisionReport = recordValue(
    revisionRow?.structuredReport ?? revisionRow?.structured_report
  );
  return {
    status: stringValue(latest.status) ?? "queued",
    phase: stringValue(latest.phase) ?? null,
    risk: stringValue(latest.risk) ?? null,
    decision: stringValue(latest.decision) ?? null,
    summary: stringValue(report.summary) ?? null,
    blockers: structuredList(report.blockers),
    findings: structuredList(report.findings),
    evidence: evidenceList(report.evidence),
    ...(revisionRow
      ? {
          revision: {
            changed: true,
            inputVersionId: stringValue(
              revisionRow.inputVersionId ?? revisionRow.input_version_id
            ),
            outputVersionId: currentVersionId,
            inputContentHash: stringValue(
              revisionRow.inputContentHash ?? revisionRow.input_content_hash
            ),
            outputContentHash:
              stringValue(revisionReport.outputContentHash) ?? currentHash
          }
        }
      : {})
  };
}

function structuredList(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(recordValue)
        .map((item) => ({
          code: stringValue(item.code) ?? "UNKNOWN",
          message: stringValue(item.message) ?? ""
        }))
        .filter((item) => item.message)
    : [];
}

function evidenceList(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(recordValue)
        .map((item) => ({
          claim: stringValue(item.claim) ?? "",
          exactEvidence: stringValue(item.exactEvidence) ?? "",
          sourceLocator: stringValue(item.sourceLocator) ?? ""
        }))
        .filter(
          (item) => item.claim && item.exactEvidence && item.sourceLocator
        )
    : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function publicationRightsSnapshot(
  source:
    | (GovernedKnowledgeSource & {
        id: string;
      })
    | undefined
): Record<string, unknown> {
  if (!source) {
    throw new ApiError(
      409,
      "KNOWLEDGE_SOURCE_REQUIRED",
      "知识版本必须关联受治理的来源记录。"
    );
  }
  return {
    ...recordValue(source.metadata.rightsDecision),
    status: "approved",
    sourceId: source.id,
    canonicalUrl: source.canonicalUrl,
    sourceTier: source.sourceTier,
    publisher: source.publisher
  };
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
  const [
    versionRows,
    sourceRows,
    chunkRows,
    previousRows,
    sectionRows,
    automationRows
  ] = await Promise.all([
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
      : Promise.resolve([]),
    currentVersionId
      ? db
          .select({
            section: {
              id: knowledgeReviewSections.id,
              versionId: knowledgeReviewSections.versionId,
              sectionIndex: knowledgeReviewSections.sectionIndex,
              contentZh: knowledgeReviewSections.contentZh,
              officialText: knowledgeReviewSections.officialText,
              pageStart: knowledgeReviewSections.pageStart,
              pageEnd: knowledgeReviewSections.pageEnd,
              rightsSnapshot: knowledgeReviewSections.rightsSnapshot,
              rightsSnapshotHash: knowledgeReviewSections.rightsSnapshotHash,
              versionContentHash: knowledgeReviewSections.versionContentHash,
              sectionHash: knowledgeReviewSections.sectionHash
            },
            decision: {
              decision: knowledgeSectionDecisions.decision,
              sectionHash: knowledgeSectionDecisions.sectionHash,
              reviewerId: knowledgeSectionDecisions.reviewerId,
              note: knowledgeSectionDecisions.note
            }
          })
          .from(knowledgeReviewSections)
          .leftJoin(
            knowledgeSectionDecisions,
            eq(knowledgeSectionDecisions.sectionId, knowledgeReviewSections.id)
          )
          .where(eq(knowledgeReviewSections.versionId, currentVersionId))
          .orderBy(asc(knowledgeReviewSections.sectionIndex))
      : Promise.resolve([]),
    currentVersionId
      ? db
          .select({
            id: knowledgeReviewRun.id,
            phase: knowledgeReviewRun.phase,
            status: knowledgeReviewRun.status,
            inputVersionId: knowledgeReviewRun.inputVersionId,
            inputContentHash: knowledgeReviewRun.inputContentHash,
            risk: knowledgeReviewRun.risk,
            decision: knowledgeReviewRun.decision,
            structuredReport: knowledgeReviewRun.structuredReport,
            revisedVersionId: knowledgeReviewRun.revisedVersionId,
            createdAt: knowledgeReviewRun.createdAt
          })
          .from(knowledgeReviewRun)
          .where(
            or(
              eq(knowledgeReviewRun.inputVersionId, currentVersionId),
              eq(knowledgeReviewRun.revisedVersionId, currentVersionId)
            )
          )
          .orderBy(desc(knowledgeReviewRun.createdAt))
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
      if (!hasManualDocumentResolution(recordValue(version.metadata))) {
        assertKnowledgeSectionPublicationReady({
          versionId: version.id,
          versionContentHash: version.contentHash ?? "",
          versionCreatedBy: version.createdBy,
          currentRightsSnapshot: publicationRightsSnapshot(source),
          sections: sectionRows.map((row) => ({
            ...row.section,
            decision: row.decision?.decision
              ? {
                  decision: row.decision.decision,
                  sectionHash: row.decision.sectionHash ?? "",
                  reviewerId: row.decision.reviewerId ?? "",
                  note: row.decision.note
                }
              : null
          }))
        });
      }
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
    automationReview: buildKnowledgeAutomationReviewView(
      automationRows as Array<Record<string, unknown>>,
      currentVersionId ?? "",
      version?.contentHash ?? null
    ),
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
  async getAccountProfile(userId) {
    const [profile] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        image: users.image,
        avatarRevision: users.avatarRevision,
        twoFactorEnabled: users.twoFactorEnabled
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return (profile as AccountProfile | undefined) ?? null;
  },

  async updateAccountProfileName(userId, name, audit) {
    return db.transaction(async (tx) => {
      const [profile] = await tx
        .update(users)
        .set({ name, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning({
          id: users.id,
          name: users.name,
          email: users.email,
          emailVerified: users.emailVerified,
          image: users.image,
          avatarRevision: users.avatarRevision,
          twoFactorEnabled: users.twoFactorEnabled
        });
      if (!profile) return null;
      await tx.insert(auditLogs).values(
        auditValues(audit, "account.profile.name.update", "user", userId, {
          changedFields: ["name"]
        })
      );
      return profile;
    });
  },

  async getAdminRole(userId) {
    const results = await db
      .select({ role: adminRoles.role })
      .from(adminRoles)
      .where(eq(adminRoles.userId, userId))
      .orderBy(desc(adminRoles.createdAt));

    return effectiveAdminRole(results);
  },

  async reportAdminRoleConflicts() {
    const conflicts = await db
      .select({
        userId: adminRoles.userId,
        roleCount: count()
      })
      .from(adminRoles)
      .groupBy(adminRoles.userId)
      .having(sql`count(*) > 1`)
      .orderBy(asc(adminRoles.userId));

    return {
      count: conflicts.length,
      userIds: conflicts.map((conflict) => conflict.userId)
    };
  },

  async listAdminInvitations(input) {
    const now = new Date();
    const statusFilter =
      input.status === "accepted"
        ? isNotNull(adminInvitations.acceptedAt)
        : input.status === "revoked"
          ? isNotNull(adminInvitations.revokedAt)
          : input.status === "expired"
            ? and(
                isNull(adminInvitations.acceptedAt),
                isNull(adminInvitations.revokedAt),
                lte(adminInvitations.expiresAt, now)
              )
            : input.status === "pending"
              ? and(
                  isNull(adminInvitations.acceptedAt),
                  isNull(adminInvitations.revokedAt),
                  gte(adminInvitations.expiresAt, now)
                )
              : undefined;
    const filters = [
      statusFilter,
      ...(input.query
        ? [
            or(
              ilike(adminInvitations.email, queryPattern(input.query)),
              sql`${adminInvitations.role}::text ilike ${queryPattern(input.query)}`
            )
          ]
        : [])
    ].filter((filter) => filter !== undefined);
    const where = filters.length > 0 ? and(...filters) : undefined;
    const [items, totalRows] = await Promise.all([
      db
        .select({
          id: adminInvitations.id,
          email: adminInvitations.email,
          role: adminInvitations.role,
          createdBy: adminInvitations.createdBy,
          acceptedBy: adminInvitations.acceptedBy,
          acceptedAt: adminInvitations.acceptedAt,
          revokedAt: adminInvitations.revokedAt,
          createdAt: adminInvitations.createdAt,
          expiresAt: adminInvitations.expiresAt
        })
        .from(adminInvitations)
        .where(where)
        .orderBy(desc(adminInvitations.createdAt), desc(adminInvitations.id))
        .limit(input.pageSize)
        .offset(offset(input)),
      db.select({ value: count() }).from(adminInvitations).where(where)
    ]);

    return pageResult(
      items.map((item) => serializeAdminInvitation(item)),
      input,
      Number(totalRows[0]?.value ?? 0)
    );
  },

  async createAdminInvitation(input, audit) {
    assertInvitationRoleAllowed(audit.actor.role, input.role);
    const createdAt = new Date();
    const expiresAt = invitationExpiresAt(createdAt);
    const email = normalizeInvitationEmail(input.email);

    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(1967086382)`);
      const [created] = await tx
        .insert(adminInvitations)
        .values({
          email,
          role: input.role,
          tokenHash: input.tokenHash,
          createdBy: audit.actor.id,
          acceptedBy: null,
          acceptedAt: null,
          revokedAt: null,
          createdAt,
          expiresAt
        })
        .onConflictDoNothing()
        .returning({
          id: adminInvitations.id,
          email: adminInvitations.email,
          role: adminInvitations.role,
          createdBy: adminInvitations.createdBy,
          acceptedBy: adminInvitations.acceptedBy,
          acceptedAt: adminInvitations.acceptedAt,
          revokedAt: adminInvitations.revokedAt,
          createdAt: adminInvitations.createdAt,
          expiresAt: adminInvitations.expiresAt
        });

      if (!created) {
        throw new ApiError(
          409,
          "ADMIN_INVITATION_ALREADY_EXISTS",
          "该邀请已经存在。"
        );
      }

      await tx.insert(auditLogs).values({
        ...auditValues(
          audit,
          "admin_invitation.create",
          "admin_invitation",
          created.id,
          { email: created.email, role: created.role }
        ),
        before: { created: false },
        after: {
          created: true,
          email: created.email,
          role: created.role,
          expiresAt: created.expiresAt.toISOString()
        }
      });

      return serializeAdminInvitation(created);
    });
  },

  async revokeAdminInvitation(invitationId, audit) {
    if (audit.actor.role !== "owner" && audit.actor.role !== "admin") {
      throw new ApiError(403, "FORBIDDEN", "当前管理员角色无权执行此操作。");
    }

    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(1967086382)`);
      const [existing] = await tx
        .select({
          id: adminInvitations.id,
          email: adminInvitations.email,
          role: adminInvitations.role,
          createdBy: adminInvitations.createdBy,
          acceptedBy: adminInvitations.acceptedBy,
          acceptedAt: adminInvitations.acceptedAt,
          revokedAt: adminInvitations.revokedAt,
          createdAt: adminInvitations.createdAt,
          expiresAt: adminInvitations.expiresAt
        })
        .from(adminInvitations)
        .where(eq(adminInvitations.id, invitationId))
        .limit(1)
        .for("update");

      if (!existing) {
        return null;
      }
      assertInvitationRoleAllowed(audit.actor.role, existing.role);
      if (
        existing.acceptedAt ||
        existing.revokedAt ||
        invitationIsExpired(existing)
      ) {
        return null;
      }

      const [revoked] = await tx
        .update(adminInvitations)
        .set({
          revokedAt: new Date()
        })
        .where(eq(adminInvitations.id, invitationId))
        .returning({
          id: adminInvitations.id,
          email: adminInvitations.email,
          role: adminInvitations.role,
          createdBy: adminInvitations.createdBy,
          acceptedBy: adminInvitations.acceptedBy,
          acceptedAt: adminInvitations.acceptedAt,
          revokedAt: adminInvitations.revokedAt,
          createdAt: adminInvitations.createdAt,
          expiresAt: adminInvitations.expiresAt
        });

      if (!revoked) {
        return null;
      }

      await tx.insert(auditLogs).values({
        ...auditValues(
          audit,
          "admin_invitation.revoke",
          "admin_invitation",
          revoked.id,
          { email: revoked.email, role: revoked.role }
        ),
        before: {
          revokedAt: null,
          acceptedAt: revoked.acceptedAt
        },
        after: {
          revokedAt: revoked.revokedAt?.toISOString() ?? null
        }
      });

      return serializeAdminInvitation(revoked);
    });
  },

  async acceptAdminInvitation(input, audit) {
    const normalizedEmail = normalizeInvitationEmail(input.userEmail);
    if (!input.emailVerified) {
      throw new ApiError(
        403,
        "EMAIL_NOT_VERIFIED",
        "邮箱未验证，不能接受管理员邀请。"
      );
    }

    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(1967086382)`);
      const [invitation] = await tx
        .select({
          id: adminInvitations.id,
          email: adminInvitations.email,
          role: adminInvitations.role,
          createdBy: adminInvitations.createdBy,
          acceptedBy: adminInvitations.acceptedBy,
          acceptedAt: adminInvitations.acceptedAt,
          revokedAt: adminInvitations.revokedAt,
          createdAt: adminInvitations.createdAt,
          expiresAt: adminInvitations.expiresAt
        })
        .from(adminInvitations)
        .where(eq(adminInvitations.tokenHash, input.tokenHash))
        .limit(1)
        .for("update");

      if (
        !invitation ||
        invitation.acceptedAt ||
        invitation.revokedAt ||
        invitationIsExpired(invitation)
      ) {
        return null;
      }

      if (invitation.email !== normalizedEmail) {
        throw new ApiError(
          409,
          "INVITATION_EMAIL_MISMATCH",
          "邀请邮箱与当前登录账号不匹配。"
        );
      }

      const existingRoles = await tx
        .select({ role: adminRoles.role })
        .from(adminRoles)
        .where(eq(adminRoles.userId, input.userId))
        .orderBy(desc(adminRoles.createdAt));
      if (existingRoles.length > 0) {
        throw new ApiError(
          409,
          "ADMIN_ROLE_ALREADY_ASSIGNED",
          "该账号已经存在管理员角色。"
        );
      }

      const [createdRole] = await tx
        .insert(adminRoles)
        .values({
          userId: input.userId,
          role: invitation.role,
          createdBy: invitation.createdBy,
          createdAt: new Date()
        })
        .onConflictDoNothing()
        .returning({
          userId: adminRoles.userId,
          role: adminRoles.role,
          createdBy: adminRoles.createdBy,
          createdAt: adminRoles.createdAt
        });
      if (!createdRole) {
        throw new ApiError(
          409,
          "ADMIN_ROLE_ALREADY_ASSIGNED",
          "该账号已经存在管理员角色。"
        );
      }

      const [accepted] = await tx
        .update(adminInvitations)
        .set({
          acceptedBy: input.userId,
          acceptedAt: new Date()
        })
        .where(eq(adminInvitations.id, invitation.id))
        .returning({
          id: adminInvitations.id,
          email: adminInvitations.email,
          role: adminInvitations.role,
          createdBy: adminInvitations.createdBy,
          acceptedBy: adminInvitations.acceptedBy,
          acceptedAt: adminInvitations.acceptedAt,
          revokedAt: adminInvitations.revokedAt,
          createdAt: adminInvitations.createdAt,
          expiresAt: adminInvitations.expiresAt
        });

      if (!accepted) {
        throw new ApiError(
          409,
          "ADMIN_INVITATION_ALREADY_USED",
          "该管理员邀请已经失效。"
        );
      }

      await tx.insert(auditLogs).values({
        ...auditValues(
          audit,
          "admin_invitation.accept",
          "admin_invitation",
          accepted.id,
          {
            email: accepted.email,
            role: accepted.role,
            acceptedBy: input.userId
          }
        ),
        before: {
          acceptedAt: null,
          acceptedBy: null
        },
        after: {
          acceptedAt: accepted.acceptedAt?.toISOString() ?? null,
          acceptedBy: accepted.acceptedBy
        }
      });

      return serializeAdminInvitation(accepted);
    });
  },

  async listAdminTasks(input) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [
      conflicts,
      feedbackRows,
      problemRows,
      knowledgeRows,
      failedTaskRows,
      budgets,
      usageRows
    ] = await Promise.all([
      apiStore.reportAdminRoleConflicts(),
      db
        .select({
          id: messageFeedback.id,
          rating: messageFeedback.rating,
          status: messageFeedback.status,
          reason: messageFeedback.reason,
          updatedAt: messageFeedback.updatedAt
        })
        .from(messageFeedback)
        .where(inArray(messageFeedback.status, ["open", "reviewing"]))
        .limit(200),
      db
        .select({
          id: problemReports.id,
          category: problemReports.category,
          status: problemReports.status,
          description: problemReports.description,
          createdAt: problemReports.createdAt
        })
        .from(problemReports)
        .where(inArray(problemReports.status, ["new", "reviewing"]))
        .limit(200),
      db
        .select({
          id: knowledgeDocuments.id,
          title: knowledgeDocuments.title,
          status: knowledgeDocuments.status,
          updatedAt: knowledgeDocuments.updatedAt
        })
        .from(knowledgeDocuments)
        .where(inArray(knowledgeDocuments.status, ["review", "failed"]))
        .limit(200),
      db
        .select({
          id: backgroundTasks.id,
          type: backgroundTasks.type,
          status: backgroundTasks.status,
          lastError: backgroundTasks.lastError,
          updatedAt: backgroundTasks.updatedAt
        })
        .from(backgroundTasks)
        .where(eq(backgroundTasks.status, "failed"))
        .limit(100),
      apiStore.getBudgets(),
      db
        .select({
          model: dailyUsage.model,
          costCents: dailyUsage.costCents
        })
        .from(dailyUsage)
        .where(gte(dailyUsage.date, since))
    ]);

    const now = new Date();
    const candidates: AdminTaskCandidate[] = [];
    for (const userId of conflicts.userIds) {
      candidates.push({
        key: `auth:role-conflict:${userId}`,
        sourceType: "auth",
        sourceId: userId,
        sourceStatus: "conflict",
        title: "管理员角色冲突",
        summary: "该账号存在多个后台角色，迁移和授权操作已暂停。",
        href: "/admin/admins",
        severity: "critical",
        occurredAt: now
      });
    }
    for (const row of feedbackRows) {
      candidates.push({
        key: `feedback:${row.id}`,
        sourceType: "feedback",
        sourceId: row.id,
        sourceStatus: row.status,
        title: row.rating === "not_helpful" ? "负向回答反馈" : "用户反馈待处理",
        summary: row.reason || "需要领取并记录处理结果。",
        href: `/admin/conversations?feedback=${row.id}`,
        severity: row.rating === "not_helpful" ? "medium" : "low",
        occurredAt: row.updatedAt
      });
    }
    for (const row of problemRows) {
      const highRisk =
        row.category === "unsafe_answer" || row.category === "system_error";
      candidates.push({
        key: `problem_report:${row.id}`,
        sourceType: "problem_report",
        sourceId: row.id,
        sourceStatus: row.status,
        title: highRisk ? "高风险问题报告" : "问题报告待处理",
        summary: row.description,
        href: `/admin/problem-reports?report=${row.id}`,
        severity: highRisk ? "high" : "medium",
        occurredAt: row.createdAt
      });
    }
    for (const row of knowledgeRows) {
      candidates.push({
        key: `knowledge:${row.id}`,
        sourceType: "knowledge",
        sourceId: row.id,
        sourceStatus: row.status,
        title: row.status === "failed" ? "知识处理失败" : "知识等待人工审核",
        summary: row.title,
        href: `/admin/knowledge?document=${row.id}`,
        severity: row.status === "failed" ? "critical" : "high",
        occurredAt: row.updatedAt
      });
    }
    for (const row of failedTaskRows) {
      candidates.push({
        key: `system:${row.id}`,
        sourceType: "system",
        sourceId: row.id,
        sourceStatus: row.status,
        title: "后台任务失败",
        summary: row.lastError || row.type,
        href: "/admin/audit",
        severity: "critical",
        occurredAt: row.updatedAt
      });
    }

    const usageByModel = new Map<string, number>();
    for (const row of usageRows) {
      usageByModel.set(
        row.model,
        (usageByModel.get(row.model) ?? 0) + row.costCents
      );
    }
    for (const budget of budgets) {
      if (!budget.enabled || budget.dailyLimitCents <= 0) continue;
      const used = usageByModel.get(budget.model) ?? 0;
      const ratio = used / budget.dailyLimitCents;
      if (ratio < 0.8) continue;
      candidates.push({
        key: `budget:${budget.model}`,
        sourceType: "budget",
        sourceId: budget.model,
        sourceStatus: ratio >= 1 ? "limit_reached" : "near_limit",
        title: ratio >= 1 ? "模型预算已触发限额" : "模型预算接近限额",
        summary: `${budget.model} 近 24 小时消耗 ${used} 分，日限额 ${budget.dailyLimitCents} 分。`,
        href: "/admin/models",
        severity: ratio >= 1 ? "critical" : "high",
        occurredAt: now
      });
    }

    const taskKeys = candidates.map((candidate) => candidate.key);
    const storedStates =
      taskKeys.length === 0
        ? []
        : await db
            .select({
              taskKey: adminTaskStates.taskKey,
              assigneeUserId: adminTaskStates.assigneeUserId,
              status: adminTaskStates.status,
              dueAt: adminTaskStates.dueAt,
              snoozedUntil: adminTaskStates.snoozedUntil,
              note: adminTaskStates.note,
              revision: adminTaskStates.revision
            })
            .from(adminTaskStates)
            .where(inArray(adminTaskStates.taskKey, taskKeys));
    let tasks = materializeAdminTasks(
      candidates,
      storedStates.map((state) => ({
        ...state,
        status: state.status as "open" | "in_progress" | "done"
      }))
    );
    if (input.status) {
      tasks = tasks.filter(
        (task) =>
          task.state.status === input.status || task.severity === input.status
      );
    }
    if (input.query) {
      const query = input.query.toLocaleLowerCase("zh-CN");
      tasks = tasks.filter((task) =>
        `${task.title} ${task.summary} ${task.sourceId}`
          .toLocaleLowerCase("zh-CN")
          .includes(query)
      );
    }

    const total = tasks.length;
    return pageResult(
      tasks.slice(offset(input), offset(input) + input.pageSize),
      input,
      total
    );
  },

  async updateAdminTaskState(taskKey, input, audit) {
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(adminTaskStates)
        .where(eq(adminTaskStates.taskKey, taskKey))
        .limit(1)
        .for("update");

      const now = new Date();
      if (!existing) {
        if (input.expectedRevision !== 0) {
          throw new ApiError(
            409,
            "TASK_REVISION_CONFLICT",
            "任务状态已被其他管理员更新，请刷新后重试。"
          );
        }
        const [created] = await tx
          .insert(adminTaskStates)
          .values({
            taskKey,
            assigneeUserId: input.assigneeUserId ?? null,
            status: input.status ?? "open",
            dueAt: input.dueAt ?? null,
            snoozedUntil: input.snoozedUntil ?? null,
            note: input.note ?? null,
            revision: 1,
            updatedBy: audit.actor.id,
            createdAt: now,
            updatedAt: now
          })
          .onConflictDoNothing()
          .returning();
        if (!created) {
          throw new ApiError(
            409,
            "TASK_REVISION_CONFLICT",
            "任务状态已被其他管理员更新，请刷新后重试。"
          );
        }
        await tx.insert(auditLogs).values(
          auditValues(audit, "admin_task_state.create", "admin_task", taskKey, {
            revision: created.revision
          })
        );
        return {
          assigneeUserId: created.assigneeUserId,
          status: created.status as "open" | "in_progress" | "done",
          dueAt: created.dueAt,
          snoozedUntil: created.snoozedUntil,
          note: created.note,
          revision: created.revision
        };
      }

      if (existing.revision !== input.expectedRevision) {
        throw new ApiError(
          409,
          "TASK_REVISION_CONFLICT",
          "任务状态已被其他管理员更新，请刷新后重试。"
        );
      }
      const patch: Partial<typeof adminTaskStates.$inferInsert> = {
        revision: existing.revision + 1,
        updatedBy: audit.actor.id,
        updatedAt: now
      };
      if (input.assigneeUserId !== undefined)
        patch.assigneeUserId = input.assigneeUserId;
      if (input.status !== undefined) patch.status = input.status;
      if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
      if (input.snoozedUntil !== undefined)
        patch.snoozedUntil = input.snoozedUntil;
      if (input.note !== undefined) patch.note = input.note;

      const [updated] = await tx
        .update(adminTaskStates)
        .set(patch)
        .where(
          and(
            eq(adminTaskStates.taskKey, taskKey),
            eq(adminTaskStates.revision, input.expectedRevision)
          )
        )
        .returning();
      if (!updated) {
        throw new ApiError(
          409,
          "TASK_REVISION_CONFLICT",
          "任务状态已被其他管理员更新，请刷新后重试。"
        );
      }
      await tx.insert(auditLogs).values(
        auditValues(audit, "admin_task_state.update", "admin_task", taskKey, {
          previousRevision: existing.revision,
          revision: updated.revision
        })
      );
      return {
        assigneeUserId: updated.assigneeUserId,
        status: updated.status as "open" | "in_progress" | "done",
        dueAt: updated.dueAt,
        snoozedUntil: updated.snoozedUntil,
        note: updated.note,
        revision: updated.revision
      };
    });
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

  async getAdminConversation(conversationId) {
    const [conversation] = await db
      .select({
        id: conversations.id,
        userId: conversations.userId,
        userName: users.name,
        userEmail: users.email,
        title: conversations.title,
        summary: conversations.summary,
        status: conversations.status,
        model: conversations.model,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt
      })
      .from(conversations)
      .innerJoin(users, eq(conversations.userId, users.id))
      .where(
        and(
          eq(conversations.id, conversationId),
          ne(conversations.status, "deleted"),
          isNull(conversations.deletedAt)
        )
      )
      .limit(1);
    if (!conversation) return null;

    const visibleMessages = await db
      .select({
        id: messages.id,
        role: messages.role,
        status: messages.status,
        content: messages.content,
        sequence: messages.sequence,
        createdAt: messages.createdAt,
        completedAt: messages.completedAt
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          inArray(messages.role, ["user", "assistant"])
        )
      )
      .orderBy(asc(messages.sequence));

    return {
      ...conversation,
      title: conversation.title ?? "新对话",
      messages: visibleMessages
    };
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
      const actorRoles = await tx
        .select({ role: adminRoles.role })
        .from(adminRoles)
        .where(eq(adminRoles.userId, audit.actor.id))
        .orderBy(desc(adminRoles.createdAt));
      const currentActorRole = effectiveAdminRole(actorRoles);
      if (!currentActorRole) {
        throw new ApiError(403, "FORBIDDEN", "当前管理员角色无权执行此操作。");
      }
      assertAdminRoleMutationAllowed(currentActorRole, role);

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
      const actorRoles = await tx
        .select({ role: adminRoles.role })
        .from(adminRoles)
        .where(eq(adminRoles.userId, audit.actor.id))
        .orderBy(desc(adminRoles.createdAt));
      const currentActorRole = effectiveAdminRole(actorRoles);
      if (!currentActorRole) {
        throw new ApiError(403, "FORBIDDEN", "当前管理员角色无权执行此操作。");
      }
      assertAdminRoleMutationAllowed(currentActorRole, role);

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

  async replaceAdminRole(userId, expectedRole, role, audit) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(1967086382)`);
      const actorRoles = await tx
        .select({ role: adminRoles.role })
        .from(adminRoles)
        .where(eq(adminRoles.userId, audit.actor.id))
        .orderBy(desc(adminRoles.createdAt));
      const currentActorRole = effectiveAdminRole(actorRoles);
      if (!currentActorRole) {
        throw new ApiError(403, "FORBIDDEN", "当前管理员角色无权执行此操作。");
      }
      assertAdminRoleMutationAllowed(currentActorRole, expectedRole);
      assertAdminRoleMutationAllowed(currentActorRole, role);

      const targetRoles = await tx
        .select({
          userId: adminRoles.userId,
          role: adminRoles.role,
          createdBy: adminRoles.createdBy,
          createdAt: adminRoles.createdAt
        })
        .from(adminRoles)
        .where(eq(adminRoles.userId, userId))
        .orderBy(desc(adminRoles.createdAt))
        .for("update");
      const currentTargetRole = effectiveAdminRole(targetRoles);
      if (!currentTargetRole) return null;
      if (currentTargetRole !== expectedRole) {
        throw new ApiError(
          409,
          "ADMIN_ROLE_CHANGED",
          "管理员角色已变化，请刷新后重试。"
        );
      }

      if (expectedRole === "owner" && role !== "owner") {
        const [ownerTotal] = await tx
          .select({ value: count() })
          .from(adminRoles)
          .where(eq(adminRoles.role, "owner"));
        assertOwnerRoleRevocationAllowed({
          role: expectedRole,
          ownerCount: Number(ownerTotal?.value ?? 0),
          targetUserId: userId,
          actorUserId: audit.actor.id
        });
      }

      const changedAt = new Date();
      const [updated] = await tx
        .update(adminRoles)
        .set({
          role,
          createdBy: audit.actor.id,
          createdAt: changedAt
        })
        .where(
          and(eq(adminRoles.userId, userId), eq(adminRoles.role, expectedRole))
        )
        .returning({
          userId: adminRoles.userId,
          role: adminRoles.role,
          createdBy: adminRoles.createdBy,
          createdAt: adminRoles.createdAt
        });
      if (!updated) {
        throw new ApiError(
          409,
          "ADMIN_ROLE_CHANGED",
          "管理员角色已变化，请刷新后重试。"
        );
      }

      await tx.insert(auditLogs).values({
        ...auditValues(
          { ...audit, actor: { ...audit.actor, role: currentActorRole } },
          "admin_role.replace",
          "admin_role",
          userId,
          { targetUserId: userId }
        ),
        before: { role: expectedRole },
        after: { role }
      });

      return updated;
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
    await recoverStaleAgentRuns({ userId, conversationId });
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
        answerSchemaVersion: messages.answerSchemaVersion,
        answerPayload: messages.answerPayload,
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
              trustTier: citations.trustTier,
              reviewStatus: citations.reviewStatus,
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

      const revokedSessions = input.banned
        ? await tx
            .delete(sessions)
            .where(eq(sessions.userId, userId))
            .returning({ id: sessions.id })
        : [];

      await tx.insert(auditLogs).values(
        auditValues(
          currentAudit,
          input.banned ? "user.ban" : "user.unban",
          "user",
          userId,
          {
            reason: input.reason ?? null,
            expiresAt: input.expiresAt?.toISOString() ?? null,
            sessionsRevoked: revokedSessions.length
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

  async revokeUserSessions(userId, reason, audit) {
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
        destructive: true
      });

      const [target] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("key share");
      if (!target) return null;

      const revoked = await tx
        .delete(sessions)
        .where(eq(sessions.userId, userId))
        .returning({ id: sessions.id });
      await tx
        .insert(auditLogs)
        .values(
          auditValues(
            { ...audit, actor: { ...audit.actor, role: actorRole } },
            "user.sessions.revoke_all",
            "user",
            userId,
            { reason, sessionsRevoked: revoked.length }
          )
        );
      return { userId, revokedSessions: revoked.length };
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
        currentVersionId: null,
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

      await tx
        .update(knowledgeDocuments)
        .set({ currentVersionId: versionId, updatedAt: now })
        .where(eq(knowledgeDocuments.id, documentId));

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

  async importKnowledgeCandidate(input, audit) {
    const documentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const content = renderKnowledgeCandidate(input);
    const contentHash = sha256KnowledgeContent(content);
    const now = new Date();

    return db.transaction(async (tx) => {
      const [source] = await tx
        .select()
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.canonicalUrl, input.sourceCanonicalUrl),
            isNull(knowledgeSources.deletedAt)
          )
        )
        .limit(1)
        .for("update");
      if (!source) {
        throw new ApiError(
          409,
          "KNOWLEDGE_SOURCE_NOT_GOVERNED",
          "请先在来源白名单创建并批准该官方来源，再导入知识资料。"
        );
      }
      assertKnowledgeSourceAuthorized(source, input.citation);

      const [duplicate] = await tx
        .select({ id: knowledgeDocuments.id })
        .from(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.sourceId, source.id),
            eq(knowledgeDocuments.externalKey, input.document.externalKey)
          )
        )
        .limit(1);
      if (duplicate) {
        throw new ApiError(
          409,
          "KNOWLEDGE_CANDIDATE_ALREADY_EXISTS",
          "该来源的 externalKey 已存在；请修改现有草稿或使用新的 externalKey。"
        );
      }

      const rightsSnapshot = publicationRightsSnapshot(source);
      const sections = buildCandidateKnowledgeReviewSections({
        candidate: input,
        versionId,
        versionContentHash: contentHash,
        rightsSnapshot
      });

      const [insertedDocument] = await tx
        .insert(knowledgeDocuments)
        .values({
          id: documentId,
          sourceId: source.id,
          externalKey: input.document.externalKey,
          title: input.document.title,
          description: input.document.description,
          language: input.document.language,
          mimeType: input.document.mimeType,
          status: "review",
          currentVersionId: null,
          tags: input.document.tags,
          metadata: {
            curationStatus: "ai_assisted_draft",
            reviewRequirements: input.review.requirements,
            notRetrievableUntilHumanReviewAndPublication: true
          },
          createdBy: audit.actor.id,
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoNothing({
          target: [knowledgeDocuments.sourceId, knowledgeDocuments.externalKey]
        })
        .returning({ id: knowledgeDocuments.id });
      if (!insertedDocument) {
        throw new ApiError(
          409,
          "KNOWLEDGE_CANDIDATE_ALREADY_EXISTS",
          "该来源的 externalKey 已存在；请修改现有草稿或使用新的 externalKey。"
        );
      }
      await tx.insert(knowledgeVersions).values({
        id: versionId,
        documentId,
        version: 1,
        contentHash,
        content,
        citationMetadata: {
          ...input.citation,
          sourceCandidatePath: "admin_json_import",
          reviewEvidenceMode: "normalized_sections_v1"
        },
        status: "review",
        parserVersion: "openvac-normalized-review-v1",
        metadata: {
          reviewStatus: "required",
          embeddingStatus:
            input.citation.ingestionMode === "full_text"
              ? "pending_review"
              : "not_applicable",
          curationStatus: "ai_assisted_draft",
          importedForHumanReview: true
        },
        createdBy: audit.actor.id,
        createdAt: now,
        updatedAt: now
      });
      await tx.insert(knowledgeReviewSections).values(
        sections.map((section) => ({
          versionId,
          sectionIndex: section.sectionIndex,
          contentZh: section.contentZh,
          officialText: section.officialText,
          pageStart: section.pageStart,
          pageEnd: section.pageEnd,
          rightsSnapshot: section.rightsSnapshot,
          rightsSnapshotHash: section.rightsSnapshotHash,
          versionContentHash: section.versionContentHash,
          sectionHash: section.sectionHash,
          createdAt: now,
          updatedAt: now
        }))
      );
      await tx
        .update(knowledgeDocuments)
        .set({ currentVersionId: versionId, updatedAt: now })
        .where(eq(knowledgeDocuments.id, documentId));
      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          "knowledge.candidate.import",
          "knowledge_document",
          documentId,
          {
            versionId,
            sourceId: source.id,
            externalKey: input.document.externalKey,
            sectionCount: sections.length,
            decisions: 0,
            chunks: 0
          }
        )
      );

      return {
        id: documentId,
        versionId,
        status: "review",
        sectionCount: sections.length,
        decisions: 0,
        chunks: 0
      };
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
        (document.status !== "draft" &&
          document.status !== "review" &&
          document.status !== "published")
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
      const publishedPendingReview =
        document.status === "published" &&
        version.status === "published" &&
        isPendingReviewRetrievalActive({
          metadata: version.metadata,
          contentHash: version.contentHash
        });
      if (
        version.status !== "draft" &&
        version.status !== "review" &&
        !publishedPendingReview
      ) {
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
          reviewedContentHash: publishedPendingReview
            ? version.metadata.retrievalContentHash
            : existingReview.contentHash,
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
      if (
        publishedPendingReview &&
        input.decision === "approved" &&
        version.citationMetadata.ingestionMode === "full_text" &&
        !preserveCompletedEmbedding
      ) {
        throw new ApiError(
          409,
          "KNOWLEDGE_PROVISIONAL_EMBEDDING_INCOMPLETE",
          "待复核知识的向量数据不完整，不能记录人工批准。"
        );
      }
      const embeddingStatus = preserveCompletedEmbedding
        ? "completed"
        : transition.embeddingStatus;
      const metadata = {
        ...version.metadata,
        reviewStatus: transition.review.status,
        embeddingStatus,
        review: transition.review,
        ...(publishedPendingReview
          ? {
              retrievalStatus:
                input.decision === "approved"
                  ? ACTIVE_REVIEWED
                  : "inactive_rejected",
              humanTechnicalReviewRequired: false
            }
          : {})
      };

      const nextVersionStatus = publishedPendingReview
        ? input.decision === "approved"
          ? "published"
          : "archived"
        : transition.versionStatus;
      const nextDocumentStatus = publishedPendingReview
        ? input.decision === "approved"
          ? "published"
          : "archived"
        : transition.documentStatus;

      await tx
        .update(knowledgeVersions)
        .set({
          status: nextVersionStatus,
          contentHash: transition.contentHash,
          metadata,
          updatedAt: now
        })
        .where(eq(knowledgeVersions.id, document.currentVersionId));
      await tx
        .update(knowledgeDocuments)
        .set({ status: nextDocumentStatus, updatedAt: now })
        .where(eq(knowledgeDocuments.id, documentId));

      if (document.sourceId) {
        const chunkRows = await tx
          .select({ id: knowledgeChunks.id })
          .from(knowledgeChunks)
          .where(eq(knowledgeChunks.versionId, document.currentVersionId));
        const withdrawnSourceIds = chunkRows.map(
          (chunk) => `${document.sourceId}:chunk:${chunk.id}`
        );
        if (withdrawnSourceIds.length > 0) {
          await tx
            .update(citations)
            .set({
              reviewStatus:
                input.decision === "approved" ? "reviewed" : "rejected"
            })
            .where(
              inArray(
                sql<string>`${citations.metadata} ->> 'originalSourceId'`,
                withdrawnSourceIds
              )
            );
        }
      }

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
            provisionalPublicationReviewed: publishedPendingReview,
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
          id: knowledgeVersions.id,
          status: knowledgeVersions.status,
          content: knowledgeVersions.content,
          contentHash: knowledgeVersions.contentHash,
          citationMetadata: knowledgeVersions.citationMetadata,
          metadata: knowledgeVersions.metadata,
          createdBy: knowledgeVersions.createdBy
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
              id: knowledgeSources.id,
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
      const sectionRows = await tx
        .select({
          section: {
            id: knowledgeReviewSections.id,
            versionId: knowledgeReviewSections.versionId,
            sectionIndex: knowledgeReviewSections.sectionIndex,
            contentZh: knowledgeReviewSections.contentZh,
            officialText: knowledgeReviewSections.officialText,
            pageStart: knowledgeReviewSections.pageStart,
            pageEnd: knowledgeReviewSections.pageEnd,
            rightsSnapshot: knowledgeReviewSections.rightsSnapshot,
            rightsSnapshotHash: knowledgeReviewSections.rightsSnapshotHash,
            versionContentHash: knowledgeReviewSections.versionContentHash,
            sectionHash: knowledgeReviewSections.sectionHash
          },
          decision: {
            decision: knowledgeSectionDecisions.decision,
            sectionHash: knowledgeSectionDecisions.sectionHash,
            reviewerId: knowledgeSectionDecisions.reviewerId,
            note: knowledgeSectionDecisions.note
          }
        })
        .from(knowledgeReviewSections)
        .leftJoin(
          knowledgeSectionDecisions,
          eq(knowledgeSectionDecisions.sectionId, knowledgeReviewSections.id)
        )
        .where(eq(knowledgeReviewSections.versionId, version.id))
        .orderBy(asc(knowledgeReviewSections.sectionIndex));
      if (!hasManualDocumentResolution(version.metadata)) {
        assertKnowledgeSectionPublicationReady({
          versionId: version.id,
          versionContentHash: version.contentHash ?? "",
          versionCreatedBy: version.createdBy,
          currentRightsSnapshot: publicationRightsSnapshot(source),
          sections: sectionRows.map((row) => ({
            ...row.section,
            decision: row.decision?.decision
              ? {
                  decision: row.decision.decision,
                  sectionHash: row.decision.sectionHash ?? "",
                  reviewerId: row.decision.reviewerId ?? "",
                  note: row.decision.note
                }
              : null
          }))
        });
      }

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
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`openvac:prompt:${input.key}`}))`
      );
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
      const [candidate] = await tx
        .select({ key: promptVersions.key })
        .from(promptVersions)
        .where(eq(promptVersions.id, promptId))
        .limit(1);

      if (!candidate) {
        return null;
      }

      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`openvac:prompt:${candidate.key}`}))`
      );
      const [current] = await tx
        .select()
        .from(promptVersions)
        .where(eq(promptVersions.id, promptId))
        .limit(1)
        .for("update");
      if (!current) return null;
      assertPromptVersionTransitionAllowed({
        currentStatus: current.status,
        nextStatus: input.status
      });

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
        status: input.status,
        updatedAt: new Date(),
        ...(input.status === "active" ? { publishedAt: new Date() } : {})
      };

      const [updated] = await tx
        .update(promptVersions)
        .set(patch)
        .where(eq(promptVersions.id, promptId))
        .returning();

      await tx.insert(auditLogs).values(
        auditValues(
          audit,
          input.status === "active"
            ? "prompt_version.activate"
            : "prompt_version.archive",
          "prompt_version",
          promptId,
          {
            key: current.key,
            status: input.status,
            changedFields: ["status"]
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

  async getBudgetOverview(now) {
    const budgets = await apiStore.getBudgets();
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    );
    const usage = await db
      .select({
        model: dailyUsage.model,
        dailyUsedCents: sql<number>`coalesce(sum(case when ${gte(dailyUsage.date, dayStart)} then ${dailyUsage.costCents} else 0 end), 0)`,
        monthlyUsedCents: sql<number>`coalesce(sum(${dailyUsage.costCents}), 0)`
      })
      .from(dailyUsage)
      .where(gte(dailyUsage.date, monthStart))
      .groupBy(dailyUsage.model);
    const byModel = new Map(
      usage.map((row) => [
        row.model,
        {
          dailyUsedCents: Number(row.dailyUsedCents ?? 0),
          monthlyUsedCents: Number(row.monthlyUsedCents ?? 0)
        }
      ])
    );
    const daysElapsed = Math.max(1, now.getUTCDate());
    const daysInMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
    ).getUTCDate();

    return budgets.map((budget) => {
      const used = byModel.get(budget.model) ?? {
        dailyUsedCents: 0,
        monthlyUsedCents: 0
      };
      const projectedMonthlyCents = Math.round(
        (used.monthlyUsedCents / daysElapsed) * daysInMonth
      );
      const dailyRatio =
        budget.dailyLimitCents > 0
          ? used.dailyUsedCents / budget.dailyLimitCents
          : 0;
      const monthlyRatio =
        budget.monthlyLimitCents > 0
          ? used.monthlyUsedCents / budget.monthlyLimitCents
          : 0;
      const circuitStatus = !budget.enabled
        ? "disabled"
        : dailyRatio >= 1 || monthlyRatio >= 1
          ? "tripped"
          : dailyRatio >= 0.8 || monthlyRatio >= 0.8
            ? "warning"
            : "ok";
      return {
        ...budget,
        ...used,
        projectedMonthlyCents,
        circuitStatus
      };
    });
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
