import { and, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { adminRoles, quotaBucket, quotaLedger } from "@/server/db/schema";

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

/**
 * Return in-flight units before Better Auth removes the user and cascades the
 * corresponding ledger rows. Committed units intentionally remain counted for
 * the current day.
 */
export async function prepareUserDeletion(userId: string): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(1967086382)`);
    const roleAssignments = await transaction
      .select({ role: adminRoles.role })
      .from(adminRoles)
      .where(eq(adminRoles.userId, userId))
      .for("update");
    assertUserCanSelfDelete(roleAssignments);

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
  });
}

export async function cleanupDeletedUser(userId: string): Promise<void> {
  await db
    .delete(quotaBucket)
    .where(
      and(eq(quotaBucket.scopeType, "user"), eq(quotaBucket.scopeKey, userId))
    );
}
