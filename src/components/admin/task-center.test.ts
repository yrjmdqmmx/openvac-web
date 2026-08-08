// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/context") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { user: { id: "owner-1" } } })
        };
      }
      if (url === "/api/admin/tasks" && init?.method === "PATCH") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              assigneeUserId: "owner-1",
              status: "in_progress",
              dueAt: null,
              snoozedUntil: null,
              note: null,
              revision: 1
            }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: [
              {
                key: "auth:role-conflict:user-1",
                sourceType: "auth",
                sourceId: "user-1",
                sourceStatus: "conflict",
                title: "管理员角色冲突",
                summary: "迁移前必须处理",
                href: "/admin/admins",
                severity: "critical",
                occurredAt: "2026-08-08T10:00:00.000Z",
                state: {
                  assigneeUserId: null,
                  status: "open",
                  dueAt: null,
                  snoozedUntil: null,
                  note: null,
                  revision: 0
                }
              }
            ],
            total: 1,
            page: 1,
            pageSize: 50
          }
        })
      };
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminTaskCenter", () => {
  it("renders critical tasks and claims with expectedRevision", async () => {
    const { AdminTaskCenter } = await import("./task-center");
    render(createElement(AdminTaskCenter));

    expect(await screen.findAllByText("管理员角色冲突")).not.toHaveLength(0);
    expect(screen.getAllByText("关键")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "领取任务" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/tasks",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            taskKey: "auth:role-conflict:user-1",
            expectedRevision: 0,
            assigneeUserId: "owner-1",
            status: "in_progress"
          })
        })
      )
    );
  });
});
