// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ConversationSummary } from "@/types/chat";
import {
  ChatWorkspace,
  problemReportDescriptionForMessage
} from "./chat-workspace";

const firstConversation: ConversationSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "第一段对话",
  updatedAt: "2026-08-01T00:00:00.000Z"
};

const secondConversation: ConversationSummary = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "第二段对话",
  updatedAt: "2026-07-31T00:00:00.000Z"
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function conversationPage(
  items: ConversationSummary[],
  { page = 1, total = items.length }: { page?: number; total?: number } = {}
) {
  return jsonResponse({
    data: { items, page, pageSize: 20, total }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function requestUrl(input: RequestInfo | URL) {
  return new URL(String(input), "https://openvac.test");
}

function renderWorkspace() {
  return render(
    createElement(ChatWorkspace, {
      userId: "user-a",
      userName: "用户 A",
      userEmail: "user-a@openvac.test"
    })
  );
}

function openConversationHistory() {
  if (screen.queryByRole("textbox", { name: "搜索对话" })) return;
  fireEvent.click(screen.getByRole("button", { name: "展开边栏" }));
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("ChatWorkspace conversation history", () => {
  it("shows the desktop history by default and removes knowledge/account header links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => conversationPage([firstConversation]))
    );

    renderWorkspace();

    expect(
      await screen.findByRole("textbox", { name: "搜索对话" })
    ).toBeInTheDocument();
    expect(await screen.findByText("第一段对话")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "知识来源" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "账户" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "账户：用户 A" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "SemaCAD" })).toHaveAttribute(
      "href",
      "/semacad"
    );
  });

  it("prefills a report with the user question preceding the selected answer", () => {
    const messages: ChatMessage[] = [
      { id: "question-1", role: "user", content: "第一轮问题" },
      {
        id: "answer-1",
        role: "assistant",
        content: "第一轮回答",
        status: "completed"
      },
      { id: "question-2", role: "user", content: "第二轮问题" },
      {
        id: "answer-2",
        role: "assistant",
        content: "第二轮回答",
        status: "completed"
      }
    ];

    expect(problemReportDescriptionForMessage(messages, "answer-1")).toBe(
      "第一轮问题"
    );
    expect(problemReportDescriptionForMessage(messages, "answer-2")).toBe(
      "第二轮问题"
    );
    expect(problemReportDescriptionForMessage(messages)).toBe("第二轮问题");
  });

  it("debounces server search and ignores a stale response", async () => {
    const olderSearch = deferred<Response>();
    const newerSearch = deferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/conversations") {
        return conversationPage([firstConversation]);
      }
      if (url.pathname === "/api/conversations/search") {
        if (url.searchParams.get("q") === "旋片") return olderSearch.promise;
        if (url.searchParams.get("q") === "旋片泵") return newerSearch.promise;
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWorkspace();
    openConversationHistory();
    expect(await screen.findByText("第一段对话")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索对话"), {
      target: { value: "旋片" }
    });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => {
          const url = requestUrl(input);
          return (
            url.pathname === "/api/conversations/search" &&
            url.searchParams.get("q") === "旋片" &&
            url.searchParams.get("page") === "1" &&
            url.searchParams.get("pageSize") === "20"
          );
        })
      ).toBe(true)
    );

    fireEvent.change(screen.getByLabelText("搜索对话"), {
      target: { value: "旋片泵" }
    });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => {
          const url = requestUrl(input);
          return (
            url.pathname === "/api/conversations/search" &&
            url.searchParams.get("q") === "旋片泵"
          );
        })
      ).toBe(true)
    );

    const currentResult = {
      ...secondConversation,
      title: "旋片泵当前结果"
    };
    await act(async () => {
      newerSearch.resolve(conversationPage([currentResult]));
      await newerSearch.promise;
    });
    expect(await screen.findByText("旋片泵当前结果")).toBeInTheDocument();

    await act(async () => {
      olderSearch.resolve(
        conversationPage([{ ...firstConversation, title: "过期搜索结果" }])
      );
      await olderSearch.promise;
    });
    expect(screen.getByText("旋片泵当前结果")).toBeInTheDocument();
    expect(screen.queryByText("过期搜索结果")).not.toBeInTheDocument();
  });

  it("loads the next server page and keeps the existing history", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/conversations" && !url.search) {
        return conversationPage([firstConversation], { total: 2 });
      }
      if (
        url.pathname === "/api/conversations" &&
        url.searchParams.get("page") === "2"
      ) {
        return conversationPage([secondConversation], { page: 2, total: 2 });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWorkspace();
    openConversationHistory();
    expect(await screen.findByText("第一段对话")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多对话" }));

    expect(await screen.findByText("第二段对话")).toBeInTheDocument();
    expect(screen.getByText("第一段对话")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const url = requestUrl(input);
        return (
          url.pathname === "/api/conversations" &&
          url.searchParams.get("page") === "2" &&
          url.searchParams.get("pageSize") === "20"
        );
      })
    ).toBe(true);
  });

  it("keeps the latest selected conversation when detail responses race", async () => {
    const firstDetail = deferred<Response>();
    const secondDetail = deferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/conversations") {
        return conversationPage([firstConversation, secondConversation]);
      }
      if (url.pathname === `/api/conversations/${firstConversation.id}`) {
        return firstDetail.promise;
      }
      if (url.pathname === `/api/conversations/${secondConversation.id}`) {
        return secondDetail.promise;
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWorkspace();
    openConversationHistory();
    expect(await screen.findByText("第一段对话")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "第一段对话" }));
    openConversationHistory();
    fireEvent.click(screen.getByRole("button", { name: "第二段对话" }));

    await act(async () => {
      secondDetail.resolve(
        jsonResponse({
          data: {
            messages: [
              {
                id: "assistant-2",
                role: "assistant",
                content: "第二段对话的回答"
              }
            ]
          }
        })
      );
      await secondDetail.promise;
    });
    expect(await screen.findByText("第二段对话的回答")).toBeInTheDocument();

    await act(async () => {
      firstDetail.resolve(
        jsonResponse({
          data: {
            messages: [
              {
                id: "assistant-1",
                role: "assistant",
                content: "第一段对话的过期回答"
              }
            ]
          }
        })
      );
      await firstDetail.promise;
    });
    expect(screen.getByText("第二段对话的回答")).toBeInTheDocument();
    expect(screen.queryByText("第一段对话的过期回答")).not.toBeInTheDocument();
  });

  it("refreshes server results after rename and delete", async () => {
    let serverItems = [firstConversation, secondConversation];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.pathname === "/api/conversations" && !init?.method) {
          return conversationPage(serverItems);
        }
        if (
          url.pathname === `/api/conversations/${firstConversation.id}` &&
          init?.method === "PATCH"
        ) {
          const body = JSON.parse(String(init.body)) as { title: string };
          serverItems = serverItems.map((conversation) =>
            conversation.id === firstConversation.id
              ? { ...conversation, title: body.title }
              : conversation
          );
          return jsonResponse({});
        }
        if (
          url.pathname === `/api/conversations/${secondConversation.id}` &&
          init?.method === "DELETE"
        ) {
          serverItems = serverItems.filter(
            (conversation) => conversation.id !== secondConversation.id
          );
          return new Response(null, { status: 204 });
        }
        return jsonResponse({}, 404);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "prompt").mockReturnValue("重命名后的对话");
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWorkspace();
    openConversationHistory();
    expect(await screen.findByText("第一段对话")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "第一段对话 的更多操作" })
    );
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    expect(await screen.findByText("重命名后的对话")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "第二段对话 的更多操作" })
    );
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(screen.queryByText("第二段对话")).not.toBeInTheDocument()
    );
    expect(screen.getByText("重命名后的对话")).toBeInTheDocument();
  });

  it("clears the active chat state after account conversation data is deleted", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.pathname === "/api/conversations" && !init?.method) {
          return conversationPage([firstConversation]);
        }
        if (url.pathname === `/api/conversations/${firstConversation.id}`) {
          return jsonResponse({
            data: {
              messages: [
                {
                  id: "assistant-1",
                  role: "assistant",
                  content: "清空前仍在页面里的回答"
                }
              ]
            }
          });
        }
        if (url.pathname === "/api/account/data" && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return jsonResponse({}, 404);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWorkspace();
    expect(await screen.findByText("第一段对话")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "第一段对话" }));
    expect(
      await screen.findByText("清空前仍在页面里的回答")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "账户：用户 A" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "数据管理" }));
    fireEvent.click(screen.getByRole("button", { name: "清空对话" }));

    await waitFor(() =>
      expect(screen.queryByText("第一段对话")).not.toBeInTheDocument()
    );
    expect(
      screen.queryByText("清空前仍在页面里的回答")
    ).not.toBeInTheDocument();
    expect(screen.getByText("还没有历史对话。")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input, init]) => {
        const url = requestUrl(input);
        return (
          url.pathname === "/api/account/data" && init?.method === "DELETE"
        );
      })
    ).toBe(true);
  });
});
