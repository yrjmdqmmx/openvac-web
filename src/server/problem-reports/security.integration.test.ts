import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { db, sqlClient } from "@/server/db";
import {
  adminRoles,
  auditLogs,
  problemReports,
  quotaBucket,
  user as users
} from "@/server/db/schema";
import {
  cleanupDeletedUser,
  isUserDeletionInProgress,
  prepareUserDeletion
} from "@/server/auth/account-cleanup";
import {
  AccountDeletionInProgressError,
  assertAccountWritable
} from "@/server/auth/account-write-barrier";
import { ApiError } from "@/server/api/errors";
import { apiStore } from "@/server/api/store";
import type { AuditContext, ProblemReportInput } from "@/server/api/types";

import { PROBLEM_REPORT_SUBMISSION_LIMIT } from "./submission-policy";

const describeDatabase =
  process.env.RUN_DATABASE_TESTS === "true" ? describe : describe.skip;

const createdUserIds = new Set<string>();
const createdAuditIds = new Set<string>();

function audit(userId: string, requestId = randomUUID()): AuditContext {
  return {
    actor: {
      id: userId,
      email: `${userId}@example.com`,
      name: "Integration user",
      banned: false,
      roleHint: null,
      role: "user"
    },
    requestId,
    path: "/api/problem-reports",
    method: "POST"
  };
}

async function createUser(prefix: string): Promise<string> {
  const id = `${prefix}-${randomUUID()}`;
  createdUserIds.add(id);
  await db.insert(users).values({
    id,
    name: "Security integration user",
    email: `${id}@example.com`,
    emailVerified: true
  });
  return id;
}

function reportInput(clientRequestId = randomUUID()): ProblemReportInput {
  return {
    clientRequestId,
    category: "system_error",
    description: "数据库并发安全回归测试。",
    includeContext: false,
    consentToContact: false
  };
}

