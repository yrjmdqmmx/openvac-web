import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/server/api/errors";

const authMocks = vi.hoisted(() => ({ getSession: vi.fn() }));
const cleanupMocks = vi.hoisted(() => ({
  isUserDeletionInProgress: vi.fn()
}));

vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: authMocks.getSession } }
}));
vi.mock("@/server/auth/account-cleanup", () => cleanupMocks);

import {
  handleDeleteChatAttachment,
  handleDownloadChatAttachment,
  handleGetChatAttachmentStatus,
  handleInitiateChatAttachment,
  handlePreviewChatAttachment
} from "./api";

const attachmentId = "00000000-0000-4000-8000-000000000001";
const conversationId = "00000000-0000-4000-8000-000000000002";
const attachment = {
  id: attachmentId,
  conversationId,
  messageId: null,
  kind: "document" as const,
  filename: "manual.pdf",
  mimeType: "application/pdf",
  sizeBytes: 100,
  status: "ready" as const,
  parseStatus: "ready" as const,
  failureCode: null,
  failureMessage: null,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  readyAt: "2026-08-09T00:00:00.000Z"
};

describe("chat attachment API ownership boundary", () => {
  beforeEach(() => {
    authMocks.getSession.mockReset();
    cleanupMocks.isUserDeletionInProgress.mockReset();
    cleanupMocks.isUserDeletionInProgress.mockResolvedValue(false);
    authMocks.getSession.mockResolvedValue({
      user: {
        id: "user-1",
        email: "user@example.test",
        name: "User",
        banned: false
      },
      session: { id: "session-1" }
    });
  });

  it("uses only the authenticated user for initiation", async () => {
    const initiate = vi.fn(async () => ({
      ...attachment,
      upload: {
        key: "private/chat-attachments/key",
        method: "PUT" as const,
        url: "https://oss.test/short-put",
        requiredHeaders: {},
        expiresAt: "2026-08-09T00:15:00.000Z"
      }
    }));
    const response = await handleInitiateChatAttachment(
      new Request("https://openvac.test/api/chat/attachments?userId=other", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId,
          filename: "manual.pdf",
          mimeType: "application/pdf",
          sizeBytes: 100,
          sha256: "a".repeat(64)
        })
      }),
      { initiate }
    );

    expect(response.status).toBe(201);
    expect(initiate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", conversationId })
    );
    expect(JSON.stringify(await response.json())).not.toContain("other");
  });

  it("never emits signed URLs from status", async () => {
    const status = vi.fn(async () => ({
      ...attachment,
      signedUrl: "https://oss.test/must-not-leak"
    }));
    const response = await handleGetChatAttachmentStatus(
      new Request(`https://openvac.test/api/chat/attachments/${attachmentId}`),
      attachmentId,
      { status }
    );
    const body = await response.text();

    expect(body).not.toContain("must-not-leak");
    expect(body).not.toContain("signedUrl");
    expect(status).toHaveBeenCalledWith({
      attachmentId,
      userId: "user-1"
    });
  });

  it("authenticates deletion and scopes it to the attachment owner", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = await handleDeleteChatAttachment(
      new Request(`https://openvac.test/api/chat/attachments/${attachmentId}`, {
        method: "DELETE"
      }),
      attachmentId,
      { cancel }
    );

    expect(response.status).toBe(204);
    expect(cancel).toHaveBeenCalledWith({
      attachmentId,
      userId: "user-1"
    });
  });

  it.each([
    [handlePreviewChatAttachment, "preview"],
    [handleDownloadChatAttachment, "download"]
  ])("returns a no-store short redirect for %s", async (handler) => {
    const createAccessUrl = vi.fn(
      async () => "https://oss.test/short-private-get"
    );
    const response = await handler(
      new Request(`https://openvac.test/api/chat/attachments/${attachmentId}`),
      attachmentId,
      { createAccessUrl }
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://oss.test/short-private-get"
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("rejects unauthenticated access before calling storage", async () => {
    authMocks.getSession.mockResolvedValueOnce(null);
    const createAccessUrl = vi.fn(async () => {
      throw new ApiError(500, "SHOULD_NOT_RUN", "no");
    });
    const response = await handleDownloadChatAttachment(
      new Request(`https://openvac.test/api/chat/attachments/${attachmentId}`),
      attachmentId,
      { createAccessUrl }
    );

    expect(response.status).toBe(401);
    expect(createAccessUrl).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated deletion before touching attachment state", async () => {
    authMocks.getSession.mockResolvedValueOnce(null);
    const cancel = vi.fn(async () => undefined);
    const response = await handleDeleteChatAttachment(
      new Request(`https://openvac.test/api/chat/attachments/${attachmentId}`, {
        method: "DELETE"
      }),
      attachmentId,
      { cancel }
    );

    expect(response.status).toBe(401);
    expect(cancel).not.toHaveBeenCalled();
  });
});
