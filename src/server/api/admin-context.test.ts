import { beforeEach, describe, expect, it, vi } from "vitest";

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

import * as adminHandlers from "./admin";
import type { ApiStore } from "./types";

function storeWithRole(role: Awaited<ReturnType<ApiStore["getAdminRole"]>>) {
  return {
    getAdminRole: vi.fn().mockResolvedValue(role)
  } as unknown as ApiStore;
}

describe("admin context handler", () => {
  beforeEach(() => {
    authMocks.getSession.mockReset();
    accountCleanupMocks.isUserDeletionInProgress.mockReset();
    accountCleanupMocks.isUserDeletionInProgress.mockResolvedValue(false);
    authMocks.getSession.mockResolvedValue({
      user: {
        id: "user-1",
        name: "测试用户",
        email: "user@example.com",
        image: "https://example.com/avatar.png",
        banned: false
      }
    });
  });

  it("returns 401 when no session exists", async () => {
    authMocks.getSession.mockResolvedValueOnce(null);

    const response = await (
      adminHandlers.handleGetAdminContext as unknown as (
        request: Request,
        store: ApiStore
      ) => Promise<Response>
    )(
      new Request("https://openvac.test/api/admin/context", {
        headers: { "x-request-id": "request-1" }
      }),
      storeWithRole("owner")
    );

    expect(response.status).toBe(401);
  });

  it("returns 403 when a signed-in user has no admin role", async () => {
    const response = await (
      adminHandlers.handleGetAdminContext as unknown as (
        request: Request,
        store: ApiStore
      ) => Promise<Response>
    )(
      new Request("https://openvac.test/api/admin/context", {
        headers: { "x-request-id": "request-1" }
      }),
      storeWithRole(null)
    );

    expect(response.status).toBe(403);
  });

  it("returns the admin context together with the request id", async () => {
    const response = await (
      adminHandlers.handleGetAdminContext as unknown as (
        request: Request,
        store: ApiStore
      ) => Promise<Response>
    )(
      new Request("https://openvac.test/api/admin/context", {
        headers: { "x-request-id": "request-42" }
      }),
      storeWithRole("knowledge_editor")
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: { capabilities: string[] };
      requestId: string;
    };
    expect(payload).toEqual({
      data: {
        user: {
          id: "user-1",
          name: "测试用户",
          email: "user@example.com",
          image: "https://example.com/avatar.png"
        },
        role: "knowledge_editor",
        capabilities: expect.arrayContaining([
          "knowledge:read",
          "knowledge:draft",
          "knowledge:review"
        ])
      },
      requestId: "request-42"
    });

    expect(payload.data.capabilities).not.toContain("knowledge:publish");
    expect(payload.data.capabilities).not.toContain("knowledge:rollback");
  });
});
