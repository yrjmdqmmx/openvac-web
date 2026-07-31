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
import { ChatWorkspace } from "./chat-workspace";
import {
  PENDING_QUESTION_DRAFT_KEY,
  savePendingQuestionDraft
} from "@/lib/pending-question-draft";

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("ChatWorkspace pending question draft", () => {
  it("shows an editable confirmation without automatically sending", async () => {
    savePendingQuestionDraft({
      text: "登录前保存的问题",
      now: Date.now()
    });

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        void _init;
        if (String(input) === "/api/conversations") {
          return jsonResponse({ data: { items: [] } });
        }
        return jsonResponse({});
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      createElement(ChatWorkspace, {
        userId: "user-a",
        userName: "用户 A"
      })
    );

    const draftInput = await screen.findByLabelText("待发送草稿");
    expect(draftInput).toHaveValue("登录前保存的问题");
    expect(
      screen.getByText("系统不会自动发送。", { exact: false })
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/chat" && init?.method === "POST"
      )
    ).toBe(false);

    fireEvent.change(draftInput, {
      target: { value: "编辑后由用户确认的问题" }
    });
    fireEvent.click(screen.getByRole("button", { name: "确认发送" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input) === "/api/chat" && init?.method === "POST"
        )
      ).toBe(true)
    );
    expect(sessionStorage.getItem(PENDING_QUESTION_DRAFT_KEY)).toBeNull();
  });

  it("removes an account-bound draft when the active account changes", async () => {
    savePendingQuestionDraft({
      text: "只属于用户 A 的草稿",
      ownerUserId: "user-a",
      now: Date.now()
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { items: [] } }))
    );

    const view = render(
      createElement(ChatWorkspace, {
        userId: "user-a",
        userName: "用户 A"
      })
    );
    expect(await screen.findByLabelText("待发送草稿")).toBeInTheDocument();

    view.rerender(
      createElement(ChatWorkspace, {
        userId: "user-b",
        userName: "用户 B"
      })
    );

    await waitFor(() =>
      expect(screen.queryByLabelText("待发送草稿")).not.toBeInTheDocument()
    );
    expect(sessionStorage.getItem(PENDING_QUESTION_DRAFT_KEY)).toBeNull();
  });
});
