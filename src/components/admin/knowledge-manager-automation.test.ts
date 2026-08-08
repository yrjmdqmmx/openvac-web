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

describe("knowledge manager original uploads", () => {
  it("hashes a dropped supported file, PUTs with every signed header, then completes", async () => {
    const sha256 = "ab".repeat(32);
    const digest = Uint8Array.from(
      sha256.match(/.{2}/gu)!.map((byte) => Number.parseInt(byte, 16))
    ).buffer;
    const digestMock = vi.fn().mockResolvedValue(digest);
    Object.defineProperty(globalThis.crypto, "subtle", {
      configurable: true,
      value: { digest: digestMock }
    });
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push([url, init]);
        if (url === "/api/admin/knowledge/uploads") {
          return response(
            {
              documentId: "document-1",
              versionId: "00000000-0000-4000-8000-000000000001",
              upload: {
                uploadUrl: "https://uploads.invalid/private-object",
                method: "PUT",
                requiredHeaders: {
                  "Content-Type": "application/pdf",
                  "Content-Length": "4",
                  "x-oss-forbid-overwrite": "true",
                  "x-oss-meta-sha256": sha256
                }
              }
            },
            201
          );
        }
        if (url === "https://uploads.invalid/private-object") {
          return response({}, 200);
        }
        if (url.endsWith("/complete")) {
          return response({ taskId: "task-1", taskStatus: "queued" });
        }
        return response({ items: [] });
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = Object.assign(
      new File([Uint8Array.from([1, 2, 3, 4])], "pump manual.pdf", {
        type: "application/pdf"
      }),
      { arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer }
    );

    render(createElement(KnowledgeManager));
    fireEvent.change(await screen.findByLabelText("资料来源链接（可选）"), {
      target: { value: "https://example.org/manual.pdf" }
    });
    fireEvent.change(screen.getByLabelText("资料说明（可选）"), {
      target: { value: "制造商公开维护手册" }
    });
    const dropZone = await screen.findByLabelText("上传知识原件");
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    await waitFor(() =>
      expect(digestMock).toHaveBeenCalledWith(
        "SHA-256",
        expect.any(ArrayBuffer)
      )
    );
    await waitFor(() =>
      expect(calls).toContainEqual([
        "/api/admin/knowledge/uploads",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            title: "pump manual",
            sourceUrl: "https://example.org/manual.pdf",
            description: "制造商公开维护手册",
            filename: "pump manual.pdf",
            contentType: "application/pdf",
            sizeBytes: 4,
            sha256
          })
        })
      ])
    );
    expect(calls).toContainEqual([
      "https://uploads.invalid/private-object",
      expect.objectContaining({
        method: "PUT",
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": "4",
          "x-oss-forbid-overwrite": "true",
          "x-oss-meta-sha256": sha256
        },
        body: file
      })
    ]);
    expect(calls.some(([url]) => url.endsWith("/complete"))).toBe(true);
    expect(
      await screen.findByText("上传完成，自动审核任务已排队。")
    ).toBeInTheDocument();
  });

  it("shows a recoverable upload error and keeps the supported file chooser", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === "/api/admin/knowledge/uploads"
          ? response({}, 503)
          : response({ items: [] })
      )
    );
    Object.defineProperty(globalThis.crypto, "subtle", {
      configurable: true,
      value: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).buffer) }
    });
    const file = Object.assign(
      new File(["text"], "notes.md", { type: "text/markdown" }),
      { arrayBuffer: async () => new TextEncoder().encode("text").buffer }
    );

    render(createElement(KnowledgeManager));
    const chooser = await screen.findByLabelText("选择知识原件");
    expect(chooser).toHaveAttribute(
      "accept",
      ".pdf,.docx,.xlsx,.csv,.txt,.md,.jpg,.jpeg,.png"
    );
    fireEvent.change(chooser, { target: { files: [file] } });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "知识原件上传失败"
    );
    expect(screen.getByRole("button", { name: "重试上传" })).toBeEnabled();
  });
});

describe("knowledge manager automation review", () => {
  it("shows document-level automation evidence and hides section actions", async () => {
    const documentId = "00000000-0000-4000-8000-000000000010";
    const versionId = "00000000-0000-4000-8000-000000000011";
    const contentHash = "c".repeat(64);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/knowledge") {
        return response({
          items: [
            {
              id: documentId,
              title: "自动审核手册",
              status: "review",
              currentVersionId: versionId,
              contentHash,
              reviewStatus: "required",
              publishReady: false,
              publishBlockers: ["等待人工处理"],
              automationReview: {
                status: "needs_human",
                phase: "verify",
                risk: "high",
                decision: "needs_human",
                summary: "参数表与原件存在冲突。",
                blockers: [{ code: "MISMATCH", message: "抽速值不一致" }],
                findings: [{ code: "UNIT", message: "单位已规范" }],
                evidence: [
                  {
                    claim: "额定抽速为 8 L/s",
                    exactEvidence: "Pumping speed: 8 L/s",
                    sourceLocator: "第 12 页表 3"
                  }
                ],
                revision: {
                  changed: true,
                  inputContentHash: "a".repeat(64),
                  outputContentHash: contentHash,
                  inputVersionId: "00000000-0000-4000-8000-000000000009",
                  outputVersionId: versionId
                }
              }
            }
          ]
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(KnowledgeManager));

    expect(
      await screen.findByText("参数表与原件存在冲突。")
    ).toBeInTheDocument();
    expect(screen.getByText("高风险")).toBeInTheDocument();
    expect(screen.getByText("抽速值不一致")).toBeInTheDocument();
    expect(screen.getByText("Pumping speed: 8 L/s")).toBeInTheDocument();
    expect(screen.getByText("第 12 页表 3")).toBeInTheDocument();
    expect(screen.getByText("自动修订已生成新版本")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "通过段落" })
    ).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/admin/knowledge/${documentId}/review`,
      expect.anything()
    );
  });

  it("binds manual approval to the selected current version and hash with a note", async () => {
    const documentId = "00000000-0000-4000-8000-000000000020";
    const versionId = "00000000-0000-4000-8000-000000000021";
    const contentHash = "d".repeat(64);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/manual-resolution") && init?.method === "POST") {
          return response({ action: "manual_approve_with_note" });
        }
        return response({
          items: [
            {
              id: documentId,
              title: "需人工批准资料",
              status: "review",
              currentVersionId: versionId,
              contentHash,
              reviewStatus: "required",
              publishReady: false,
              publishBlockers: [],
              automationReview: {
                status: "needs_human",
                phase: "verify",
                risk: "medium",
                decision: "needs_human",
                summary: "需人工确认权利与内容。",
                blockers: [],
                findings: [],
                evidence: []
              }
            }
          ]
        });
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(KnowledgeManager));
    fireEvent.change(await screen.findByLabelText("人工处理备注"), {
      target: { value: "已逐项核对原件及当前来源权利记录。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "带备注人工批准" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/admin/knowledge/${documentId}/manual-resolution`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            action: "manual_approve_with_note",
            expectedVersionId: versionId,
            expectedContentHash: contentHash,
            note: "已逐项核对原件及当前来源权利记录。"
          })
        })
      )
    );
  });
});
