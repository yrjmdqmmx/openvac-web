import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/server/db";
import { adminRoles, auditLogs, user as users } from "@/server/db/schema";

const bootstrapEmailSchema = z.email("必须提供有效的管理员邮箱。");

export type OwnerBootstrapEmail = {
  email: string;
  source: "argument" | "environment";
};

export type OwnerBootstrapUser = {
  id: string;
  emailVerified: boolean;
  banned: boolean;
};

export type OwnerBootstrapResult = {
  userId: string;
  outcome: "granted" | "already_owner";
};

export function resolveOwnerBootstrapEmail(
  args: string[],
  environment: object
): OwnerBootstrapEmail {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  let argumentEmail: string | undefined;

  if (normalizedArgs.length === 1) {
    const value = normalizedArgs[0];
    argumentEmail = value.startsWith("--email=")
      ? value.slice("--email=".length)
      : value;
  } else if (normalizedArgs.length === 2 && normalizedArgs[0] === "--email") {
    argumentEmail = normalizedArgs[1];
  } else if (normalizedArgs.length > 0) {
    throw new Error(
      "用法：pnpm admin:bootstrap-owner -- <email>，或设置 ADMIN_BOOTSTRAP_EMAIL。"
    );
  }

  const source = argumentEmail ? "argument" : "environment";
  const rawEmail =
    argumentEmail ??
    (environment as { ADMIN_BOOTSTRAP_EMAIL?: unknown }).ADMIN_BOOTSTRAP_EMAIL;
  if (rawEmail !== undefined && typeof rawEmail !== "string") {
    throw new Error("ADMIN_BOOTSTRAP_EMAIL 必须是字符串。");
  }
  if (!rawEmail?.trim()) {
    throw new Error(
      "缺少 owner 邮箱。请传入邮箱参数或设置 ADMIN_BOOTSTRAP_EMAIL。"
    );
  }

  return {
    email: bootstrapEmailSchema.parse(rawEmail.trim().toLowerCase()),
    source
  };
}

export function assertOwnerBootstrapUserEligible(
  candidate: OwnerBootstrapUser | undefined
): asserts candidate is OwnerBootstrapUser {
  if (!candidate) {
    throw new Error("找不到与该邮箱对应的已注册用户。");
  }
  if (!candidate.emailVerified) {
    throw new Error("只能将已完成邮箱验证的用户初始化为 owner。");
  }
  if (candidate.banned) {
    throw new Error("已停用的用户不能初始化为 owner。");
  }
}

export async function bootstrapOwnerByEmail(
  input: OwnerBootstrapEmail
): Promise<OwnerBootstrapResult> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        id: users.id,
        emailVerified: users.emailVerified,
        banned: users.banned
      })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email}`)
      .limit(1)
      .for("update");

    assertOwnerBootstrapUserEligible(candidate);

    const now = new Date();
    const inserted = await tx
      .insert(adminRoles)
      .values({
        userId: candidate.id,
        role: "owner",
        createdBy: candidate.id,
        createdAt: now
      })
      .onConflictDoNothing({
        target: [adminRoles.userId, adminRoles.role]
      })
      .returning({ userId: adminRoles.userId });
    const outcome = inserted.length > 0 ? "granted" : "already_owner";

    await tx.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: candidate.id,
      actorRole: "bootstrap",
      action: "admin.owner.bootstrap",
      targetType: "admin_role",
      targetId: candidate.id,
      requestId: crypto.randomUUID(),
      metadata: {
        channel: "cli",
        emailSource: input.source,
        outcome
      },
      createdAt: now
    });

    return { userId: candidate.id, outcome };
  });
}
