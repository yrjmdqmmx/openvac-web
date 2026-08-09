import { describe, expect, it, vi } from "vitest";

import {
  cancelChatAttachment,
  MAX_CHAT_ATTACHMENT_BYTES,
  uploadChatAttachment,
  validateChatAttachmentFile
} from "./chat-attachments";

const attachmentId = "00000000-0000-4000-8000-000000000001";

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("chat attachment adapter", () => {
  it("hashes, privately uploads, completes, and polls until ready", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          data: {
            attachment: {
              type: "attachment",
              attachmentId,
              kind: "document",
              filename: "pump.pdf",
              mimeType: "application/pdf",
              sizeBytes: 4,
              status: "initiated"
            },
            upload: {
              url: "https://private-upload.example/object",
              method: "PUT",
              requiredHeaders: { "x-oss-object-acl": "private" }
            }
          }
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        response({
          data: {
            attachment: {
              type: "attachment",
              attachmentId,
              kind: "document",
              filename: "pump.pdf",
              mimeType: "application/pdf",
              sizeBytes: 4,
              status: "scanning"
            }
          }
        })
      )
      .mockResolvedValueOnce(
        response({
          data: {
            attachment: {
              type: "attachment",
              attachmentId,
              kind: "document",
              filename: "pump.pdf",
              mimeType: "application/pdf",
              sizeBytes: 4,
              status: "processing"
            }
          }
        })
      )
      .mockResolvedValueOnce(
        response({
          data: {
            attachment: {
              type: "attachment",
              attachmentId,
              kind: "document",
              filename: "pump.pdf",
              mimeType: "application/pdf",
              sizeBytes: 4,
              status: "ready"
            }
          }
        })
      );
    const updates: string[] = [];
    const part = await uploadChatAttachment(
      new File(["pump"], "pump.pdf", { type: "application/pdf" }),
      {
        signal: new AbortController().signal,
        fetcher,
        pollIntervalMs: 0,
        onUpdate: (update) => {
          if (update.status) updates.push(update.status);
        }
      }
    );

    expect(part.status).toBe("ready");
    expect(updates).toEqual([
      "hashing",
      "initiated",
      "uploading",
      "scanning",
      "scanning",
      "processing",
      "ready"
    ]);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://private-upload.example/object",
      expect.objectContaining({
        method: "PUT",
        headers: { "x-oss-object-acl": "private" },
        body: expect.any(File)
      })
    );
    const initiatedBody = JSON.parse(
      String((fetcher.mock.calls[0]?.[1] as RequestInit).body)
    ) as { sha256: string };
    expect(initiatedBody.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects unsupported and oversized files before upload", () => {
    expect(
      validateChatAttachmentFile(new File(["x"], "payload.exe"))
    ).toMatchObject({ ok: false });
    const oversized = new File([new Uint8Array(1)], "large.pdf", {
      type: "application/pdf"
    });
    Object.defineProperty(oversized, "size", {
      value: MAX_CHAT_ATTACHMENT_BYTES + 1
    });
    expect(validateChatAttachmentFile(oversized)).toMatchObject({
      ok: false,
      message: "单个附件不能超过 25 MiB。"
    });
  });

  it("uses the conversation-scoped delete endpoint for cancellation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    await cancelChatAttachment(attachmentId, fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      `/api/chat/attachments/${attachmentId}`,
      { method: "DELETE" }
    );
  });
});
