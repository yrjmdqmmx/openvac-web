import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { prepareUserDeletion } from "@/server/auth/account-cleanup";
import { db } from "@/server/db";
import { quotaBucket, quotaLedger, user as users } from "@/server/db/schema";

import {
  commitQuotaInTransaction,
  PostgresQuotaRepository
} from "./repository";
import { QuotaService } from "./service";
import {
  QuotaAccountDeletionPendingError,
  QuotaExceededError,
  type QuotaResource
} from "./types";

const describeDatabase =
  process.env.RUN_DATABASE_TESTS === "true" ? describe : describe.skip;

const TEST_AT = new Date("2099-12-31T08:00:00.000Z");
const TEST_WINDOW_KEY = "2099-12-31";
const createdUserIds = new Set<string>();

async function createUser(prefix: string): Promise<string> {
  const id = `${prefix}-${randomUUID()}`;
  createdUserIds.add(id);
  await db.insert(users).values({
    id,
    name: "Model-attempt quota integration user",
    email: `${id}@example.com`,
    emailVerified: true
  });
  return id;
}

function service(input: { userLimit: number; globalLimit: number }) {
  return new QuotaService(
    new PostgresQuotaRepository(),
    {
      answerDaily: 20,
      webSearchUserDaily: 5,
      webSearchGlobalDaily: 500,
      modelAttemptUserDaily: input.userLimit,
      modelAttemptGlobalDaily: input.globalLimit
    },
    async () => 0
  );
}

afterEach(async () => {
  await db
    .delete(quotaBucket)
    .where(eq(quotaBucket.windowKey, TEST_WINDOW_KEY));

  const userIds = [...createdUserIds];
  if (userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, userIds));
  }
  createdUserIds.clear();
});

