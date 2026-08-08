import { asc, eq } from "drizzle-orm";

import { db } from "@/server/db";
import {
  conversation,
  conversationMemory,
  feedback,
  message,
  problemReport,
  session as authSession,
  user,
  userMemory
} from "@/server/db/schema";

import { authenticate } from "./auth";
import { notFound, withApiErrors } from "./errors";
import type { AuthenticatedUser } from "./types";

type AccountRecord = Pick<
  typeof user.$inferSelect,
  | "id"
  | "name"
  | "email"
  | "emailVerified"
  | "image"
  | "banned"
  | "banExpires"
  | "deletionRequestedAt"
  | "dailyQuotaBonus"
  | "createdAt"
  | "updatedAt"
>;

type SessionRecord = Pick<
  typeof authSession.$inferSelect,
  "id" | "userAgent" | "ipAddress" | "createdAt" | "updatedAt" | "expiresAt"
>;

type ConversationRecord = Pick<
  typeof conversation.$inferSelect,
  | "id"
  | "title"
  | "summary"
  | "status"
  | "model"
  | "lastMessageAt"
  | "createdAt"
  | "updatedAt"
  | "deletedAt"
>;

type MessageRecord = Pick<
  typeof message.$inferSelect,
  | "id"
  | "conversationId"
  | "sequence"
  | "role"
  | "status"
  | "content"
  | "model"
  | "answerPayload"
  | "createdAt"
  | "completedAt"
>;

type ConversationMemoryRecord = Pick<
  typeof conversationMemory.$inferSelect,
  | "conversationId"
  | "version"
  | "summary"
  | "confirmedFacts"
  | "unresolvedQuestions"
  | "throughSequence"
  | "sourceMessageIds"
  | "createdAt"
  | "updatedAt"
>;

type UserMemoryRecord = Pick<
  typeof userMemory.$inferSelect,
  | "id"
  | "kind"
  | "label"
  | "facts"
  | "sourceMessageIds"
  | "status"
  | "lastUsedAt"
  | "createdAt"
  | "updatedAt"
>;

type FeedbackRecord = Pick<
  typeof feedback.$inferSelect,
  | "id"
  | "messageId"
  | "kind"
  | "rating"
  | "reason"
  | "comment"
  | "category"
  | "details"
  | "status"
  | "createdAt"
  | "updatedAt"
>;

type ProblemReportRecord = Pick<
  typeof problemReport.$inferSelect,
  | "id"
  | "conversationId"
  | "messageId"
  | "category"
  | "description"
  | "includeContext"
  | "context"
  | "contactType"
  | "contactValue"
  | "consentToContact"
  | "status"
  | "createdAt"
  | "updatedAt"
  | "closedAt"
>;

export type AccountExportSnapshot = {
  account: AccountRecord | null;
  sessions: SessionRecord[];
  conversations: ConversationRecord[];
  messages: MessageRecord[];
  conversationMemories: ConversationMemoryRecord[];
  userMemories: UserMemoryRecord[];
  feedback: FeedbackRecord[];
  problemReports: ProblemReportRecord[];
};

export interface AccountExportRepository {
  collectOwned(userId: string): Promise<AccountExportSnapshot>;
}

type AuthenticateRequest = (request: Request) => Promise<AuthenticatedUser>;
type Clock = () => Date;

