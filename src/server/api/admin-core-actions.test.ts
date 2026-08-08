import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiStore } from "./types";

const authMocks = vi.hoisted(() => ({ getSession: vi.fn() }));
const cleanupMocks = vi.hoisted(() => ({
  isUserDeletionInProgress: vi.fn()
}));

vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: authMocks.getSession } }
}));
vi.mock("@/server/auth/account-cleanup", () => cleanupMocks);

import { handleReplaceAdminRole, handleRevokeUserSessions } from "./admin";

const partialStore = (value: Partial<ApiStore>) => value as ApiStore;

beforeEach(() => {
  authMocks.getSession.mockReset();
  cleanupMocks.isUserDeletionInProgress.mockReset();
  cleanupMocks.isUserDeletionInProgress.mockResolvedValue(false);
  authMocks.getSession.mockResolvedValue({
    session: { id: "session-1" },
    user: {
      id: "owner-1",
      name: "Owner",
      email: "owner@example.com",
      emailVerified: true,
      banned: false
    }
  });
});

describe("admin core mutation handlers", () => {
  it("replaces a role atomically with the expected current role", async () => {
    const replaceAdminRole = vi.fn().mockResolvedValue({
      userId: "admin-2",
      role: "analyst"
    });
    const response = await handleReplaceAdminRole(
      new Request("https://openvac.test/api/admin/admins", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "admin-2",
          expectedRole: "support",
          role: "analyst"
        })
      }),
      partialStore({
        getAdminRole: vi.fn().mockResolvedValue("owner"),
        replaceAdminRole
      })
    );

    expect(response.status).toBe(200);
    expect(replaceAdminRole).toHaveBeenCalledWith(
      "admin-2",
      "support",
      "analyst",
      expect.objectContaining({
        actor: expect.objectContaining({ role: "owner" })
      })
    );
  });

  it("rejects a no-op role replacement", async () => {
    const replaceAdminRole = vi.fn();
    const response = await handleReplaceAdminRole(
      new Request("https://openvac.test/api/admin/admins", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "admin-2",
          expectedRole: "support",
          role: "support"
        })
      }),
      partialStore({
        getAdminRole: vi.fn().mockResolvedValue("owner"),
        replaceAdminRole
      })
    );

    expect(response.status).toBe(422);
    expect(replaceAdminRole).not.toHaveBeenCalled();
  });

  it("revokes all sessions for a managed user with an audited reason", async () => {
    const revokeUserSessions = vi.fn().mockResolvedValue({
      userId: "user-2",
      revokedSessions: 3
    });
    const response = await handleRevokeUserSessions(
      new Request("https://openvac.test/api/admin/users/user-2/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "账号安全处置" })
      }),
      "user-2",
      partialStore({
        getAdminRole: vi
          .fn()
          .mockResolvedValueOnce("admin")
          .mockResolvedValueOnce(null),
        revokeUserSessions
      })
    );

    expect(response.status).toBe(200);
    expect(revokeUserSessions).toHaveBeenCalledWith(
      "user-2",
      "账号安全处置",
      expect.objectContaining({
        actor: expect.objectContaining({ role: "admin" })
      })
    );
  });
});
