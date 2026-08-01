import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { user as users } from "@/server/db/schema";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class AccountDeletionInProgressError extends Error {
  readonly code = "ACCOUNT_DELETION_IN_PROGRESS";

  constructor() {
    super("Account deletion is in progress");
    this.name = "AccountDeletionInProgressError";
  }
}

/**
 * Hold a key-share lock for the rest of the caller's transaction. This makes
 * the write and prepareUserDeletion's row update mutually ordered: a write
 * that wins completes before deletion preparation, while a write that loses
 * observes the persisted deletion marker and fails closed.
 */
export async function assertAccountWritable(
  transaction: Transaction,
  userId: string
): Promise<void> {
  const [account] = await transaction
    .select({ deletionRequestedAt: users.deletionRequestedAt })
    .from(users)
    .where(eq(users.id, userId))
    .for("key share");

  if (!account || account.deletionRequestedAt) {
    throw new AccountDeletionInProgressError();
  }
}
