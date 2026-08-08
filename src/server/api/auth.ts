import { auth } from "@/server/auth";
import { isUserDeletionInProgress } from "@/server/auth/account-cleanup";
import { isEffectiveBan } from "@/server/auth/ban-policy";

import { ApiError } from "./errors";
import {
  ADMIN_ROLES,
  type AdminContext,
  type Actor,
  type AdminActor,
  type AdminCapability,
  type AdminRole,
  type ApiStore,
  type AuditContext,
  type AuthenticatedUser
} from "./types";

const ROLE_CAPABILITIES: Record<AdminRole, ReadonlySet<AdminCapability>> = {
  owner: new Set([
    "conversations:read",
    "tasks:read",
    "tasks:write",
    "admins:read",
    "admins:write",
    "users:read",
    "users:write",
    "feedback:read",
    "feedback:write",
    "problem_reports:read",
    "problem_reports:write",
    "models:execute",
    "knowledge:read",
    "knowledge:draft",
    "knowledge:review",
    "knowledge:publish",
    "knowledge:rollback",
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
  ]),
  admin: new Set([
    "conversations:read",
    "tasks:read",
    "tasks:write",
    "admins:read",
    "admins:write",
    "users:read",
    "users:write",
    "feedback:read",
    "feedback:write",
    "problem_reports:read",
    "problem_reports:write",
    "models:execute",
    "knowledge:read",
    "knowledge:draft",
    "knowledge:review",
    "knowledge:publish",
    "knowledge:rollback",
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
  ]),
  knowledge_editor: new Set([
    "knowledge:read",
    "knowledge:draft",
    "knowledge:review",
    "sources:read",
    "sources:write",
    "prompts:read",
    "prompts:write",
    "metrics:read"
  ]),
  support: new Set([
    "users:read",
    "feedback:read",
    "feedback:write",
    "problem_reports:read",
    "problem_reports:write"
  ]),
  analyst: new Set([
    "knowledge:read",
    "sources:read",
    "prompts:read",
    "budgets:read",
    "settings:read",
    "metrics:read",
    "audit:read"
  ])
};

export function capabilitiesForRole(role: AdminRole): AdminCapability[] {
  return [...ROLE_CAPABILITIES[role]];
}

function normalizeRole(value: unknown): AdminRole | null {
  return typeof value === "string" && ADMIN_ROLES.includes(value as AdminRole)
    ? (value as AdminRole)
    : null;
}

export async function authenticate(
  request: Request
): Promise<AuthenticatedUser> {
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session?.user?.id) {
    throw new ApiError(401, "UNAUTHENTICATED", "请先登录。");
  }

  const sessionUser = session.user as typeof session.user & {
    banned?: boolean | null;
    banExpires?: Date | string | null;
    role?: string | null;
  };

  if (isEffectiveBan(sessionUser)) {
    throw new ApiError(403, "ACCOUNT_BANNED", "当前账号已被暂停使用。");
  }

  if (await isUserDeletionInProgress(sessionUser.id)) {
    throw new ApiError(
      409,
      "ACCOUNT_DELETION_IN_PROGRESS",
      "账号正在删除，不能再写入新数据。"
    );
  }

  return {
    id: sessionUser.id,
    sessionId: session.session?.id,
    email: sessionUser.email ?? null,
    emailVerified: Boolean(sessionUser.emailVerified),
    name: sessionUser.name ?? null,
    image: sessionUser.image ?? null,
    banned: isEffectiveBan(sessionUser),
    roleHint: normalizeRole(sessionUser.role)
  };
}

export function asUserActor(user: AuthenticatedUser): Actor {
  return { ...user, role: "user" };
}

export async function requireCapability(
  request: Request,
  store: ApiStore,
  capability: AdminCapability
): Promise<AdminActor> {
  const user = await authenticate(request);
  const role = await store.getAdminRole(user.id);

  if (!role || !ROLE_CAPABILITIES[role].has(capability)) {
    throw new ApiError(403, "FORBIDDEN", "当前管理员角色无权执行此操作。");
  }

  return { ...user, role };
}

export function auditContext(request: Request, actor: Actor): AuditContext {
  const url = new URL(request.url);
  return {
    actor,
    requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    path: url.pathname,
    method: request.method
  };
}

export function hasCapability(
  role: AdminRole,
  capability: AdminCapability
): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

export function buildAdminContext(actor: AdminActor): AdminContext {
  return {
    user: {
      id: actor.id,
      name: actor.name,
      email: actor.email,
      image: actor.image ?? null
    },
    role: actor.role,
    capabilities: capabilitiesForRole(actor.role)
  };
}