afterEach(async () => {
  const auditIds = [...createdAuditIds];
  if (auditIds.length > 0) {
    await db.delete(auditLogs).where(inArray(auditLogs.id, auditIds));
  }

  const userIds = [...createdUserIds];
  if (userIds.length > 0) {
    await db.delete(auditLogs).where(inArray(auditLogs.actorUserId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }

  createdAuditIds.clear();
  createdUserIds.clear();
});

describeDatabase("problem-report database security boundaries", () => {
  it("serializes concurrent replays into one report and one audit event", async () => {
    const userId = await createUser("problem-idempotency");
    const input = reportInput();

    const results = await Promise.all([
      apiStore.createProblemReport(userId, input, audit(userId)),
      apiStore.createProblemReport(userId, input, audit(userId))
    ]);

    expect(results.every(Boolean)).toBe(true);
    expect(new Set(results.map((result) => result?.id)).size).toBe(1);
    expect(results.map((result) => result?.created).sort()).toEqual([
      false,
      true
    ]);

    const rows = await db
      .select({ id: problemReports.id })
      .from(problemReports)
      .where(eq(problemReports.userId, userId));
    const auditRows = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.actorUserId, userId),
          eq(auditLogs.action, "problem_report.create")
        )
      );

    expect(rows).toHaveLength(1);
    expect(auditRows).toHaveLength(1);
  });

  it("enforces the per-user window limit under concurrent unique requests", async () => {
    const userId = await createUser("problem-rate-limit");
    const submissions = Array.from(
      { length: PROBLEM_REPORT_SUBMISSION_LIMIT + 1 },
      () => apiStore.createProblemReport(userId, reportInput(), audit(userId))
    );

    const results = await Promise.allSettled(submissions);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(PROBLEM_REPORT_SUBMISSION_LIMIT);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ApiError
    );
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 429,
      code: "PROBLEM_REPORT_RATE_LIMITED"
    });

    const rows = await db
      .select({ id: problemReports.id })
      .from(problemReports)
      .where(eq(problemReports.userId, userId));
    expect(rows).toHaveLength(PROBLEM_REPORT_SUBMISSION_LIMIT);
  });

  it("removes account-linked audit payloads while preserving anonymous events", async () => {
    const deletedUserId = await createUser("deleted-audit-user");
    const administratorId = await createUser("audit-administrator");
    const actorRowId = randomUUID();
    const targetRowId = randomUUID();
    const unrelatedRowId = randomUUID();
    createdAuditIds.add(actorRowId);
    createdAuditIds.add(targetRowId);
    createdAuditIds.add(unrelatedRowId);

    await db.insert(auditLogs).values([
      {
        id: actorRowId,
        actorUserId: deletedUserId,
        actorRole: "user",
        action: "problem_report.create",
        targetType: "problem_report",
        targetId: randomUUID(),
        requestId: "linked-request",
        ipAddress: "192.0.2.1",
        userAgent: "linked-agent",
        before: { email: "before@example.com" },
        after: { email: "after@example.com" },
        metadata: { contactValue: "13800000000" }
      },
      {
        id: targetRowId,
        actorUserId: administratorId,
        actorRole: "admin",
        action: "user.ban",
        targetType: "user",
        targetId: deletedUserId,
        requestId: "target-request",
        before: { banned: false },
        after: { banned: true },
        metadata: { reason: "sensitive reason" }
      },
      {
        id: unrelatedRowId,
        actorUserId: administratorId,
        actorRole: "admin",
        action: "settings.update",
        targetType: "system_setting",
        targetId: "public-setting",
        requestId: "unrelated-request",
        metadata: { changedKeys: ["public"] }
      }
    ]);

    await prepareUserDeletion(deletedUserId);

    const rows = await db
      .select()
      .from(auditLogs)
      .where(inArray(auditLogs.id, [actorRowId, targetRowId, unrelatedRowId]));
    const actorRow = rows.find((row) => row.id === actorRowId);
    const targetRow = rows.find((row) => row.id === targetRowId);
    const unrelatedRow = rows.find((row) => row.id === unrelatedRowId);

    expect(actorRow).toMatchObject({
      actorUserId: null,
      targetId: null,
      requestId: null,
      ipAddress: null,
      userAgent: null,
      before: null,
      after: null,
      metadata: {}
    });
    expect(targetRow).toMatchObject({
      actorUserId: administratorId,
      targetId: null,
      requestId: null,
      before: null,
      after: null,
      metadata: {}
    });
    expect(unrelatedRow).toMatchObject({
      actorUserId: administratorId,
      targetId: "public-setting",
      requestId: "unrelated-request",
      metadata: { changedKeys: ["public"] }
    });
  });

  it("marks deletion pending and rejects later actor or user-target audit writes", async () => {
    const deletedUserId = await createUser("pending-deletion-user");
    const administratorId = await createUser("pending-deletion-admin");

    await prepareUserDeletion(deletedUserId);

    const [account] = await db
      .select({ deletionRequestedAt: users.deletionRequestedAt })
      .from(users)
      .where(eq(users.id, deletedUserId));
    expect(account?.deletionRequestedAt).toBeInstanceOf(Date);

    await expect(
      db.insert(auditLogs).values({
        actorUserId: deletedUserId,
        actorRole: "user",
        action: "late.write",
        targetType: "problem_report",
        targetId: randomUUID(),
        requestId: "late-actor-request",
        metadata: { secret: "must not persist" }
      })
    ).rejects.toThrow();

    await expect(
      db.insert(auditLogs).values({
        actorUserId: administratorId,
        actorRole: "admin",
        action: "late.target.write",
        targetType: "user",
        targetId: deletedUserId,
        requestId: "late-target-request",
        metadata: { secret: "must not persist" }
      })
    ).rejects.toThrow();
  });

  it("orders in-flight account writes before deletion and rejects later writes", async () => {
    const deletedUserId = await createUser("account-write-barrier-user");

    let writerLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      writerLocked = resolve;
    });
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });

    const writer = db.transaction(async (transaction) => {
      await assertAccountWritable(transaction, deletedUserId);
      writerLocked();
      await writerGate;
    });

    await locked;
    let preparationSettled = false;
    const preparation = prepareUserDeletion(deletedUserId);
    void preparation.then(
      () => {
        preparationSettled = true;
      },
      () => {
        preparationSettled = true;
      }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(preparationSettled).toBe(false);

    releaseWriter();
    await Promise.all([writer, preparation]);

    await expect(
      db.transaction((transaction) =>
        assertAccountWritable(transaction, deletedUserId)
      )
    ).rejects.toBeInstanceOf(AccountDeletionInProgressError);
  });

  it("does not allow an administrator role to be granted after deletion is pending", async () => {
    const deletedUserId = await createUser("pending-admin-target");
    const ownerId = await createUser("pending-admin-owner");
    await db.insert(adminRoles).values({
      userId: ownerId,
      role: "owner",
      createdBy: ownerId
    });
    await prepareUserDeletion(deletedUserId);

    await expect(
      apiStore.grantAdminRole(
        deletedUserId,
        "support",
        audit(ownerId, randomUUID())
      )
    ).rejects.toMatchObject({
      status: 409,
      code: "ACCOUNT_DELETION_IN_PROGRESS"
    });

    const targetRoles = await db
      .select({ role: adminRoles.role })
      .from(adminRoles)
      .where(eq(adminRoles.userId, deletedUserId));
    expect(targetRoles).toHaveLength(0);
  });

  it("scrubs the target account identifier from role-revocation audit rows before deletion", async () => {
    const deletedUserId = await createUser("revoked-admin-target");
    const ownerId = await createUser("revoked-admin-owner");
    await db.insert(adminRoles).values([
      {
        userId: ownerId,
        role: "owner",
        createdBy: ownerId
      },
      {
        userId: deletedUserId,
        role: "support",
        createdBy: ownerId
      }
    ]);

    const revoked = await apiStore.revokeAdminRole(
      deletedUserId,
      "support",
      audit(ownerId, randomUUID())
    );
    expect(revoked).not.toBeNull();

    await prepareUserDeletion(deletedUserId);
    await db.delete(users).where(eq(users.id, deletedUserId));

    const [row] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.actorUserId, ownerId),
          eq(auditLogs.action, "admin_role.revoke")
        )
      )
      .limit(1);

    expect(row).toMatchObject({
      actorUserId: ownerId,
      targetId: null,
      requestId: null,
      before: null,
      after: null,
      metadata: {}
    });
    expect(JSON.stringify(row)).not.toContain(deletedUserId);
  });

  it("removes the user-scoped quota bucket before afterDelete can run", async () => {
    const deletedUserId = await createUser("quota-bucket-delete-target");
    const bucketId = randomUUID();
    await db.insert(quotaBucket).values({
      id: bucketId,
      resource: "answer",
      scopeType: "user",
      scopeKey: deletedUserId,
      windowKey: "2099-12-30",
      limitValue: 20,
      committedUnits: 3,
      resetAt: new Date("2099-12-31T08:00:00.000Z")
    });

    // prepareUserDeletion is the beforeDelete phase. Deliberately do not call
    // cleanupDeletedUser so this exercises the process-crash window.
    await prepareUserDeletion(deletedUserId);

    const rows = await db
      .select({ id: quotaBucket.id })
      .from(quotaBucket)
      .where(eq(quotaBucket.id, bucketId));
    expect(rows).toHaveLength(0);
  });

  it("serializes an in-flight audit writer before marking and scrubbing deletion", async () => {
    const deletedUserId = await createUser("concurrent-deletion-user");
    const auditId = randomUUID();
    createdAuditIds.add(auditId);

    let writerInserted!: () => void;
    const inserted = new Promise<void>((resolve) => {
      writerInserted = resolve;
    });
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });

    const writer = sqlClient.begin(async (transaction) => {
      await transaction`
        insert into audit_log (
          id, actor_user_id, actor_role, action, target_type, target_id,
          request_id, metadata
        ) values (
          ${auditId}, ${deletedUserId}, 'user', 'concurrent.write',
          'problem_report', ${randomUUID()}, 'concurrent-request',
          ${JSON.stringify({ secret: "must be scrubbed" })}::jsonb
        )
      `;
      writerInserted();
      await writerGate;
    });

    await inserted;
    let preparationSettled = false;
    const preparation = prepareUserDeletion(deletedUserId);
    void preparation.then(
      () => {
        preparationSettled = true;
      },
      () => {
        preparationSettled = true;
      }
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(preparationSettled).toBe(false);

    releaseWriter();
    await Promise.all([writer, preparation]);

    const [row] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.id, auditId));
    expect(row).toMatchObject({
      actorUserId: null,
      targetId: null,
      requestId: null,
      metadata: {}
    });
  });

  it("anonymizes audit rows in the database transaction before the user FK is cleared", async () => {
    const deletedUserId = await createUser("trigger-deletion-user");
    const administratorId = await createUser("trigger-deletion-admin");
    const actorRowId = randomUUID();
    const targetRowId = randomUUID();
    createdAuditIds.add(actorRowId);
    createdAuditIds.add(targetRowId);

    await db.insert(auditLogs).values([
      {
        id: actorRowId,
        actorUserId: deletedUserId,
        actorRole: "user",
        action: "actor.before.delete",
        targetType: "problem_report",
        targetId: randomUUID(),
        requestId: "actor-before-delete",
        metadata: { secret: "actor" }
      },
      {
        id: targetRowId,
        actorUserId: administratorId,
        actorRole: "admin",
        action: "target.before.delete",
        targetType: "user",
        targetId: deletedUserId,
        requestId: "target-before-delete",
        metadata: { secret: "target" }
      }
    ]);

    await db.delete(users).where(eq(users.id, deletedUserId));
    await cleanupDeletedUser(deletedUserId);
    expect(await isUserDeletionInProgress(deletedUserId)).toBe(true);

    const rows = await db
      .select()
      .from(auditLogs)
      .where(inArray(auditLogs.id, [actorRowId, targetRowId]));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        targetId: null,
        requestId: null,
        ipAddress: null,
        userAgent: null,
        before: null,
        after: null,
        metadata: {}
      });
    }
    expect(rows.find((row) => row.id === actorRowId)?.actorUserId).toBeNull();
    expect(rows.find((row) => row.id === targetRowId)?.actorUserId).toBe(
      administratorId
    );
  });
});
