// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { AnswerBlock, MessagePart } from "@/types/chat-v3";
import { AnswerBlocks } from "./answer-blocks";

afterEach(cleanup);

const artifactId = "00000000-0000-4000-8000-000000000002";

describe("AnswerBlocks", () => {
  it("renders adaptive blocks as text without executing raw HTML", () => {
    const blocks: AnswerBlock[] = [
      {
        type: "heading",
        level: 2,
        text: "诊断结果"
      },
      {
        type: "paragraph",
        text: '<img src=x onerror="alert(1)">检查入口压力。',
        evidenceIds: ["E1"]
      },
      {
        type: "list",
        style: "ordered",
        items: ["确认阀门位置", "记录泵温"],
        evidenceIds: []
      },
      {
        type: "table",
        columns: ["参数", "值"],
        rows: [["入口压力", "5 Pa"]],
        evidenceIds: []
      },
      { type: "code", language: "text", code: "P = Q / S" },
      {
        type: "callout",
        tone: "warning",
        title: "安全提示",
        body: "拆机前断电并泄压。",
        evidenceIds: []
      },
      {
        type: "calculation",
        calculationId: "calc-1",
        title: "估算抽速",
        result: "12345.6",
        unit: "L/s",
        assumptions: ["稳态"],
        warnings: ["仅作估算"]
      }
    ];

    const { container } = render(<AnswerBlocks blocks={blocks} />);
    expect(screen.getByRole("heading", { name: "诊断结果" })).toBeVisible();
    expect(screen.getByRole("table")).toHaveTextContent("入口压力5 Pa");
    expect(screen.getByText("12,345.6")).toBeVisible();
    expect(screen.getByText(/<img src=x onerror/)).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("dangerouslySetInnerHTML");
  });

  it("resolves hrefs only through verified link parts and fixed artifact IDs", () => {
    const parts: MessagePart[] = [
      {
        type: "verified_link",
        linkId: "safe",
        url: "https://docs.example.com/manual",
        label: "服务器标签",
        hostname: "docs.example.com",
        status: "verified"
      },
      {
        type: "verified_link",
        linkId: "mismatch",
        url: "https://evil.example/manual",
        label: "伪造链接",
        hostname: "docs.example.com",
        status: "verified"
      },
      {
        type: "artifact",
        artifactId,
        kind: "diagnosis_report",
        title: "诊断报告",
        formats: ["pdf"],
        status: "ready"
      }
    ];
    const blocks: AnswerBlock[] = [
      { type: "link_reference", linkId: "safe", label: "打开手册" },
      {
        type: "link_reference",
        linkId: "mismatch",
        label: "不应打开"
      },
      {
        type: "artifact_reference",
        artifactId,
        label: "下载诊断报告"
      }
    ];

    render(<AnswerBlocks blocks={blocks} parts={parts} />);
    expect(screen.getByRole("link", { name: "打开手册" })).toHaveAttribute(
      "href",
      "https://docs.example.com/manual"
    );
    expect(screen.getByText(/不应打开/).closest("a")).toBeNull();
    expect(screen.getByRole("link", { name: "下载" })).toHaveAttribute(
      "href",
      `/api/chat/artifacts/${artifactId}/download?format=pdf`
    );
  });

  it("loads the private attachment preview only after activation", async () => {
    render(
      <AnswerBlocks
        blocks={[{ type: "heading", level: 2, text: "附件" }]}
        parts={[
          {
            type: "attachment",
            attachmentId: "00000000-0000-4000-8000-000000000009",
            kind: "document",
            filename: "manual.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1024,
            status: "ready"
          }
        ]}
      />
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const previewButton = screen.getByRole("button", { name: "预览" });
    fireEvent.click(previewButton);
    expect(
      await screen.findByRole("dialog", { name: "manual.pdf 预览" })
    ).toBeInTheDocument();
    expect(screen.getByTitle("manual.pdf 私有预览")).toHaveAttribute(
      "src",
      "/api/chat/attachments/00000000-0000-4000-8000-000000000009/preview"
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭附件预览" }));
    await waitFor(() => expect(previewButton).toHaveFocus());
  });
});