export const accountExportRepository: AccountExportRepository = {
  async collectOwned(userId) {
    const [
      accountRows,
      sessions,
      conversations,
      messages,
      conversationMemories,
      userMemories,
      feedbackRows,
      problemReports
    ] = await Promise.all([
      db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
          image: user.image,
          banned: user.banned,
          banExpires: user.banExpires,
          deletionRequestedAt: user.deletionRequestedAt,
          dailyQuotaBonus: user.dailyQuotaBonus,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt
        })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1),
      db
        .select({
          id: authSession.id,
          userAgent: authSession.userAgent,
          ipAddress: authSession.ipAddress,
          createdAt: authSession.createdAt,
          updatedAt: authSession.updatedAt,
          expiresAt: authSession.expiresAt
        })
        .from(authSession)
        .where(eq(authSession.userId, userId))
        .orderBy(asc(authSession.createdAt)),
      db
        .select({
          id: conversation.id,
          title: conversation.title,
          summary: conversation.summary,
          status: conversation.status,
          model: conversation.model,
          lastMessageAt: conversation.lastMessageAt,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          deletedAt: conversation.deletedAt
        })
        .from(conversation)
        .where(eq(conversation.userId, userId))
        .orderBy(asc(conversation.createdAt)),
      db
        .select({
          id: message.id,
          conversationId: message.conversationId,
          sequence: message.sequence,
          role: message.role,
          status: message.status,
          content: message.content,
          model: message.model,
          answerPayload: message.answerPayload,
          createdAt: message.createdAt,
          completedAt: message.completedAt
        })
        .from(message)
        .innerJoin(conversation, eq(message.conversationId, conversation.id))
        .where(eq(conversation.userId, userId))
        .orderBy(asc(message.createdAt), asc(message.sequence)),
      db
        .select({
          conversationId: conversationMemory.conversationId,
          version: conversationMemory.version,
          summary: conversationMemory.summary,
          confirmedFacts: conversationMemory.confirmedFacts,
          unresolvedQuestions: conversationMemory.unresolvedQuestions,
          throughSequence: conversationMemory.throughSequence,
          sourceMessageIds: conversationMemory.sourceMessageIds,
          createdAt: conversationMemory.createdAt,
          updatedAt: conversationMemory.updatedAt
        })
        .from(conversationMemory)
        .innerJoin(
          conversation,
          eq(conversationMemory.conversationId, conversation.id)
        )
        .where(eq(conversation.userId, userId))
        .orderBy(asc(conversationMemory.createdAt)),
      db
        .select({
          id: userMemory.id,
          kind: userMemory.kind,
          label: userMemory.label,
          facts: userMemory.facts,
          sourceMessageIds: userMemory.sourceMessageIds,
          status: userMemory.status,
          lastUsedAt: userMemory.lastUsedAt,
          createdAt: userMemory.createdAt,
          updatedAt: userMemory.updatedAt
        })
        .from(userMemory)
        .where(eq(userMemory.userId, userId))
        .orderBy(asc(userMemory.createdAt)),
      db
        .select({
          id: feedback.id,
          messageId: feedback.messageId,
          kind: feedback.kind,
          rating: feedback.rating,
          reason: feedback.reason,
          comment: feedback.comment,
          category: feedback.category,
          details: feedback.details,
          status: feedback.status,
          createdAt: feedback.createdAt,
          updatedAt: feedback.updatedAt
        })
        .from(feedback)
        .where(eq(feedback.userId, userId))
        .orderBy(asc(feedback.createdAt)),
      db
        .select({
          id: problemReport.id,
          conversationId: problemReport.conversationId,
          messageId: problemReport.messageId,
          category: problemReport.category,
          description: problemReport.description,
          includeContext: problemReport.includeContext,
          context: problemReport.context,
          contactType: problemReport.contactType,
          contactValue: problemReport.contactValue,
          consentToContact: problemReport.consentToContact,
          status: problemReport.status,
          createdAt: problemReport.createdAt,
          updatedAt: problemReport.updatedAt,
          closedAt: problemReport.closedAt
        })
        .from(problemReport)
        .where(eq(problemReport.userId, userId))
        .orderBy(asc(problemReport.createdAt))
    ]);

    return {
      account: accountRows[0] ?? null,
      sessions,
      conversations,
      messages,
      conversationMemories,
      userMemories,
      feedback: feedbackRows,
      problemReports
    };
  }
};

