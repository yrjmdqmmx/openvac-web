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

  it("approves the exact current knowledge hash with an optional note", async () => {
    const contentHash = "b".repeat(64);
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
              contentHash,
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

    const note = await screen.findByRole("textbox", { name: "审核备注" });
    fireEvent.change(note, { target: { value: "来源与页码已核对。" } });
    fireEvent.click(screen.getByRole("button", { name: "批准" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/knowledge/document-approve/review",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            versionId: "version-approve",
            expectedContentHash: contentHash,
            decision: "approved",
            note: "来源与页码已核对。"
          })
        })
      )
    );
  });

  it("requires a note and submits knowledge rejection", async () => {
    const contentHash = "c".repeat(64);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          items: [
            {
              id: "document-reject",
              title: "需要退回的知识",
              status: "review",
              currentVersionId: "version-reject",
              versionStatus: "review",
              contentHash,
              reviewStatus: "required",
              publishReady: false,
              publishBlockers: []
            }
          ]
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(KnowledgeManager));

    const reject = await screen.findByRole("button", { name: "驳回" });
    expect(reject).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "审核备注" }), {
      target: { value: "引用缺少具体页码。" }
    });
    expect(reject).toBeEnabled();
    fireEvent.click(reject);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/knowledge/document-reject/review",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            versionId: "version-reject",
            expectedContentHash: contentHash,
            decision: "rejected",
            note: "引用缺少具体页码。"
          })
        })
      )
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
