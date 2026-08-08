// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: authMocks.signOut }
}));

import { SiteHeader } from "./site-header";

afterEach(cleanup);

describe("SiteHeader", () => {
  it("removes knowledge sources and shows the GitHub mark with the open-source link", () => {
    const { container } = render(
      createElement(SiteHeader, { authenticated: false })
    );

    expect(
      screen.queryByRole("link", { name: "知识来源" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开导航菜单" }));
    const sourceLinks = screen.getAllByRole("link", { name: "开源项目" });
    expect(sourceLinks).toHaveLength(2);
    for (const sourceLink of sourceLinks) {
      expect(sourceLink).toHaveAttribute(
        "href",
        "https://github.com/yrjmdqmmx/openvac-web"
      );
    }
    expect(
      container.querySelectorAll('[data-testid="github-mark"]')
    ).toHaveLength(2);
  });

  it("supports a glass surface without changing the default opaque header", () => {
    const { container, rerender } = render(
      createElement(SiteHeader, { authenticated: false })
    );

    expect(container.querySelector("header")).toHaveClass("bg-white");

    rerender(
      createElement(SiteHeader, {
        authenticated: false,
        appearance: "glass"
      })
    );
    expect(container.querySelector("header")).toHaveClass("backdrop-blur-xl");
  });

  it("renders a text-only brand and a login link for signed-out visitors", () => {
    const { container } = render(
      createElement(SiteHeader, { authenticated: false })
    );

    expect(screen.getByLabelText("OpenVac 首页")).toHaveTextContent("OpenVac");
    expect(screen.getByRole("link", { name: "登录" })).toHaveAttribute(
      "href",
      "/sign-in"
    );
    expect(
      screen.getByLabelText("OpenVac 首页").querySelector("svg")
    ).toBeNull();
    expect(
      container.querySelector("[class*='rounded-full'][aria-hidden]")
    ).toBeNull();
  });

  it("renders a server-determined continue link for signed-in users", () => {
    render(createElement(SiteHeader, { authenticated: true }));

    const continueLink = screen.getByRole("link", { name: "继续对话" });
    expect(continueLink).toHaveAttribute("href", "/chat");
    fireEvent.click(screen.getByRole("button", { name: "打开账户菜单" }));
    expect(
      screen.getByRole("menu", { name: "账户菜单" })
    ).not.toHaveTextContent("继续对话");
    expect(
      screen.queryByRole("link", { name: "登录" })
    ).not.toBeInTheDocument();
  });

  it("shows an initials avatar and the complete account menu for signed-in users", () => {
    render(
      createElement(SiteHeader, {
        authenticated: true,
        user: { name: "张三", image: null },
        hasAdminRole: true
      })
    );

    const accountButton = screen.getByRole("button", { name: "打开账户菜单" });
    expect(accountButton).toHaveTextContent("张");
    fireEvent.click(accountButton);

    expect(screen.getByRole("link", { name: "继续对话" })).toHaveAttribute(
      "href",
      "/chat"
    );
    expect(screen.getByRole("link", { name: "账户设置" })).toHaveAttribute(
      "href",
      "/settings"
    );
    expect(screen.getByRole("link", { name: "设备会话" })).toHaveAttribute(
      "href",
      "/settings#sessions"
    );
    expect(screen.getByRole("link", { name: "运营后台" })).toHaveAttribute(
      "href",
      "/admin"
    );
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(authMocks.signOut).toHaveBeenCalledTimes(1);
  });

  it("links SemaCAD directly and exposes an accessible mobile menu", () => {
    render(createElement(SiteHeader, { authenticated: false }));

    const desktopLink = screen.getByRole("link", { name: "SemaCAD" });
    expect(desktopLink).toHaveAttribute("href", "/semacad");

    const menuButton = screen.getByRole("button", { name: "打开导航菜单" });
    expect(menuButton).toHaveAttribute("aria-expanded", "false");
    expect(menuButton).toHaveClass("size-11");

    fireEvent.click(menuButton);

    expect(
      screen.getByRole("button", { name: "关闭导航菜单" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("navigation", { name: "移动端导航" })
    ).toBeVisible();
    expect(screen.getAllByRole("link", { name: "SemaCAD" })).toHaveLength(2);
  });

  it("closes on Escape and returns focus to the mobile menu button", () => {
    render(createElement(SiteHeader, { authenticated: false }));
    const menuButton = screen.getByRole("button", { name: "打开导航菜单" });

    fireEvent.click(menuButton);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(
      screen.queryByRole("navigation", { name: "移动端导航" })
    ).not.toBeInTheDocument();
    expect(menuButton).toHaveFocus();
  });

  it("closes the mobile menu after a navigation choice", () => {
    render(createElement(SiteHeader, { authenticated: false }));
    fireEvent.click(screen.getByRole("button", { name: "打开导航菜单" }));

    const mobileNavigation = screen.getByRole("navigation", {
      name: "移动端导航"
    });
    fireEvent.click(
      mobileNavigation.querySelector('a[href="/semacad"]') as HTMLAnchorElement
    );

    expect(
      screen.queryByRole("navigation", { name: "移动端导航" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开导航菜单" })).toHaveFocus();
  });
});
