import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiStore } from "./types";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn()
}));
const accountCleanupMocks = vi.hoisted(() => ({
  isUserDeletionInProgress: vi.fn()
}));

vi.mock("@/server/auth", () => ({
  auth: {
    api: {
      getSession: authMocks.getSession
    }
  }
}));
vi.mock("@/server/auth/account-cleanup", () => accountCleanupMocks);

import {
  handleAcceptAdminInvitation,
  handleCreateAdminInvitation,
  handleDeleteAdminInvitation,
  handleListAdminInvitations
} from "./admin";

function partialStore(overrides: Partial<ApiStore>): ApiStore {
  return overrides as ApiStore;
}

function jsonRequest(path: string, body: unknown, method = "POST"): Request {
  return new Request(`https://openvac.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-1"
    },
    body: JSON.stringify(body)
  });
}

describe("admin invitation handlers", () => {
  beforeEach(() => {
    authMocks.getSession.mockReset();
    accountCleanupMocks.isUserDeletionInProgress.mockReset();
    accountCleanupMocks.isUserDeletionInProgress.mockResolvedValue(false);
    authMocks.getSession.mockResolvedValue({
      session: {
        id: "session-1"
      },
      user: {
        id: "user-1",
        name: "测试用户",
        email: "user@example.com",
        emailVerified: true,
        banned: false
      }
    });
  });

  it("creates an invitation and returns the token exactly once", async () => {
    const createAdminInvitation = vi.fn().mockResolvedValue({
      id: "invitation-1",
      email: "owner@example.com",
      role: "support",
      createdBy: "user-1",
      acceptedBy: null,
      acceptedAt: null,
      revokedAt: null,
      createdAt: new Date("2026-08-08T00:00:00.000Z"),
      expiresAt: new Date("2026-08-10T00:00:00.000Z")
    });
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("admin"),
      createAdminInvitation
    });

    const response = await handleCreateAdminInvitation(
      jsonRequest("/api/admin/invitations", {
        email: "Owner@Example.com",
        role: "support"
      }),
      store
    );

    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      data: {
        invitation: { email: string; role: string };
        token: string;
        acceptUrl: string;
      };
    };
    expect(payload.data.invitation).toMatchObject({
      email: "owner@example.com",
      role: "support"
    });
    expect(payload.data.token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
    );
    expect(payload.data.acceptUrl).toContain("/accept-admin-invitation?token=");
    expect(createAdminInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "owner@example.com",
        role: "support",
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }),
      expect.objectContaining({
        requestId: "request-1",
        path: "/api/admin/invitations",
        method: "POST",
        actor: expect.objectContaining({ role: "admin" })
      })
    );
  });

  it("lists invitations through the read-only admin route", async () => {
    const listAdminInvitations = vi.fn().mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0
    });
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("owner"),
      listAdminInvitations
    });

    const response = await handleListAdminInvitations(
      new Request("https://openvac.test/api/admin/invitations?page=1"),
      store
    );

    expect(response.status).toBe(200);
    expect(listAdminInvitations).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      query: undefined,
      status: undefined
    });
  });

  it("revokes an invitation through the audited delete route", async () => {
    const invitationId = "d607d4d6-82df-4f1b-a5d4-7d80277e327d";
    const revokeAdminInvitation = vi.fn().mockResolvedValue({
      id: invitationId,
      revokedAt: new Date("2026-08-08T00:00:00.000Z")
    });
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("owner"),
      revokeAdminInvitation
    });

    const response = await handleDeleteAdminInvitation(
      jsonRequest(
        "/api/admin/invitations",
        {
          invitationId
        },
        "DELETE"
      ),
      store
    );

    expect(response.status).toBe(200);
    expect(revokeAdminInvitation).toHaveBeenCalledWith(
      invitationId,
      expect.objectContaining({
        path: "/api/admin/invitations",
        method: "DELETE",
        actor: expect.objectContaining({ role: "owner" })
      })
    );
  });

  it("accepts an invitation for a verified matching account", async () => {
    const acceptAdminInvitation = vi.fn().mockResolvedValue({
      id: "invitation-1",
      acceptedBy: "user-1",
      acceptedAt: new Date("2026-08-08T00:00:00.000Z")
    });
    const store = partialStore({ acceptAdminInvitation });

    const response = await handleAcceptAdminInvitation(
      new Request(
        "https://openvac.test/api/admin/invitations/accept?token=123e4567-e89b-12d3-a456-426614174000",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-request-id": "request-1"
          }
        }
      ),
      store
    );

    expect(response.status).toBe(200);
    expect(acceptAdminInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        userId: "user-1",
        userEmail: "user@example.com",
        emailVerified: true
      }),
      expect.objectContaining({
        path: "/api/admin/invitations/accept",
        method: "POST",
        actor: expect.objectContaining({ role: "user" })
      })
    );
  });
});
