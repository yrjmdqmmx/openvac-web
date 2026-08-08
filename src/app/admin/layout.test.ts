// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ getSession: vi.fn() }));
const storeMocks = vi.hoisted(() => ({ getAdminRole: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-request-id": "request-1" })
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: authMocks.getSession } }
}));
vi.mock("@/server/api/store", () => ({
  apiStore: { getAdminRole: storeMocks.getAdminRole }
}));
vi.mock("@/components/admin/admin-shell", () => ({
  AdminShell: (props: Record<string, unknown>) =>
    createElement(
      "pre",
      { "data-testid": "admin-shell-props" },
      JSON.stringify(props)
    )
}));

import AdminLayout from "./layout";

afterEach(() => {
  cleanup();
  authMocks.getSession.mockReset();
  storeMocks.getAdminRole.mockReset();
});

describe("admin layout access control", () => {
  it("renders a clear no-permission state when a session has no admin role", async () => {
    authMocks.getSession.mockResolvedValue({
      user: {
        id: "user-1",
        name: "测试用户",
        email: "user@example.com",
        image: null
      }
    });
    storeMocks.getAdminRole.mockResolvedValue(null);

    render(
      await AdminLayout({ children: createElement("div", null, "child") })
    );

    expect(screen.getByText("你没有权限进入运营后台。")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-shell-props")).not.toBeInTheDocument();
  });

  it("passes the admin context to the shell when a role exists", async () => {
    authMocks.getSession.mockResolvedValue({
      user: {
        id: "user-1",
        name: "测试用户",
        email: "user@example.com",
        image: null
      }
    });
    storeMocks.getAdminRole.mockResolvedValue("admin");

    render(
      await AdminLayout({ children: createElement("div", null, "child") })
    );

    expect(screen.getByTestId("admin-shell-props")).toHaveTextContent(
      '"role":"admin"'
    );
    expect(screen.getByTestId("admin-shell-props")).toHaveTextContent(
      '"capabilities"'
    );
  });
});
