import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  select: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/server/db", () => ({
  db: dbMock
}));

import { apiStore } from "./store";

function installRoleQuery(rows: Array<{ role: string }>) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  dbMock.select.mockReturnValue({ from });
  return { orderBy, where, from };
}

function installGrantHarness(options: {
  actorRoles: Array<{ role: string }>;
  targetUser?: { id: string; deletionRequestedAt: Date | null };
  created?: Record<string, unknown>;
}) {
  const events: string[] = [];
  const auditRows: unknown[] = [];
  const targetUser = options.targetUser ?? {
    id: "target-1",
    deletionRequestedAt: null
  };
  let selectCount = 0;
  let insertCount = 0;

  const tx = {
    execute: vi.fn(async () => {
      events.push("lock");
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          selectCount += 1;
          if (selectCount === 1) {
            return {
              orderBy: vi.fn(async () => {
                events.push("actor-role");
                return options.actorRoles;
              })
            };
          }
          return {
            limit: vi.fn(() => ({
              for: vi.fn(async () => {
                events.push("target");
                return [targetUser];
              })
            }))
          };
        })
      }))
    })),
    insert: vi.fn(() => {
      insertCount += 1;
      if (insertCount === 1) {
        return {
          values: vi.fn(() => ({
            onConflictDoNothing: () => ({
              returning: vi.fn(async () => {
                events.push("grant");
                return [
                  options.created ?? { userId: targetUser.id, role: "support" }
                ];
              })
            })
          }))
        };
      }

      return {
        values: vi.fn(async (value: unknown) => {
          auditRows.push(value);
          events.push("audit");
        })
      };
    })
  };

  dbMock.transaction.mockImplementationOnce(
    async (callback: (transaction: typeof tx) => unknown) => callback(tx)
  );

  return { auditRows, events, tx };
}

describe("apiStore.getAdminRole fail-closed behavior", () => {
  it("returns null when a user has no admin roles", async () => {
    installRoleQuery([]);

    await expect(apiStore.getAdminRole("user-1")).resolves.toBeNull();
  });

  it("returns the only persisted role when exactly one exists", async () => {
    installRoleQuery([{ role: "support" }]);

    await expect(apiStore.getAdminRole("user-1")).resolves.toBe("support");
  });

  it("throws a conflict when multiple persisted roles exist", async () => {
    installRoleQuery([{ role: "support" }, { role: "admin" }]);

    await expect(apiStore.getAdminRole("user-1")).rejects.toMatchObject({
      status: 409,
      code: "ADMIN_ROLE_CONFLICT"
    });
  });
});

describe("apiStore admin-role mutation boundaries", () => {
  beforeEach(() => {
    dbMock.transaction.mockReset();
  });

  it("lets admin grant a professional role", async () => {
    const { auditRows, events } = installGrantHarness({
      actorRoles: [{ role: "admin" }],
      created: {
        userId: "target-1",
        role: "support",
        createdBy: "actor-1",
        createdAt: new Date("2026-08-08T00:00:00.000Z")
      }
    });

    await expect(
      apiStore.grantAdminRole("target-1", "support", {
        actor: {
          id: "actor-1",
          email: "actor@example.com",
          name: "Actor",
          image: null,
          banned: false,
          roleHint: "admin",
          role: "admin"
        },
        requestId: "request-1",
        path: "/api/admin/admins",
        method: "POST"
      })
    ).resolves.toMatchObject({ userId: "target-1", role: "support" });

    expect(events).toEqual(["lock", "actor-role", "target", "grant", "audit"]);
    expect(auditRows).toHaveLength(1);
  });

  it("blocks admin from granting owner roles", async () => {
    installGrantHarness({
      actorRoles: [{ role: "admin" }]
    });

    await expect(
      apiStore.grantAdminRole("target-1", "owner", {
        actor: {
          id: "actor-1",
          email: "actor@example.com",
          name: "Actor",
          image: null,
          banned: false,
          roleHint: "admin",
          role: "admin"
        },
        requestId: "request-1",
        path: "/api/admin/admins",
        method: "POST"
      })
    ).rejects.toMatchObject({
      status: 403,
      code: "OWNER_PROTECTED"
    });
  });
});
