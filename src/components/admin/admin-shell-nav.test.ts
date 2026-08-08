// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminContext } from "@/server/api/types";

const pathnameMock = vi.hoisted(() => ({
  pathname: "/admin/knowledge"
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.pathname
}));

import { AdminNav } from "./admin-nav";
import { AdminShell } from "./admin-shell";

afterEach(cleanup);

describe("admin navigation and shell context", () => {
  it("filters links by capability and uses truthful audit copy", () => {
    const context: AdminContext = {
      user: {
        id: "user-1",
        name: "测试用户",
        email: "user@example.com",
        image: null
      },
      role: "knowledge_editor",
      capabilities: [
        "knowledge:read",
        "knowledge:draft",
        "knowledge:review",
        "sources:read",
        "sources:write",
        "prompts:read",
        "prompts:write",
        "metrics:read"
      ]
    };
    render(
      createElement(AdminNav, {
        open: true,
        onClose: vi.fn(),
        context
      })
    );

    expect(screen.getByRole("link", { name: "知识库" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "来源白名单" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "提示词与评测" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "用户" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "管理员" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("不可变审计日志")).not.toBeInTheDocument();
    expect(screen.getByText("完整审计留痕。")).toBeInTheDocument();
  });

  it("shows the admin identity, account entry and sign-out action", () => {
    const context: AdminContext = {
      user: {
        id: "user-1",
        name: "张三",
        email: "zhangsan@example.com",
        image: null
      },
      role: "admin",
      capabilities: ["tasks:read", "tasks:write", "models:execute"]
    };
    render(
      createElement(
        AdminShell,
        { context },
        createElement("div", null, "后台内容")
      )
    );

    expect(
      screen.getByText(/admin · zhangsan@example\.com/u)
    ).toBeInTheDocument();
    expect(screen.getByText("张")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "账户" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "退出登录" })
    ).toBeInTheDocument();
    expect(screen.getByText("后台内容")).toBeInTheDocument();
  });
});
