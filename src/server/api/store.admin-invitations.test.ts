import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  select: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/server/db", () => ({
  db: dbMock
}));

import { apiStore } from "./store";

function makeAudit(role: "owner" | "admin" | "user") {
  return {
    actor: {
      id: "actor-1",
      email: "actor@example.com",
      name: "Actor",
      image: null,
      banned: false,
      roleHint: role === "user" ? null : role,
      role
    },
    requestId: "request-1",
    path: "/api/admin/invitations",
    method: "POST"
  } as const;
}

describe("apiStore admin invitation workflow", () => {
  beforeEach(() => {
    dbMock.select.mockReset();
    dbMock.transaction.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
  });

  it("creates an invitation with normalized email and a 48h expiry", async () => {
    const insertedInvitationRows: Array<Record<string, unknown>> = [];
    const insertedAuditRows: Array<Record<string, unknown>> = [];
    let insertCount = 0;
    const tx = {
      execute: vi.fn(),
      insert: vi.fn(() => {
        insertCount += 1;
        if (insertCount === 1) {
          return {
            values: vi.fn((value: Record<string, unknown>) => ({
              onConflictDoNothing: () => ({
                returning: vi.fn(async () => {
                  insertedInvitationRows.push(value);
                  return [
                    {
                      id: "invitation-1",
                      email: value.email,
                      role: value.role,
                      createdBy: value.createdBy,
                      acceptedBy: null,
                      acceptedAt: null,
                      revokedAt: null,
                      createdAt: value.createdAt,
                      expiresAt: value.expiresAt
                    }
                  ];
                })
              })
            }))
          };
        }

        return {
          values: vi.fn(async (value: Record<string, unknown>) => {
            insertedAuditRows.push(value);
          })
        };
      })
    };

    dbMock.transaction.mockImplementationOnce(
      async (callback: (transaction: typeof tx) => unknown) => callback(tx)
    );

    await expect(
      apiStore.createAdminInvitation(
        {
          email: "Owner@Example.com",
          role: "support",
          tokenHash: "a".repeat(64)
        },
        makeAudit("owner")
      )
    ).resolves.toMatchObject({
      id: "invitation-1",
      email: "owner@example.com",
      role: "support",
      createdBy: "actor-1"
    });

    expect(insertedInvitationRows[0]).toMatchObject({
      email: "owner@example.com",
      role: "support",
      tokenHash: "a".repeat(64),
      createdBy: "actor-1",
      createdAt: new Date("2026-08-08T00:00:00.000Z"),
      expiresAt: new Date("2026-08-10T00:00:00.000Z")
    });
    expect(insertedAuditRows[0]).toMatchObject({
      action: "admin_invitation.create",
      targetType: "admin_invitation",
      targetId: "invitation-1"
    });
  });

  it("blocks an admin from inviting owner roles", async () => {
    await expect(
      apiStore.createAdminInvitation(
        {
          email: "owner@example.com",
          role: "owner",
          tokenHash: "b".repeat(64)
        },
        makeAudit("admin")
      )
    ).rejects.toMatchObject({
      status: 403,
      code: "OWNER_PROTECTED"
    });
  });

  it("accepts an invitation exactly once and writes the role inside one transaction", async () => {
    const invitationRows = [
      {
        id: "invitation-1",
        email: "owner@example.com",
        role: "support",
        createdBy: "actor-1",
        acceptedBy: null,
        acceptedAt: null,
        revokedAt: null,
        createdAt: new Date("2026-08-08T00:00:00.000Z"),
        expiresAt: new Date("2026-08-10T00:00:00.000Z")
      }
    ];
    const existingRoles: Array<{ role: string }> = [];
    const insertedRoleRows: Array<Record<string, unknown>> = [];
    const updatedInvitationRows: Array<Record<string, unknown>> = [];
    const insertedAuditRows: Array<Record<string, unknown>> = [];
    const events: string[] = [];
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
                limit: vi.fn(() => ({
                  for: vi.fn(async () => {
                    events.push("invitation");
                    return invitationRows;
                  })
                }))
              };
            }

            return {
              orderBy: vi.fn(async () => {
                events.push("roles");
                return existingRoles;
              })
            };
          })
        }))
      })),
      insert: vi.fn(() => {
        insertCount += 1;
        if (insertCount === 1) {
          return {
            values: vi.fn((value: Record<string, unknown>) => ({
              onConflictDoNothing: () => ({
                returning: vi.fn(async () => {
                  insertedRoleRows.push(value);
                  events.push("grant");
                  return [
                    {
                      userId: "user-1",
                      role: "support",
                      createdBy: "actor-1",
                      createdAt: new Date("2026-08-08T00:00:00.000Z")
                    }
                  ];
                })
              })
            }))
          };
        }

        return {
          values: vi.fn(async (value: Record<string, unknown>) => {
            insertedAuditRows.push(value);
            events.push("audit");
          })
        };
      }),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              updatedInvitationRows.push({
                acceptedBy: "user-1",
                acceptedAt: new Date("2026-08-08T00:00:00.000Z")
              });
              events.push("accept");
              return [
                {
                  ...invitationRows[0],
                  acceptedBy: "user-1",
                  acceptedAt: new Date("2026-08-08T00:00:00.000Z")
                }
              ];
            })
          }))
        }))
      }))
    };

    dbMock.transaction.mockImplementationOnce(
      async (callback: (transaction: typeof tx) => unknown) => callback(tx)
    );

    await expect(
      apiStore.acceptAdminInvitation(
        {
          tokenHash: "c".repeat(64),
          userId: "user-1",
          userEmail: "owner@example.com",
          emailVerified: true
        },
        {
          actor: {
            id: "user-1",
            email: "owner@example.com",
            name: "Owner",
            image: null,
            banned: false,
            roleHint: null,
            role: "user"
          },
          requestId: "request-1",
          path: "/api/admin/invitations/accept",
          method: "POST"
        }
      )
    ).resolves.toMatchObject({
      id: "invitation-1",
      acceptedBy: "user-1",
      acceptedAt: new Date("2026-08-08T00:00:00.000Z")
    });

    expect(events).toEqual([
      "lock",
      "invitation",
      "roles",
      "grant",
      "accept",
      "audit"
    ]);
    expect(insertedRoleRows[0]).toMatchObject({
      userId: "user-1",
      role: "support",
      createdBy: "actor-1"
    });
    expect(updatedInvitationRows[0]).toMatchObject({
      acceptedBy: "user-1",
      acceptedAt: new Date("2026-08-08T00:00:00.000Z")
    });
    expect(insertedAuditRows).toHaveLength(1);
  });

  it("reports admin-role conflicts with only counts and user ids", async () => {
    const from = vi.fn(() => ({
      groupBy: vi.fn(() => ({
        having: vi.fn(() => ({
          orderBy: vi.fn(async () => [
            { userId: "user-a", roleCount: 2 },
            { userId: "user-b", roleCount: 3 }
          ])
        }))
      }))
    }));
    dbMock.select.mockReturnValue({ from });

    await expect(apiStore.reportAdminRoleConflicts()).resolves.toEqual({
      count: 2,
      userIds: ["user-a", "user-b"]
    });
  });
});
