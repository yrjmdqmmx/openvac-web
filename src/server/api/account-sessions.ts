import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/server/db";
import { session as authSession } from "@/server/db/schema";

import { authenticate } from "./auth";
import { ApiError, jsonData, notFound, withApiErrors } from "./errors";
import type { AuthenticatedUser } from "./types";

const sessionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);

export type AccountSessionSummary = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  expiresAt: Date;
};

export interface AccountSessionRepository {
  listOwned(userId: string): Promise<AccountSessionSummary[]>;
  revokeOwned(userId: string, sessionId: string): Promise<boolean>;
}

type AuthenticateRequest = (request: Request) => Promise<AuthenticatedUser>;

export const accountSessionRepository: AccountSessionRepository = {
  async listOwned(userId) {
    return db
      .select({
        id: authSession.id,
        userAgent: authSession.userAgent,
        ipAddress: authSession.ipAddress,
        createdAt: authSession.createdAt,
        expiresAt: authSession.expiresAt
      })
      .from(authSession)
      .where(eq(authSession.userId, userId))
      .orderBy(authSession.createdAt);
  },

  async revokeOwned(userId, sessionId) {
    const rows = await db
      .delete(authSession)
      .where(and(eq(authSession.id, sessionId), eq(authSession.userId, userId)))
      .returning({ id: authSession.id });
    return rows.length === 1;
  }
};

export const handleListAccountSessions = withApiErrors(
  async (
    request: Request,
    repository: AccountSessionRepository = accountSessionRepository,
    authenticateRequest: AuthenticateRequest = authenticate
  ) => {
    const user = await authenticateRequest(request);
    const sessions = await repository.listOwned(user.id);
    return jsonData(
      sessions.map(({ id, userAgent, ipAddress, createdAt, expiresAt }) => ({
        id,
        userAgent,
        ipAddress,
        createdAt,
        expiresAt
      }))
    );
  }
);

export const handleRevokeAccountSession = withApiErrors(
  async (
    request: Request,
    sessionId: string,
    repository: AccountSessionRepository = accountSessionRepository,
    authenticateRequest: AuthenticateRequest = authenticate
  ) => {
    const parsed = sessionIdSchema.safeParse(sessionId);
    if (!parsed.success) {
      throw new ApiError(422, "VALIDATION_ERROR", "会话标识不符合要求。");
    }

    const user = await authenticateRequest(request);
    const revoked = await repository.revokeOwned(user.id, parsed.data);
    if (!revoked) {
      throw notFound("会话");
    }
    return jsonData({ revoked: true });
  }
);
