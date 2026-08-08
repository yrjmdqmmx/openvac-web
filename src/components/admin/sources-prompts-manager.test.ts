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
import { afterEach, describe, expect, it, vi } from "vitest";

import { PromptsManager } from "./prompts-manager";
import { SourcesManager } from "./sources-manager";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function response(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ data })
  } as Response;
}

describe("sources manager", () => {
  it("creates a governed record source with an exact-record rights decision", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/context") {
        return response({
          role: "owner",
          capabilities: ["sources:read", "sources:write"]
        });
      }
      if (url.startsWith("/api/admin/sources?") && !init?.method) {
        return response({ items: [], page: 1, pageSize: 20, total: 0 });
      }
      return response({ id: "source-1" }, 201);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(SourcesManager));
    fireEvent.click(await screen.findByRole("button", { name: "新增来源" }));
    fireEvent.change(screen.getByLabelText("来源名称"), {
      target: { value: "CERN 记录" }
    });
    fireEvent.change(screen.getByLabelText("发布机构"), {
      target: { value: "CERN" }
    });
    fireEvent.change(screen.getByLabelText("记录地址"), {
      target: { value: "https://cds.cern.ch/record/2929324" }
    });
    fireEvent.change(screen.getByLabelText("基础地址"), {
      target: { value: "https://cds.cern.ch/" }
    });
    fireEvent.change(screen.getByLabelText("授权策略"), {
      target: { value: "逐份核验开放许可" }
    });
    fireEvent.click(screen.getByLabelText("同时记录权利决定"));
    fireEvent.change(screen.getByLabelText("权利依据"), {
      target: { value: "该条记录的许可页明确标注为开放授权。" }
    });
    fireEvent.change(screen.getByLabelText("证据地址"), {
      target: { value: "https://cds.cern.ch/record/2929324" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存来源" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/sources",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining(
            '"appliesToRecordUrl":"https://cds.cern.ch/record/2929324"'
          )
        })
      )
    );
  });
});

describe("prompts manager", () => {
  it("shows a version diff and activates without sending prompt content", async () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/context") {
        return response({
          role: "admin",
          capabilities: ["prompts:read", "prompts:write"]
        });
      }
      if (url.startsWith("/api/admin/prompts?") && !init?.method) {
        return response({
          items: [
            {
              id: "prompt-v2",
              key: "vacuum_expert_system",
              version: 2,
              content: "第一行\n新规则",
              status: "draft",
              updatedAt: "2026-08-08T00:00:00.000Z"
            },
            {
              id: "prompt-v1",
              key: "vacuum_expert_system",
              version: 1,
              content: "第一行\n旧规则",
              status: "active",
              updatedAt: "2026-08-07T00:00:00.000Z"
            }
          ],
          page: 1,
          pageSize: 20,
          total: 2
        });
      }
      return response({ id: "prompt-v2", status: "active" });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(PromptsManager));

    fireEvent.click(await screen.findByRole("button", { name: "查看版本 2" }));
    expect(screen.getByText("+ 新规则")).toBeInTheDocument();
    expect(screen.getByText("- 旧规则")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "激活此版本" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/prompts/prompt-v2",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "active" })
        })
      )
    );
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH"
    );
    expect(String(patchCall?.[1]?.body)).not.toContain("content");
  });

  it("runs a confirmed model evaluation for the selected prompt version", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/context") {
        return response({
          role: "owner",
          capabilities: ["prompts:read", "prompts:write", "models:execute"]
        });
      }
      if (url.startsWith("/api/admin/prompts?") && !init?.method) {
        return response({
          items: [
            {
              id: "prompt-v2",
              key: "vacuum_expert_system",
              version: 2,
              content: "只根据可靠证据回答。",
              status: "draft"
            }
          ],
          page: 1,
          pageSize: 20,
          total: 1
        });
      }
      if (url === "/api/admin/prompts/prompt-v2/test") {
        return response({
          output: "请先检查冷阱与前级压力。",
          model: "deepseek-chat",
          promptVersion: 2,
          usage: { totalTokens: 20 }
        });
      }
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(PromptsManager));
    fireEvent.change(await screen.findByLabelText("测试输入"), {
      target: { value: "扩散泵返油怎么办？" }
    });
    fireEvent.click(screen.getByRole("button", { name: "运行测试" }));

    expect(
      await screen.findByText("请先检查冷阱与前级压力。")
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/prompts/prompt-v2/test",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          input: "扩散泵返油怎么办？",
          confirm: "RUN_PROMPT_TEST"
        })
      })
    );
  });
});
