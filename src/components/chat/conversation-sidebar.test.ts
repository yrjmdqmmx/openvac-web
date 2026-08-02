// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationSidebar } from "./conversation-sidebar";

afterEach(cleanup);

function SidebarHarness({
  initialExpanded = true,
  withMobileTrigger = false,
  onSelect = vi.fn()
}: {
  initialExpanded?: boolean;
  withMobileTrigger?: boolean;
  onSelect?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [mobileOpen, setMobileOpen] = useState(false);
  return createElement(
    "div",
    null,
    withMobileTrigger
      ? createElement(
          "button",
          { type: "button", onClick: () => setMobileOpen(true) },
          "打开对话记录"
        )
      : null,
    createElement(ConversationSidebar, {
      conversations: [
        {
          id: "conversation-1",
          title: "旋片泵排查",
          updatedAt: new Date().toISOString()
        }
      ],
      expanded,
      onExpandedChange: setExpanded,
      mobileOpen,
      onMobileOpenChange: setMobileOpen,
      onSelect,
      onNew: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      searchQuery: "",
      onSearchQueryChange: vi.fn(),
      loading: false,
      hasMore: false,
      onLoadMore: vi.fn(),
      userName: "工程用户",
      userEmail: "engineer@openvac.test"
    })
  );
}

describe("ConversationSidebar", () => {
  it("starts expanded and keeps new/search actions in the collapsed rail", async () => {
    render(createElement(SidebarHarness));

    expect(screen.getByText("旋片泵排查")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起边栏" }));

    expect(
      screen.getByRole("button", { name: "展开边栏" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新对话" })).toBeInTheDocument();
    const searchButton = screen.getByRole("button", { name: "搜索对话" });
    expect(searchButton).toBeInTheDocument();
    expect(screen.queryByText("旋片泵排查")).not.toBeInTheDocument();

    fireEvent.click(searchButton);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "搜索对话" })).toHaveFocus()
    );
    expect(screen.getByText("旋片泵排查")).toBeInTheDocument();
  });

  it("opens as a mobile modal drawer, closes on Escape, and restores focus", async () => {
    render(
      createElement(SidebarHarness, {
        initialExpanded: false,
        withMobileTrigger: true
      })
    );

    const trigger = screen.getByRole("button", { name: "打开对话记录" });
    trigger.focus();
    fireEvent.click(trigger);

    expect(
      screen.getByRole("dialog", { name: "对话记录" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭对话记录" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "对话记录" })
      ).not.toBeInTheDocument()
    );
    expect(trigger).toHaveFocus();
  });

  it("closes the mobile drawer after selecting a conversation", async () => {
    const onSelect = vi.fn();
    render(
      createElement(SidebarHarness, {
        initialExpanded: false,
        withMobileTrigger: true,
        onSelect
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "打开对话记录" }));
    fireEvent.click(screen.getByRole("button", { name: "旋片泵排查" }));
    expect(onSelect).toHaveBeenCalledWith("conversation-1");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "对话记录" })
      ).not.toBeInTheDocument()
    );
  });

  it("opens the account menu from the sidebar footer and closes it with Escape", async () => {
    render(createElement(SidebarHarness));

    const accountButton = screen.getByRole("button", {
      name: "账户：工程用户"
    });
    fireEvent.click(accountButton);

    expect(screen.getByRole("menu", { name: "账户菜单" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "个人资料" })).toHaveAttribute(
      "href",
      "/settings#profile"
    );
    expect(screen.getByRole("menuitem", { name: "设置" })).toHaveAttribute(
      "href",
      "/settings"
    );
    expect(screen.getByRole("menuitem", { name: "帮助" })).toHaveAttribute(
      "href",
      "/help"
    );
    expect(
      screen.getByRole("menuitem", { name: "退出登录" })
    ).toBeInTheDocument();
    expect(screen.getByText("engineer@openvac.test")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("menu", { name: "账户菜单" })
      ).not.toBeInTheDocument()
    );
    expect(accountButton).toHaveFocus();
  });
});