export const handleExportAccountData = withApiErrors(
  async (
    request: Request,
    repository: AccountExportRepository = accountExportRepository,
    authenticateRequest: AuthenticateRequest = authenticate,
    now: Clock = () => new Date()
  ) => {
    const authenticated = await authenticateRequest(request);
    const snapshot = await repository.collectOwned(authenticated.id);

    if (!snapshot.account) {
      throw notFound("账号");
    }

    const generatedAt = now();
    const document = {
      exportVersion: 1,
      generatedAt: generatedAt.toISOString(),
      account: pickAccount(snapshot.account),
      sessions: snapshot.sessions.map((item) => ({
        ...pickSession(item),
        isCurrent: item.id === authenticated.sessionId
      })),
      conversations: snapshot.conversations.map(pickConversation),
      messages: snapshot.messages.map(pickMessage),
      conversationMemories: snapshot.conversationMemories.map(
        pickConversationMemory
      ),
      userMemories: snapshot.userMemories.map(pickUserMemory),
      feedback: snapshot.feedback.map(pickFeedback),
      problemReports: snapshot.problemReports.map(pickProblemReport)
    };

    const date = generatedAt.toISOString().slice(0, 10);
    return new Response(`${JSON.stringify(document, null, 2)}\n`, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="openvac-account-export-${date}.json"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    });
  }
);

function pickAccount(item: AccountRecord): AccountRecord {
  const {
    id,
    name,
    email,
    emailVerified,
    image,
    banned,
    banExpires,
    deletionRequestedAt,
    dailyQuotaBonus,
    createdAt,
    updatedAt
  } = item;
  return {
    id,
    name,
    email,
    emailVerified,
    image,
    banned,
    banExpires,
    deletionRequestedAt,
    dailyQuotaBonus,
    createdAt,
    updatedAt
  };
}

function pickSession(item: SessionRecord): SessionRecord {
  const { id, userAgent, ipAddress, createdAt, updatedAt, expiresAt } = item;
  return { id, userAgent, ipAddress, createdAt, updatedAt, expiresAt };
}

function pickConversation(item: ConversationRecord): ConversationRecord {
  const {
    id,
    title,
    summary,
    status,
    model,
    lastMessageAt,
    createdAt,
    updatedAt,
    deletedAt
  } = item;
  return {
    id,
    title,
    summary,
    status,
    model,
    lastMessageAt,
    createdAt,
    updatedAt,
    deletedAt
  };
}

function pickMessage(item: MessageRecord): MessageRecord {
  const {
    id,
    conversationId,
    sequence,
    role,
    status,
    content,
    model,
    answerPayload,
    createdAt,
    completedAt
  } = item;
  return {
    id,
    conversationId,
    sequence,
    role,
    status,
    content,
    model,
    answerPayload,
    createdAt,
    completedAt
  };
}

function pickConversationMemory(
  item: ConversationMemoryRecord
): ConversationMemoryRecord {
  const {
    conversationId,
    version,
    summary,
    confirmedFacts,
    unresolvedQuestions,
    throughSequence,
    sourceMessageIds,
    createdAt,
    updatedAt
  } = item;
  return {
    conversationId,
    version,
    summary,
    confirmedFacts,
    unresolvedQuestions,
    throughSequence,
    sourceMessageIds,
    createdAt,
    updatedAt
  };
}

function pickUserMemory(item: UserMemoryRecord): UserMemoryRecord {
  const {
    id,
    kind,
    label,
    facts,
    sourceMessageIds,
    status,
    lastUsedAt,
    createdAt,
    updatedAt
  } = item;
  return {
    id,
    kind,
    label,
    facts,
    sourceMessageIds,
    status,
    lastUsedAt,
    createdAt,
    updatedAt
  };
}

function pickFeedback(item: FeedbackRecord): FeedbackRecord {
  const {
    id,
    messageId,
    kind,
    rating,
    reason,
    comment,
    category,
    details,
    status,
    createdAt,
    updatedAt
  } = item;
  return {
    id,
    messageId,
    kind,
    rating,
    reason,
    comment,
    category,
    details,
    status,
    createdAt,
    updatedAt
  };
}

function pickProblemReport(item: ProblemReportRecord): ProblemReportRecord {
  const {
    id,
    conversationId,
    messageId,
    category,
    description,
    includeContext,
    context,
    contactType,
    contactValue,
    consentToContact,
    status,
    createdAt,
    updatedAt,
    closedAt
  } = item;
  return {
    id,
    conversationId,
    messageId,
    category,
    description,
    includeContext,
    context,
    contactType,
    contactValue,
    consentToContact,
    status,
    createdAt,
    updatedAt,
    closedAt
  };
}
