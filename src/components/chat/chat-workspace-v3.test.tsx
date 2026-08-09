// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const attachmentMocks = vi.hoisted(() => ({
  uploadChatAttachment: vi.fn(),
  cancelChatAttachment: vi.fn()
}));

vi.mock("@/lib/chat-attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat-attachments")>()),
  ...attachmentMocks
}));

import { ChatWorkspace } from "./chat-workspace";

const attachmentId = "00000000-0000-4000-8000-000000000021";
const runId = "00000000-0000-4000-8000-000000000022";
const turnId = "00000000-0000-4000-8000-000000000023";
const conversationId = "00000000-0000-4000-8000-000000000024";
const artifactId = "00000000-0000-4000-8000-000000000027";

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("ChatWorkspace V3 message flow", () => {
  it("sends text, link, and ready attachment parts and renders V3 blocks", async () => {
    attachmentMocks.uploadChatAttachment.mockImplementation(
      async (
        file: File,
        options: {
          onUpdate: (update: {
            attachmentId?: string;
            status?: string;
          }) => void;
        }
      ) => {
        options.onUpdate({ status: "uploading" });
        options.onUpdate({ attachmentId, status: "scanning" });
        options.onUpdate({ status: "processing" });
        return {
          type: "attachment" as const,
          attachmentId,
          kind: "document" as const,
          filename: file.name,
          mimeType: "application/pdf",
          sizeBytes: file.size,
          status: "ready" as const
        };
      }
    );

    let chatBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/chat" && init?.method === "POST") {
          chatBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          const answer = {
            schemaVersion: "openvac.answer.v3",
            answerKind: "direct",
            riskLevel: "low",
            blocks: [
              { type: "heading", level: 2, text: "V3 回答" },
              {
                type: "paragraph",
                text: "已读取工程附件。",
                evidenceIds: []
              },
              {
                type: "link_reference",
                linkId: "link-manual",
                label: "已验证设备手册"
              },
              {
                type: "artifact_reference",
                artifactId,
                label: "诊断报告"
              }
            ],
            missingInputs: [],
            usedEvidenceIds: [],
            usedLinkIds: []
          };
          const meta = {
            riskLevel: "low",
            missingInputs: [],
            webSearched: false,
            citations: [],
            turnId,
            runId,
            answerVersion: 1,
            verifiedLinks: [
              {
                type: "verified_link",
                linkId: "link-manual",
                url: "https://docs.example.com/manual",
                label: "设备手册",
                hostname: "docs.example.com",
                status: "verified"
              }
            ],
            artifacts: [
              {
                type: "artifact",
                artifactId,
                kind: "diagnosis_report",
                title: "诊断报告",
                formats: ["pdf"],
                status: "ready"
              }
            ]
          };
          return streamResponse([
            {
              type: "run.accepted",
              runId,
              sequence: 1,
              turnId,
              conversationId,
              userMessageId: "00000000-0000-4000-8000-000000000025",
              messageId: "00000000-0000-4000-8000-000000000026",
              answerVersion: 1
            },
            {
              type: "answer.block.committed",
              runId,
              sequence: 2,
              block: answer.blocks[0],
              index: 0
            },
            {
              type: "run.completed",
              runId,
              sequence: 3,
              turnId,
              conversationId,
              messageId: "00000000-0000-4000-8000-000000000026",
              answerVersion: 1,
              answer,
              meta
            }
          ]);
        }
        return jsonResponse({
          data: { items: [], page: 1, pageSize: 20, total: 0 }
        });
      })
    );

    render(
      <ChatWorkspace
        userId="user-a"
        userName="用户 A"
        userEmail="user-a@openvac.test"
      />
    );
    fireEvent.change(screen.getByLabelText("添加工程附件"), {
      target: {
        files: [new File(["manual"], "manual.pdf", { type: "application/pdf" })]
      }
    });
    await waitFor(() => expect(screen.getByText(/就绪/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "链接" }));
    fireEvent.change(screen.getByLabelText("HTTPS 链接"), {
      target: { value: "https://docs.example.com/manual" }
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    fireEvent.change(screen.getByLabelText("继续提问"), {
      target: { value: "分析这份手册" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(
      await screen.findByRole("heading", { name: "V3 回答" })
    ).toBeInTheDocument();
    expect(chatBody).toMatchObject({
      protocolVersion: 3,
      parts: [
        { type: "text", text: "分析这份手册" },
        {
          type: "link",
          url: "https://docs.example.com/manual",
          label: "docs.example.com"
        },
        { type: "attachment", attachmentId }
      ]
    });
    expect(chatBody).not.toHaveProperty("message");
    expect(screen.getByText("manual.pdf")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "已验证设备手册" })
    ).toHaveAttribute("href", "https://docs.example.com/manual");
    expect(screen.getByText("诊断报告")).toBeInTheDocument();
  });
});

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function streamResponse(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}
