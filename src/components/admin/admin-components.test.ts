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

import { KnowledgeManager } from "./knowledge-manager";
import { AdminModuleTable } from "./module-table";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  } as Response;
}

describe("admin components", () => {
  it("keeps the knowledge search field usable beside the detail panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: { items: [] } }))
    );

    render(createElement(KnowledgeManager));
    await screen.findByText("还没有可显示的资料");

    const search = screen.getByRole("searchbox", {
      name: "搜索知识文档或来源"
    });
    expect(search).toHaveAttribute("placeholder", "搜索文档或来源");
    expect(search.closest("div")).toHaveClass("sm:grid-cols-2");
    expect(search.closest("label")).toHaveClass("min-w-0");
  });

  it("imports governed JSON and applies real knowledge filters", async () => {
    const candidate = {
      sourceCanonicalUrl: "https://www.hse.gov.uk/example",
      document: { externalKey: "hse-example-v1", title: "HSE 导入资料" },
      citation: { ingestionMode: "full_text", licenseClass: "open" },
      review: { status: "required", requirements: ["人工复核"] },
      sections: []
    };
    let listCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/knowledge/import" && init?.method === "POST") {
        return jsonResponse({ data: { id: "imported" } }, 201);
      }
      listCalls += 1;
      return jsonResponse({
        data: {
          items: [
            {
              id: "review-document",
              title: "待审 HSE 资料",
              status: "review",
              sourceTier: "open_license",
              licensePolicy: "open",
              publishReady: false,
              publishBlockers: ["待人工审核"]
            },
            {
              id: "published-document",
              title: "已发布内部资料",
              status: "published",
              sourceTier: "internal",
              licensePolicy: "internal-use",
              publishReady: false,
              publishBlockers: []
            }
          ]
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(KnowledgeManager));
    expect(await screen.findAllByText("待审 HSE 资料")).not.toHaveLength(0);

    fireEvent.change(screen.getByLabelText("来源层级"), {
      target: { value: "internal" }
    });
    expect(screen.queryAllByText("待审 HSE 资料")).toHaveLength(0);
    expect(screen.getAllByText("已发布内部资料")).not.toHaveLength(0);

    const file = Object.assign(
      new File([JSON.stringify(candidate)], "candidate.json", {
        type: "application/json"
      }),
      { text: async () => JSON.stringify(candidate) }
    );
    fireEvent.change(screen.getByLabelText("导入待审知识 JSON"), {
      target: { files: [file] }
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/knowledge/import",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(candidate)
        })
      )
    );
    await waitFor(() => expect(listCalls).toBeGreaterThan(1));
    expect(
      await screen.findByText("导入成功，资料已进入逐段人工复核。")
    ).toBeInTheDocument();
  });

  it("reviews normalized knowledge sections against the official paragraph", async () => {
    const documentId = "d607d4d6-82df-4f1b-a5d4-7d80277e327d";
    const versionId = "cb71f682-9bdc-4899-b7b3-c459402b192c";
    const sectionId = "ab71f682-9bdc-4899-b7b3-c459402b192c";
    const sectionHash = "a".repeat(64);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `/api/admin/knowledge/${documentId}/review`) {
        return jsonResponse({
          data: {
            documentId,
            versionId,
            versionContentHash: "b".repeat(64),
            versionStatus: "draft",
            sections: [
              {
                id: sectionId,
                versionId,
                sectionIndex: 0,
                contentZh: "真空泵应定期检查。",
                officialText: "Check the vacuum pump regularly.",
                pageStart: 4,
                pageEnd: 4,
                sectionHash,
                reviewStatus: "required",
                decision: null
              }
            ]
          }
        });
      }
      if (url.includes("/decision") && init?.method === "POST") {
        return jsonResponse({ data: { id: sectionId } });
      }
      return jsonResponse({
        data: {
          items: [
            {
              id: documentId,
              title: "逐段审核资料",
              status: "draft",
              currentVersionId: versionId,
              versionStatus: "draft",
              contentHash: "b".repeat(64),
              reviewStatus: "required",
              publishReady: false,
              publishBlockers: ["必须先完成逐段审核。"]
            }
          ]
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(KnowledgeManager));

    expect(await screen.findByText("真空泵应定期检查。")).toBeInTheDocument();
    expect(
      screen.getByText("Check the vacuum pump regularly.")
    ).toBeInTheDocument();
    expect(screen.getByText("第 4 页")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "通过段落" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/admin/knowledge/${documentId}/versions/${versionId}/sections/${sectionId}/decision`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            expectedSectionHash: sectionHash,
            expectedRevision: 0,
            decision: "approved"
          })
        })
      )
    );
  });

  it("renders review, embedding and publish readiness from knowledge detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          items: [
            {
              id: "document-1",
              title: "旋片泵维护手册",
              status: "review",
              updatedAt: "2026-07-31T08:00:00.000Z",
              source: {
                name: "OpenVac 内部资料",
                sourceTier: "internal",
                licensePolicy: "internal-use"
              },
              currentVersion: {
                id: "version-1",
                version: 2,
                status: "review",
                contentHash:
                  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                citationMetadata: { ingestionMode: "full_text" },
                metadata: {
                  reviewStatus: "approved",
                  embeddingStatus: "completed",
                  review: {
                    reviewedBy: "knowledge-editor-1",
                    reviewedAt: "2026-07-31T08:30:00.000Z"
                  }
                }
              },
              chunkCount: 4,
              embeddedChunkCount: 4,
              publishReady: true,
              publishBlockers: []
            }
          ]
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(KnowledgeManager));

    expect(await screen.findAllByText("人审已通过")).not.toHaveLength(0);
    expect(screen.getAllByText("Embedding 已完成")).not.toHaveLength(0);
    expect(screen.getAllByText("可发布")).not.toHaveLength(0);

    const publishButton = screen.getByRole("button", { name: "发布新修订" });
    expect(publishButton).toBeEnabled();
    fireEvent.click(publishButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/knowledge/document-1/publish",
        expect.objectContaining({ method: "POST" })
      )
    );
  });

  it("does not expose legacy whole-document approve or reject actions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          items: [
            {
              id: "document-approve",
              title: "待审知识",
              status: "draft",
              currentVersionId: "version-approve",
              versionStatus: "draft",
              contentHash: "b".repeat(64),
              reviewStatus: "required",
              publishReady: false,
              publishBlockers: ["必须先完成人工复核。"]
            }
          ]
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(KnowledgeManager));

    expect(await screen.findByText(/整份哈希批准已停用/u)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "批准" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "驳回" })
    ).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/admin/knowledge/document-approve/review",
      expect.anything()
    );
  });

  it("archives a knowledge document through the audited endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          items: [
            {
              id: "document-archive",
              title: "已发布知识",
              status: "published",
              currentVersionId: "version-published",
              versionStatus: "published",
              contentHash: "d".repeat(64),
              reviewStatus: "approved",
              publishReady: false,
              publishBlockers: []
            }
          ]
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(KnowledgeManager));
    fireEvent.click(await screen.findByRole("button", { name: "归档文档" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/knowledge/document-archive/archive",
        expect.objectContaining({ method: "POST", body: "{}" })
      )
    );
  });

  it("renders direct data arrays with the users API field names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            {
              id: "user-1",
              email: "user@example.com",
              name: "测试用户",
              banned: true,
              dailyQuotaBonus: 5,
              createdAt: "2026-07-31T08:00:00.000Z"
            }
          ]
        })
      )
    );

    render(createElement(AdminModuleTable, { section: "users" }));

    expect(await screen.findByText("user@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "封禁" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "每日加额" })
    ).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });
});
