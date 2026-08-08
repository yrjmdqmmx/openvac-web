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

import { handleListAdminTasks, handleUpdateAdminTaskState } from "./admin";

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

describe("admin task handlers", () => {
  it("lists the generated task page for a role with tasks:read", async () => {
    const listAdminTasks = vi.fn().mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0
    });
    const response = await handleListAdminTasks(
      new Request("https://openvac.test/api/admin/tasks"),
      partialStore({
        getAdminRole: vi.fn().mockResolvedValue("owner"),
        listAdminTasks
      })
    );

    expect(response.status).toBe(200);
    expect(listAdminTasks).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      query: undefined,
      status: undefined
    });
  });

  it("passes expectedRevision and state-only fields to the store", async () => {
    const updateAdminTaskState = vi.fn().mockResolvedValue({
      assigneeUserId: "owner-1",
      status: "in_progress",
      dueAt: null,
      snoozedUntil: null,
      note: "处理中",
      revision: 3
    });
    const response = await handleUpdateAdminTaskState(
      new Request("https://openvac.test/api/admin/tasks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskKey: "knowledge:doc-1",
          expectedRevision: 2,
          assigneeUserId: "owner-1",
          status: "in_progress",
          note: "处理中"
        })
      }),
      partialStore({
        getAdminRole: vi.fn().mockResolvedValue("owner"),
        updateAdminTaskState
      })
    );

    expect(response.status).toBe(200);
    expect(updateAdminTaskState).toHaveBeenCalledWith(
      "knowledge:doc-1",
      expect.objectContaining({
        expectedRevision: 2,
        assigneeUserId: "owner-1",
        status: "in_progress",
        note: "处理中"
      }),
      expect.objectContaining({
        actor: expect.objectContaining({ role: "owner" })
      })
    );
  });

  it("rejects attempts to manually change derived critical severity", async () => {
    const updateAdminTaskState = vi.fn();
    const response = await handleUpdateAdminTaskState(
      new Request("https://openvac.test/api/admin/tasks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskKey: "auth:role-conflict:user-1",
          expectedRevision: 0,
          severity: "low",
          status: "in_progress"
        })
      }),
      partialStore({
        getAdminRole: vi.fn().mockResolvedValue("owner"),
        updateAdminTaskState
      })
    );

    expect(response.status).toBe(422);
    expect(updateAdminTaskState).not.toHaveBeenCalled();
  });

  it("rejects state rows for unknown task source types", async () => {
    const updateAdminTaskState = vi.fn();
    const response = await handleUpdateAdminTaskState(
      new Request("https://openvac.test/api/admin/tasks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskKey: "manual:invented-task",
          expectedRevision: 0,
          status: "done"
        })
      }),
      partialStore({
        getAdminRole: vi.fn().mockResolvedValue("owner"),
        updateAdminTaskState
      })
    );

    expect(response.status).toBe(422);
    expect(updateAdminTaskState).not.toHaveBeenCalled();
  });
});
