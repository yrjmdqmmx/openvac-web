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

import { authenticate, hasCapability, requireCapability } from "./auth";

function storeWithRole(
  role: Awaited<ReturnType<ApiStore["getAdminRole"]>>
): ApiStore {
  return {
    getAdminRole: vi.fn().mockResolvedValue(role)
  } as unknown as ApiStore;
}

describe("server-side admin authorization", () => {
  beforeEach(() => {
    authMocks.getSession.mockReset();
    accountCleanupMocks.isUserDeletionInProgress.mockReset();
    accountCleanupMocks.isUserDeletionInProgress.mockResolvedValue(false);
    authMocks.getSession.mockResolvedValue({
      user: {
        id: "user-1",
        name: "测试用户",
        email: "user@example.com",
        banned: false
      }
    });
  });

  it("uses the persisted admin role for capability checks", async () => {
    const actor = await requireCapability(
      new Request("https://openvac.test/api/admin/knowledge"),
      storeWithRole("knowledge_editor"),
      "knowledge:write"
    );

    expect(actor.role).toBe("knowledge_editor");
  });

  it("rejects a role without the requested capability", async () => {
    await expect(
      requireCapability(
        new Request("https://openvac.test/api/admin/users"),
        storeWithRole("analyst"),
        "users:write"
      )
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("rejects banned sessions before any route logic runs", async () => {
    authMocks.getSession.mockResolvedValue({
      user: {
        id: "user-1",
        name: "测试用户",
        email: "user@example.com",
        banned: true
      }
    });

    await expect(
      authenticate(new Request("https://openvac.test/api/conversations"))
    ).rejects.toMatchObject({ status: 403, code: "ACCOUNT_BANNED" });
  });

  it("rejects a persisted session once account deletion has started", async () => {
    accountCleanupMocks.isUserDeletionInProgress.mockResolvedValue(true);

    await expect(
      authenticate(new Request("https://openvac.test/api/conversations"))
    ).rejects.toMatchObject({
      status: 409,
      code: "ACCOUNT_DELETION_IN_PROGRESS"
    });
  });

  it("keeps analyst and support permissions read-focused", () => {
    expect(hasCapability("analyst", "metrics:read")).toBe(true);
    expect(hasCapability("analyst", "feedback:read")).toBe(false);
    expect(hasCapability("analyst", "settings:write")).toBe(false);
    expect(hasCapability("support", "feedback:write")).toBe(true);
    expect(hasCapability("support", "problem_reports:write")).toBe(true);
    expect(hasCapability("analyst", "problem_reports:read")).toBe(false);
    expect(hasCapability("analyst", "problem_reports:write")).toBe(false);
    expect(hasCapability("knowledge_editor", "problem_reports:read")).toBe(
      false
    );
    expect(hasCapability("support", "knowledge:write")).toBe(false);
  });

  it("allows owner role writes while admin remains read-only for role management", () => {
    expect(hasCapability("owner", "conversations:read")).toBe(true);
    expect(hasCapability("owner", "admins:read")).toBe(true);
    expect(hasCapability("owner", "admins:write")).toBe(true);
    expect(hasCapability("admin", "conversations:read")).toBe(true);
    expect(hasCapability("admin", "admins:read")).toBe(true);
    expect(hasCapability("admin", "admins:write")).toBe(false);
    expect(hasCapability("support", "conversations:read")).toBe(false);
    expect(hasCapability("analyst", "admins:read")).toBe(false);
  });
});
