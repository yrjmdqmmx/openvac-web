import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  transaction: vi.fn()
}));

vi.mock("@/server/db", () => ({
  db: dbMock
}));

import { apiStore } from "./store";
import type { AdminRole, AuditContext } from "./types";

type HarnessOptions = {
  actorRoles: AdminRole[];
  targetRoles: AdminRole[];
  updated?: Record<string, unknown>;
};

function audit(actorRole: AdminRole, actorId = "actor-1"): AuditContext {
  return {
    actor: {
      id: actorId,
      email: "actor@example.com",
      name: "Actor",
      banned: false,
      roleHint: actorRole,
      role: actorRole
    },
    requestId: "request-1",
    path: "/api/admin/users/target-1",
    method: "PATCH"
  };
}

function installTransactionHarness({
  actorRoles,
  targetRoles,
  updated = { id: "target-1" }
}: HarnessOptions) {
  const events: string[] = [];
  const auditRows: unknown[] = [];
  const roleResults = [
    actorRoles.map((role) => ({ role })),
    targetRoles.map((role) => ({ role }))
  ];

  const tx = {
    execute: vi.fn(async (query: unknown) => {
      void query;
      events.push("lock");
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => {
          const queryNumber = 2 - roleResults.length + 1;
          events.push(queryNumber === 1 ? "actor-role" : "target-role");
          return roleResults.shift() ?? [];
        })
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            events.push("update");
            return [updated];
          })
        }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => {
          events.push("revoke-sessions");
          return [{ id: "session-1" }, { id: "session-2" }];
        })
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (value: unknown) => {
        auditRows.push(value);
        events.push("audit");
      })
    }))
  };

  dbMock.transaction.mockImplementationOnce(
    async (callback: (transaction: typeof tx) => unknown) => callback(tx)
  );

  return { auditRows, events, tx };
}

describe("apiStore protected-user mutation final authorization", () => {
  beforeEach(() => {
    dbMock.transaction.mockReset();
  });

  it("rejects a ban when the target is owner at the locked write boundary", async () => {
    const { events, tx } = installTransactionHarness({
      actorRoles: ["admin"],
      targetRoles: ["owner"]
    });

    await expect(
      apiStore.setUserBan(
        "target-1",
        { banned: true, reason: "policy" },
        audit("admin")
      )
    ).rejects.toMatchObject({ status: 403, code: "OWNER_PROTECTED" });

    expect(events).toEqual(["lock", "actor-role", "target-role"]);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("rejects a quota update when a stale owner became admin before the write", async () => {
    const { events, tx } = installTransactionHarness({
      actorRoles: ["admin"],
      targetRoles: ["admin"]
    });

    await expect(
      apiStore.setUserQuotaBonus(
        "target-1",
        { dailyBonus: 100, reason: "temporary" },
        audit("owner")
      )
    ).rejects.toMatchObject({ status: 403, code: "ADMIN_PROTECTED" });

    expect(events).toEqual(["lock", "actor-role", "target-role"]);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("rejects a mutation when the actor lost users:write before locking", async () => {
    const { events, tx } = installTransactionHarness({
      actorRoles: ["support"],
      targetRoles: []
    });

    await expect(
      apiStore.setUserQuotaBonus(
        "target-1",
        { dailyBonus: 10, reason: "temporary" },
        audit("admin")
      )
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    expect(events).toEqual(["lock", "actor-role", "target-role"]);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("keeps self-ban protection inside the locked transaction", async () => {
    const { events, tx } = installTransactionHarness({
      actorRoles: ["owner"],
      targetRoles: ["owner"]
    });

    await expect(
      apiStore.setUserBan(
        "actor-1",
        { banned: true, reason: "mistake" },
        audit("owner")
      )
    ).rejects.toMatchObject({
      status: 409,
      code: "SELF_MANAGEMENT_FORBIDDEN"
    });

    expect(events).toEqual(["lock", "actor-role", "target-role"]);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("allows the current single owner to manage an owner and audits after update", async () => {
    const { auditRows, events, tx } = installTransactionHarness({
      actorRoles: ["owner"],
      targetRoles: ["owner"],
      updated: { id: "target-1", banned: false }
    });

    await expect(
      apiStore.setUserBan("target-1", { banned: false }, audit("admin"))
    ).resolves.toMatchObject({ id: "target-1", banned: false });

    expect(events).toEqual([
      "lock",
      "actor-role",
      "target-role",
      "update",
      "audit"
    ]);
    expect(JSON.stringify(tx.execute.mock.calls[0]?.[0])).toContain(
      "1967086382"
    );
    expect(auditRows).toEqual([
      expect.objectContaining({ actorUserId: "actor-1", actorRole: "owner" })
    ]);
  });

  it("allows a current admin to update a regular user's quota", async () => {
    const { events } = installTransactionHarness({
      actorRoles: ["admin"],
      targetRoles: [],
      updated: { id: "target-1", dailyQuotaBonus: 25 }
    });

    await expect(
      apiStore.setUserQuotaBonus(
        "target-1",
        { dailyBonus: 25, reason: "approved" },
        audit("admin")
      )
    ).resolves.toMatchObject({
      id: "target-1",
      dailyQuotaBonus: 25
    });

    expect(events).toEqual([
      "lock",
      "actor-role",
      "target-role",
      "update",
      "audit"
    ]);
  });

  it("revokes every existing session when a regular user is banned", async () => {
    const { auditRows, events, tx } = installTransactionHarness({
      actorRoles: ["admin"],
      targetRoles: [],
      updated: { id: "target-1", banned: true }
    });

    await expect(
      apiStore.setUserBan(
        "target-1",
        { banned: true, reason: "policy" },
        audit("admin")
      )
    ).resolves.toMatchObject({ id: "target-1", banned: true });

    expect(events).toEqual([
      "lock",
      "actor-role",
      "target-role",
      "update",
      "revoke-sessions",
      "audit"
    ]);
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(auditRows).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ sessionsRevoked: 2 })
      })
    ]);
  });
});
