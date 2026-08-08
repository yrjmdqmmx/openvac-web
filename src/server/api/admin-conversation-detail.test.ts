import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiStore } from "./types";

const authMocks = vi.hoisted(() => ({ getSession: vi.fn() }));
const cleanupMocks = vi.hoisted(() => ({ isUserDeletionInProgress: vi.fn() }));

vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: authMocks.getSession } }
}));
vi.mock("@/server/auth/account-cleanup", () => cleanupMocks);

import { handleGetAdminConversation } from "./admin";

beforeEach(() => {
  cleanupMocks.isUserDeletionInProgress.mockResolvedValue(false);
  authMocks.getSession.mockResolvedValue({
    session: { id: "session-1" },
    user: {
      id: "admin-1",
      name: "Admin",
      email: "admin@example.test",
      emailVerified: true,
      banned: false
    }
  });
});

describe("read-only admin conversation detail", () => {
  it("returns a detail only through conversations:read", async () => {
    const getAdminConversation = vi.fn(async () => ({
      id: "00000000-0000-4000-8000-000000000001",
      messages: [{ role: "user", content: "question" }]
    }));
    const response = await handleGetAdminConversation(
      new Request(
        "https://openvac.test/api/admin/conversations/00000000-0000-4000-8000-000000000001"
      ),
      "00000000-0000-4000-8000-000000000001",
      {
        getAdminRole: vi.fn(async () => "owner"),
        getAdminConversation
      } as unknown as ApiStore
    );

    expect(response.status).toBe(200);
    expect(getAdminConversation).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001"
    );
  });

  it("rejects invalid identifiers before reading messages", async () => {
    const getAdminConversation = vi.fn();
    const response = await handleGetAdminConversation(
      new Request("https://openvac.test/api/admin/conversations/not-a-uuid"),
      "not-a-uuid",
      {
        getAdminRole: vi.fn(async () => "owner"),
        getAdminConversation
      } as unknown as ApiStore
    );

    expect(response.status).toBe(422);
    expect(getAdminConversation).not.toHaveBeenCalled();
  });
});
