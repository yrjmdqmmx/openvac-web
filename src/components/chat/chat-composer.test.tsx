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
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const attachmentMocks = vi.hoisted(() => ({
  uploadChatAttachment: vi.fn(),
  cancelChatAttachment: vi.fn()
}));

vi.mock("@/lib/chat-attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat-attachments")>()),
  ...attachmentMocks
}));

import type { LocalChatAttachment } from "@/lib/chat-attachments";
import { ChatComposer, type ComposerLink } from "./chat-composer";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function Harness({ onSubmit = vi.fn(), onError = vi.fn() }) {
  const [input, setInput] = useState("");
  const [links, setLinks] = useState<ComposerLink[]>([]);
  const [attachments, setAttachments] = useState<LocalChatAttachment[]>([]);
  return (
    <ChatComposer
      input={input}
      onInputChange={setInput}
      links={links}
      onLinksChange={setLinks}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      conversationId="00000000-0000-4000-8000-000000000010"
      busy={false}
      mode="auto"
      webMode="auto"
      onModeChange={vi.fn()}
      onWebModeChange={vi.fn()}
      onSubmit={onSubmit}
      onCancelRun={vi.fn()}
      onError={onError}
    />
  );
}

describe("ChatComposer", () => {
  it("adds HTTPS link chips and rejects non-HTTPS candidates", () => {
    const onError = vi.fn();
    render(<Harness onError={onError} />);

    fireEvent.click(screen.getByRole("button", { name: "链接" }));
    fireEvent.change(screen.getByLabelText("HTTPS 链接"), {
      target: { value: "http://example.com/manual" }
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(onError).toHaveBeenCalledWith(
      "链接必须使用 HTTPS，且不能包含账号凭据。"
    );

    fireEvent.change(screen.getByLabelText("HTTPS 链接"), {
      target: { value: "https://docs.example.com/manual" }
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(screen.getByText("docs.example.com")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "移除链接 docs.example.com" })
    ).toBeVisible();
  });

  it("keeps send disabled through upload and scanning, then enables at ready", async () => {
    let release: (() => void) | undefined;
    attachmentMocks.uploadChatAttachment.mockImplementation(
      async (
        file: File,
        options: {
          onUpdate: (update: Partial<LocalChatAttachment>) => void;
        }
      ) => {
        options.onUpdate({ status: "uploading" });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        options.onUpdate({
          attachmentId: "00000000-0000-4000-8000-000000000001",
          status: "scanning"
        });
        return {
          type: "attachment" as const,
          attachmentId: "00000000-0000-4000-8000-000000000001",
          kind: "document" as const,
          filename: file.name,
          mimeType: "application/pdf",
          sizeBytes: file.size,
          status: "ready" as const
        };
      }
    );
    render(<Harness />);

    fireEvent.change(screen.getByLabelText("添加工程附件"), {
      target: {
        files: [new File(["manual"], "manual.pdf", { type: "application/pdf" })]
      }
    });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(await screen.findByText(/上传中/)).toBeVisible();

    await act(async () => release?.());
    await waitFor(() => expect(screen.getByText(/就绪/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    expect(screen.getByText(/发送到阿里云模型处理/)).toBeInTheDocument();
    expect(screen.getByText(/图片不超过 10 MiB/)).toBeInTheDocument();
    expect(screen.getByText(/文档不超过\s*25 MiB/)).toBeInTheDocument();
  });

  it("shows the localized 10 MiB image limit before starting an upload", () => {
    const onError = vi.fn();
    render(<Harness onError={onError} />);
    const image = new File([new Uint8Array(1)], "gauge.png", {
      type: "image/png"
    });
    Object.defineProperty(image, "size", { value: 10 * 1024 * 1024 + 1 });

    fireEvent.change(screen.getByLabelText("添加工程附件"), {
      target: { files: [image] }
    });

    expect(onError).toHaveBeenCalledWith(
      "gauge.png：单张 JPG 或 PNG 图片不能超过 10 MiB；文档仍可上传至 25 MiB。"
    );
    expect(attachmentMocks.uploadChatAttachment).not.toHaveBeenCalled();
  });

  it("surfaces deletion failure and does not start a duplicate upload", async () => {
    const onError = vi.fn();
    attachmentMocks.uploadChatAttachment.mockResolvedValue({
      type: "attachment",
      attachmentId: "00000000-0000-4000-8000-000000000001",
      kind: "document",
      filename: "manual.pdf",
      mimeType: "application/pdf",
      sizeBytes: 6,
      status: "failed"
    });
    attachmentMocks.cancelChatAttachment.mockRejectedValue(
      new Error("附件删除暂时不可用。")
    );
    render(<Harness onError={onError} />);

    fireEvent.change(screen.getByLabelText("添加工程附件"), {
      target: {
        files: [new File(["manual"], "manual.pdf", { type: "application/pdf" })]
      }
    });
    const retry = await screen.findByRole("button", {
      name: "重试附件 manual.pdf"
    });
    fireEvent.click(retry);

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("附件删除暂时不可用。")
    );
    expect(attachmentMocks.uploadChatAttachment).toHaveBeenCalledTimes(1);
    expect(screen.getByText("附件删除暂时不可用。")).toBeVisible();
  });
});
