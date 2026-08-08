// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigationMocks = vi.hoisted(() => ({ replaceWindowLocation: vi.fn() }));

vi.mock("@/lib/client-navigation", () => navigationMocks);

import { ChatWorkspace } from "./chat-workspace";
import {
  PENDING_QUESTION_DRAFT_KEY,
  PENDING_QUESTION_INTENT_KEY,
  savePendingQuestionDraft,
  savePendingQuestionIntent
} from "@/lib/pending-question-draft";

beforeEach(() => {
  navigationMocks.replaceWindowLocation.mockReset();
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

function completedStreamResponse(): Response {
  return new Response(
    'data: {"type":"complete","conversationId":"conversation-1","messageId":"message-1","meta":{"riskLevel":"low","missingInputs":[],"webSearched":false,"citations":[]}}\n\n',
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

function installFetch({ chatStatus = 200 }: { chatStatus?: number } = {}) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/chat" && init?.method === "POST") {
        return chatStatus === 401
          ? new Response(null, { status: 401 })
          : completedStreamResponse();
      }
      return jsonResponse({ data: { items: [] } });
    }
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function chatPostCount(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input) === "/api/chat" &&
      (init as RequestInit | undefined)?.method === "POST"
  ).length;
}

describe("ChatWorkspace pending question flow", () => {
  it("keeps one-character questions on the client with a clear message", async () => {
    const fetchMock = installFetch();

    render(
      createElement(ChatWorkspace, {
        userId: "user-a",
        userName: "用户 A",
        userEmail: "user-a@openvac.test"
      })
    );

    const input = screen.getByLabelText("继续提问");
    fireEvent.change(input, { target: { value: "?" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(
      await screen.findByText(
        "请至少输入 2 个字符，以便 OpenVac 理解你的问题。"
      )
    ).toBeInTheDocument();
    expect(chatPostCount(fetchMock)).toBe(0);
  });

  it("consumes a v2 intent and sends exactly once under Strict Mode", async () => {
    savePendingQuestionIntent({
      text: "登录后自动发送的问题",
      now: Date.now()
    });
    const fetchMock = installFetch();

    render(
      createElement(
        StrictMode,
        null,
        createElement(ChatWorkspace, {
          userId: "user-a",
          userName: "用户 A",
          userEmail: "user-a@openvac.test"
        })
      )
    );

    await waitFor(() => expect(chatPostCount(fetchMock)).toBe(1));
    expect(await screen.findByText("登录后自动发送的问题")).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_QUESTION_INTENT_KEY)).toBeNull();
    expect(screen.queryByText("有一条待发送草稿")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "确认发送" })
    ).not.toBeInTheDocument();
  });

  it("uses the reasoning and web modes selected on the homepage", async () => {
    savePendingQuestionIntent({
      text: "首页带模式的问题",
      mode: "deep",
      webMode: "always",
      now: Date.now()
    });
    const fetchMock = installFetch();

    render(
      createElement(ChatWorkspace, {
        userId: "user-a",
        userName: "用户 A",
        userEmail: "user-a@openvac.test"
      })
    );

    await waitFor(() => expect(chatPostCount(fetchMock)).toBe(1));
    const chatCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === "/api/chat" &&
        (init as RequestInit | undefined)?.method === "POST"
    );
    expect(
      JSON.parse(String((chatCall?.[1] as RequestInit).body))
    ).toMatchObject({ mode: "deep", webMode: "always" });
    expect(screen.getByRole("button", { name: "深度思考" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "联网" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("migrates a legacy v1 draft into the composer without sending", async () => {
    savePendingQuestionDraft({
      text: "旧版只预填的问题",
      now: Date.now()
    });
    const fetchMock = installFetch();

    render(
      createElement(ChatWorkspace, {
        userId: "user-a",
        userName: "用户 A",
        userEmail: "user-a@openvac.test"
      })
    );

    const composer = screen.getByLabelText("继续提问");
    await waitFor(() => expect(composer).toHaveValue("旧版只预填的问题"));
    expect(chatPostCount(fetchMock)).toBe(0);
    expect(sessionStorage.getItem(PENDING_QUESTION_DRAFT_KEY)).toBeNull();
    expect(screen.queryByText("有一条待发送草稿")).not.toBeInTheDocument();
  });

  it("clears an account-mismatched v2 intent without sending", async () => {
    savePendingQuestionIntent({
      text: "只属于用户 A 的问题",
      ownerUserId: "user-a",
      now: Date.now()
    });
    const fetchMock = installFetch();

    render(
      createElement(ChatWorkspace, {
        userId: "user-b",
        userName: "用户 B",
        userEmail: "user-b@openvac.test"
      })
    );

    await waitFor(() =>
      expect(sessionStorage.getItem(PENDING_QUESTION_INTENT_KEY)).toBeNull()
    );
    expect(chatPostCount(fetchMock)).toBe(0);
  });

  it("restores an owner-bound v2 intent when the chat API returns 401", async () => {
    const fetchMock = installFetch({ chatStatus: 401 });

    render(
      createElement(ChatWorkspace, {
        userId: "user-a",
        userName: "用户 A",
        userEmail: "user-a@openvac.test"
      })
    );

    const input = screen.getByLabelText("继续提问");
    fireEvent.change(input, { target: { value: "会话失效后不能丢的问题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(chatPostCount(fetchMock)).toBe(1));
    await waitFor(() =>
      expect(
        JSON.parse(sessionStorage.getItem(PENDING_QUESTION_INTENT_KEY) ?? "{}")
      ).toMatchObject({
        version: 2,
        intent: "send",
        text: "会话失效后不能丢的问题",
        ownerUserId: "user-a"
      })
    );
    expect(navigationMocks.replaceWindowLocation).toHaveBeenCalledWith(
      "/sign-in?returnTo=%2Fchat"
    );
  });
});
