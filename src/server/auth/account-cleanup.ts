import { and, eq, or, sql } from "drizzle-orm";

import { accountAvatarObjectKey } from "@/server/account/avatar-key";
import { db } from "@/server/db";
import { getObjectStorage } from "@/server/providers";
import {
  adminRoles,
  auditLogs,
  quotaBucket,
  quotaLedger,
  user as users
} from "@/server/db/schema";

export class AdminAccountDeletionForbiddenError extends Error {
  readonly code = "ADMIN_ACCOUNT_DELETION_FORBIDDEN";

  constructor() {
    super("Administrator role assignments must be removed before deletion");
    this.name = "AdminAccountDeletionForbiddenError";
  }
}

export function assertUserCanSelfDelete(
  roleAssignments: ReadonlyArray<{ role: string }>
): void {
  if (roleAssignments.length > 0) {
    throw new AdminAccountDeletionForbiddenError();
  }
}

function auditReferencesUser(userId: string) {
  return or(
    eq(auditLogs.actorUserId, userId),
    and(eq(auditLogs.targetType, "user"), eq(auditLogs.targetId, userId)),
    and(
      eq(auditLogs.targetType, "admin_role"),
      or(
        sql`split_part(coalesce(${auditLogs.targetId}, ''), ':', 1) = ${userId}`,
        sql`${auditLogs.metadata} ->> 'targetUserId' = ${userId}`
      )
    )
  );
}

function anonymizedAuditTargetId(userId: string) {
  return sql`case
    when ${auditLogs.actorUserId} = ${userId}
      or (${auditLogs.targetType} = 'user' and ${auditLogs.targetId} = ${userId})
      or (
        ${auditLogs.targetType} = 'admin_role'
        and (
          split_part(coalesce(${auditLogs.targetId}, ''), ':', 1) = ${userId}
          or ${auditLogs.metadata} ->> 'targetUserId' = ${userId}
        )
      )
      then null
    else ${auditLogs.targetId}
  end`;
}

/**
 * Return in-flight units before Better Auth removes the user and cascades the
 * corresponding ledger rows. Global committed units remain counted for the
 * current day; the account-keyed user bucket is removed in this transaction.
 */
export async function prepareUserDeletion(userId: string): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(1967086382)`);
    const [account] = await transaction
      .select({
        id: users.id,
        deletionRequestedAt: users.deletionRequestedAt
      })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");

    if (!account) {
      return;
    }

    const roleAssignments = await transaction
      .select({ role: adminRoles.role })
      .from(adminRoles)
      .where(eq(adminRoles.userId, userId))
      .for("update");
    assertUserCanSelfDelete(roleAssignments);

    await transaction
      .update(users)
      .set({
        deletionRequestedAt: account.deletionRequestedAt ?? new Date(),
        updatedAt: new Date()
      })
      .where(eq(users.id, userId));

    const outstanding = await transaction
      .select()
      .from(quotaLedger)
      .where(
        and(
          eq(quotaLedger.actorUserId, userId),
          eq(quotaLedger.status, "reserved")
        )
      )
      .for("update");

    for (const entry of outstanding) {
      await transaction
        .update(quotaBucket)
        .set({
          reservedUnits: sql`${quotaBucket.reservedUnits} - ${entry.units}`,
          updatedAt: new Date()
        })
        .where(eq(quotaBucket.id, entry.bucketId));

      await transaction
        .update(quotaLedger)
        .set({
          status: "released",
          releaseReason: "account_deleted",
          releasedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(quotaLedger.id, entry.id));
    }

    // Keep only anonymous event statistics once the account is deleted. Rows
    // created by the user lose their actor linkage; rows targeting the user
    // lose the target identifier. Request correlation and free-form payloads
    // are cleared for both cases because they can carry personal data.
    await transaction
      .update(auditLogs)
      .set({
        actorUserId: sql`case
          when ${auditLogs.actorUserId} = ${userId} then null
          else ${auditLogs.actorUserId}
        end`,
        targetId: anonymizedAuditTargetId(userId),
        requestId: null,
        ipAddress: null,
        userAgent: null,
        before: null,
        after: null,
        metadata: {}
      })
      .where(auditReferencesUser(userId));

    // The user-scoped bucket is keyed by the account identifier and has no
    // user foreign key. Remove it before Better Auth deletes the account so a
    // crash between deleteUser and afterDelete cannot retain that identifier.
    // Any reserved global-scope entries were released above; user-scope ledger
    // rows are removed by the bucket's cascade.
    await transaction
      .delete(quotaBucket)
      .where(
        and(eq(quotaBucket.scopeType, "user"), eq(quotaBucket.scopeKey, userId))
      );
  });
}

export async function cleanupDeletedUser(userId: string): Promise<void> {
  await db.transaction(async (transaction) => {
    // Better Auth runs afterDelete outside the beforeDelete transaction. Scan
    // once more after the actual user deletion so a late row can never retain
    // request correlation or free-form personal data.
    await transaction
      .update(auditLogs)
      .set({
        actorUserId: sql`case
          when ${auditLogs.actorUserId} = ${userId} then null
          else ${auditLogs.actorUserId}
        end`,
        targetId: anonymizedAuditTargetId(userId),
        requestId: null,
        ipAddress: null,
        userAgent: null,
        before: null,
        after: null,
        metadata: {}
      })
      .where(auditReferencesUser(userId));

    await transaction
      .delete(quotaBucket)
      .where(
        and(eq(quotaBucket.scopeType, "user"), eq(quotaBucket.scopeKey, userId))
      );
  });

  // The private avatar key is derived from the deleted account identifier, so
  // it remains recoverable after the user row has cascaded away. Missing
  // objects are success; cleanup failures must not resurrect a deleted user.
  await getObjectStorage()
    .deletePrivate(accountAvatarObjectKey(userId))
    .catch(() => undefined);
}

export async function isUserDeletionInProgress(
  userId: string
): Promise<boolean> {
  const [account] = await db
    .select({ deletionRequestedAt: users.deletionRequestedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return !account || account.deletionRequestedAt != null;
}
