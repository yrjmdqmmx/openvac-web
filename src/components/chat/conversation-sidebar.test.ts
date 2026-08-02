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

function DrawerHarness({
  onSelect = vi.fn()
}: {
  onSelect?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      { type: "button", onClick: () => setOpen(true) },
      "对话记录"
    ),
    createElement(ConversationSidebar, {
      conversations: [
        {
          id: "conversation-1",
          title: "旋片泵排查",
          updatedAt: new Date().toISOString()
        }
      ],
      open,
      onOpenChange: setOpen,
      onSelect,
      onNew: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      searchQuery: "",
      onSearchQueryChange: vi.fn(),
      loading: false,
      hasMore: false,
      onLoadMore: vi.fn(),
      userName: "工程用户"
    })
  );
}

describe("ConversationSidebar", () => {
  it("opens as a modal drawer, closes on Escape, and restores trigger focus", async () => {
    render(createElement(DrawerHarness));

    const trigger = screen.getByRole("button", { name: "对话记录" });
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

  it("closes after selecting a conversation and shows no brand avatar", async () => {
    const onSelect = vi.fn();
    render(createElement(DrawerHarness, { onSelect }));

    fireEvent.click(screen.getByRole("button", { name: "对话记录" }));
    const dialog = screen.getByRole("dialog", { name: "对话记录" });
    expect(dialog).not.toHaveTextContent("OpenVac");
    expect(dialog.querySelector("[class*='rounded-full']")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "旋片泵排查" }));
    expect(onSelect).toHaveBeenCalledWith("conversation-1");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "对话记录" })
      ).not.toBeInTheDocument()
    );
  });
});