describeDatabase("model-attempt database quota", () => {
  it("rolls back a transaction-scoped answer commit with its caller transaction", async () => {
    const userId = await createUser("answer-atomic-rollback");
    const quota = service({ userLimit: 10, globalLimit: 100 });
    const reservation = await quota.reserve({
      userId,
      clientRequestId: randomUUID(),
      resource: "answer",
      at: TEST_AT
    });

    await expect(
      db.transaction(async (transaction) => {
        const committed = await commitQuotaInTransaction(transaction, {
          leaseId: reservation.leaseId,
          actorUserId: userId
        });
        expect(committed.status).toBe("committed");
        throw new Error("rollback caller transaction");
      })
    ).rejects.toThrow("rollback caller transaction");

    const ledger = await db
      .select({ status: quotaLedger.status })
      .from(quotaLedger)
      .where(eq(quotaLedger.leaseId, reservation.leaseId));
    expect(ledger).toEqual([{ status: "reserved" }]);

    const [bucket] = await db
      .select({
        reserved: quotaBucket.reservedUnits,
        committed: quotaBucket.committedUnits
      })
      .from(quotaBucket)
      .where(
        and(
          eq(quotaBucket.resource, "answer"),
          eq(quotaBucket.scopeType, "user"),
          eq(quotaBucket.scopeKey, userId),
          eq(quotaBucket.windowKey, TEST_WINDOW_KEY)
        )
      );
    expect(bucket).toEqual({ reserved: 1, committed: 0 });

    await quota.release({
      leaseId: reservation.leaseId,
      userId,
      reason: "test_cleanup"
    });
  });

  it.each<QuotaResource>(["answer", "web_search", "model_attempt"])(
    "fails closed for %s without creating buckets when account deletion is pending",
    async (resource) => {
      const userId = await createUser("model-attempt-deleting");
      await db
        .update(users)
        .set({ deletionRequestedAt: new Date() })
        .where(eq(users.id, userId));

      await expect(
        service({ userLimit: 10, globalLimit: 100 }).reserve({
          userId,
          clientRequestId: randomUUID(),
          resource,
          at: TEST_AT
        })
      ).rejects.toBeInstanceOf(QuotaAccountDeletionPendingError);

      const buckets = await db
        .select({ id: quotaBucket.id })
        .from(quotaBucket)
        .where(
          and(
            eq(quotaBucket.resource, resource),
            eq(quotaBucket.windowKey, TEST_WINDOW_KEY)
          )
        );
      expect(buckets).toHaveLength(0);
    }
  );

  it("serializes reserve with deletion and leaves no reserved units", async () => {
    const userId = await createUser("model-attempt-delete-race");
    const quota = service({ userLimit: 10, globalLimit: 100 });

    const [reserveResult, deletionResult] = await Promise.allSettled([
      quota.reserve({
        userId,
        clientRequestId: randomUUID(),
        resource: "model_attempt",
        at: TEST_AT
      }),
      prepareUserDeletion(userId)
    ]);

    expect(deletionResult.status).toBe("fulfilled");
    if (reserveResult.status === "rejected") {
      expect(reserveResult.reason).toBeInstanceOf(
        QuotaAccountDeletionPendingError
      );
    }

    const ledger = await db
      .select({ status: quotaLedger.status })
      .from(quotaLedger)
      .where(
        and(
          eq(quotaLedger.actorUserId, userId),
          eq(quotaLedger.resource, "model_attempt")
        )
      );
    expect(ledger.every((entry) => entry.status !== "reserved")).toBe(true);

    const buckets = await db
      .select({
        scopeType: quotaBucket.scopeType,
        scopeKey: quotaBucket.scopeKey,
        reserved: quotaBucket.reservedUnits
      })
      .from(quotaBucket)
      .where(
        and(
          eq(quotaBucket.resource, "model_attempt"),
          eq(quotaBucket.windowKey, TEST_WINDOW_KEY)
        )
      );
    expect(
      buckets.some(
        (bucket) => bucket.scopeType === "user" && bucket.scopeKey === userId
      )
    ).toBe(false);
    expect(buckets.every((bucket) => bucket.reserved === 0)).toBe(true);
  });

  it("serializes a quota transition with deletion without deadlock or reserved leakage", async () => {
    const userId = await createUser("model-attempt-transition-delete-race");
    const quota = service({ userLimit: 10, globalLimit: 100 });
    const reservation = await quota.reserve({
      userId,
      clientRequestId: randomUUID(),
      resource: "model_attempt",
      at: TEST_AT
    });

    const [transitionResult, deletionResult] = await Promise.allSettled([
      quota.commit({ leaseId: reservation.leaseId, userId }),
      prepareUserDeletion(userId)
    ]);

    expect(deletionResult.status).toBe("fulfilled");
    expect(transitionResult.status).toBe("fulfilled");
    if (transitionResult.status === "fulfilled") {
      expect(["committed", "released"]).toContain(
        transitionResult.value.status
      );
    }

    const ledger = await db
      .select({ status: quotaLedger.status })
      .from(quotaLedger)
      .where(
        and(
          eq(quotaLedger.actorUserId, userId),
          eq(quotaLedger.resource, "model_attempt")
        )
      );
    expect(ledger.every((entry) => entry.status !== "reserved")).toBe(true);

    const buckets = await db
      .select({
        scopeType: quotaBucket.scopeType,
        scopeKey: quotaBucket.scopeKey,
        reserved: quotaBucket.reservedUnits
      })
      .from(quotaBucket)
      .where(
        and(
          eq(quotaBucket.resource, "model_attempt"),
          eq(quotaBucket.windowKey, TEST_WINDOW_KEY)
        )
      );
    expect(
      buckets.some(
        (bucket) => bucket.scopeType === "user" && bucket.scopeKey === userId
      )
    ).toBe(false);
    expect(buckets.every((bucket) => bucket.reserved === 0)).toBe(true);
  });

  it("atomically limits concurrent attempts across independent app replicas", async () => {
    const userId = await createUser("model-attempt-user-limit");
    const replicaA = service({ userLimit: 1, globalLimit: 100 });
    const replicaB = service({ userLimit: 1, globalLimit: 100 });
    let providerCalls = 0;

    const reserveCommitAndInvoke = async (
      quota: QuotaService,
      clientRequestId: string
    ) => {
      const reservation = await quota.reserve({
        userId,
        clientRequestId,
        resource: "model_attempt",
        at: TEST_AT
      });
      const committed = await quota.commit({
        leaseId: reservation.leaseId,
        userId
      });
      expect(committed.status).toBe("committed");
      providerCalls += 1;
    };

    const results = await Promise.allSettled([
      reserveCommitAndInvoke(replicaA, randomUUID()),
      reserveCommitAndInvoke(replicaB, randomUUID())
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      QuotaExceededError
    );
    expect(providerCalls).toBe(1);

    await expect(
      replicaB.reserve({
        userId,
        clientRequestId: randomUUID(),
        resource: "model_attempt",
        at: TEST_AT
      })
    ).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      resource: "model_attempt",
      scopeType: "user"
    });

    const buckets = await db
      .select({
        scopeType: quotaBucket.scopeType,
        reserved: quotaBucket.reservedUnits,
        committed: quotaBucket.committedUnits
      })
      .from(quotaBucket)
      .where(
        and(
          eq(quotaBucket.resource, "model_attempt"),
          eq(quotaBucket.windowKey, TEST_WINDOW_KEY)
        )
      );
    expect(buckets).toHaveLength(2);
    expect(buckets).toEqual(
      expect.arrayContaining([
        { scopeType: "global", reserved: 0, committed: 1 },
        { scopeType: "user", reserved: 0, committed: 1 }
      ])
    );
  });

  it("atomically enforces the full-site limit across different users", async () => {
    const userA = await createUser("model-attempt-global-a");
    const userB = await createUser("model-attempt-global-b");
    const replicaA = service({ userLimit: 10, globalLimit: 1 });
    const replicaB = service({ userLimit: 10, globalLimit: 1 });

    const results = await Promise.allSettled([
      replicaA.reserve({
        userId: userA,
        clientRequestId: randomUUID(),
        resource: "model_attempt",
        at: TEST_AT
      }),
      replicaB.reserve({
        userId: userB,
        clientRequestId: randomUUID(),
        resource: "model_attempt",
        at: TEST_AT
      })
    ]);
    const fulfilled = results.filter(
      (
        result
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<QuotaService["reserve"]>>
      > => result.status === "fulfilled"
    );
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "QUOTA_EXCEEDED",
      resource: "model_attempt",
      scopeType: "global"
    });

    const winner = fulfilled[0]!.value;
    const committed = await replicaA.commit({
      leaseId: winner.leaseId,
      userId: winner.actorUserId
    });
    expect(committed.status).toBe("committed");
  });
});
