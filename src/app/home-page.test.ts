// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn()
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers())
}));
vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: mocks.getSession } }
}));
vi.mock("@/components/home-prompt", () => ({
  HomePrompt: ({ currentUserId }: { currentUserId?: string }) =>
    createElement("div", {
      "data-testid": "home-prompt",
      "data-user-id": currentUserId ?? ""
    })
}));
vi.mock("@/components/site-header", () => ({
  SiteHeader: ({
    authenticated,
    appearance
  }: {
    authenticated: boolean;
    appearance?: string;
  }) =>
    createElement("div", {
      "data-testid": "site-header",
      "data-authenticated": String(authenticated),
      "data-appearance": appearance ?? "default"
    })
}));
vi.mock("@/components/semacad/semacad-hero-backdrop", () => ({
  SemacadHeroBackdrop: () =>
    createElement("div", { "data-testid": "semacad-hero-backdrop" })
}));

import HomePage, { dynamic } from "./page";

beforeEach(() => {
  mocks.getSession.mockReset();
});

afterEach(cleanup);

describe("home page", () => {
  it("renders dynamically so server authentication is never baked in", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("renders the approved copy, SemaCAD card, and removes the old modeling CTA", async () => {
    mocks.getSession.mockResolvedValue(null);

    const { container } = render(await HomePage());

    expect(
      screen.getByRole("heading", { name: "今天想解决什么真空问题？" })
    ).toBeInTheDocument();
    const titleGroups = container.querySelectorAll("h1 > span");
    expect(titleGroups).toHaveLength(2);
    expect(titleGroups[0]).toHaveClass("block", "sm:inline");
    expect(titleGroups[1]).toHaveClass(
      "block",
      "whitespace-nowrap",
      "sm:inline"
    );
    expect(
      screen.getByText(
        "描述泵型、工况或故障现象，OpenVac 会结合资料给出可核查的回答。"
      )
    ).toHaveClass("bg-[rgba(255,255,255,0.72)]", "text-[#344048]");
    expect(screen.getByText(/AI\s*生成内容仅供排查参考/)).toHaveClass(
      "bg-[rgba(255,255,255,0.76)]",
      "text-[#3f494f]"
    );
    expect(screen.queryByText("答案有来源")).not.toBeInTheDocument();
    expect(screen.queryByText("安全有边界")).not.toBeInTheDocument();
    expect(screen.queryByText("源码可审计")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "进入智能建模工作台" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /SemaCAD/ })).toHaveAttribute(
      "href",
      "/semacad"
    );
    expect(screen.getByRole("link", { name: /SemaCAD/ })).toHaveClass(
      "bg-[rgba(255,255,255,0.68)]"
    );
    expect(
      screen.getByText(/基于 FreeCAD 的本地优先 CAD，让手动建模与 OpenVac/)
    ).toBeInTheDocument();
    expect(screen.getByTestId("site-header")).toHaveAttribute(
      "data-authenticated",
      "false"
    );
    expect(screen.getByTestId("site-header")).toHaveAttribute(
      "data-appearance",
      "glass"
    );
    expect(screen.getByTestId("site-header").parentElement).toHaveClass("z-20");
    expect(screen.getByTestId("semacad-hero-backdrop").parentElement).toBe(
      container.querySelector("main")
    );
    expect(container.querySelector("main")).not.toHaveClass("bg-white");
    expect(container.querySelector("footer")).toHaveClass(
      "bg-[rgba(255,255,255,0.68)]",
      "text-[#465057]"
    );
    expect(screen.getByTestId("home-prompt")).toHaveAttribute(
      "data-user-id",
      ""
    );
  });

  it("passes the same server session to the header and prompt", async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: "user-a", name: "用户 A" },
      session: { id: "session-a" }
    });

    render(await HomePage());

    expect(screen.getByTestId("site-header")).toHaveAttribute(
      "data-authenticated",
      "true"
    );
    expect(screen.getByTestId("home-prompt")).toHaveAttribute(
      "data-user-id",
      "user-a"
    );
  });
});
