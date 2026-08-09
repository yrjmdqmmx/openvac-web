import { beforeEach, describe, expect, it, vi } from "vitest";

import { notFound } from "@/server/api/errors";

const authMocks = vi.hoisted(() => ({ getSession: vi.fn() }));
const cleanupMocks = vi.hoisted(() => ({
  isUserDeletionInProgress: vi.fn()
}));

vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: authMocks.getSession } }
}));
vi.mock("@/server/auth/account-cleanup", () => cleanupMocks);

import {
  handleDownloadChatArtifact,
  handleGetChatArtifactStatus,
  handlePreviewChatArtifact
} from "./artifact-api";

const artifactId = "00000000-0000-4000-8000-000000000001";
const conversationId = "00000000-0000-4000-8000-000000000002";
const sourceTurnId = "00000000-0000-4000-8000-000000000003";
const artifact = {
  id: artifactId,
  conversationId,
  sourceTurnId,
  kind: "diagnosis_report" as const,
  title: "Pump diagnosis",
  formats: ["pdf"] as ["pdf"],
  status: "ready" as const,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:01.000Z",
  readyAt: "2026-08-09T00:00:01.000Z"
};

describe("chat artifact API ownership boundary", () => {
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

  it("uses only the authenticated owner and returns private no-store status", async () => {
    const status = vi.fn(async () => ({
      ...artifact,
      objectKey: "private/must-not-leak",
      signedUrl: "https://oss.test/must-not-leak"
    }));
    const response = await handleGetChatArtifactStatus(
      new Request(
        `https://openvac.test/api/chat/artifacts/${artifactId}?userId=other`
      ),
      artifactId,
      { status }
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(status).toHaveBeenCalledWith({
      artifactId,
      userId: "user-1"
    });
    expect(body).not.toContain("objectKey");
    expect(body).not.toContain("signedUrl");
    expect(body).not.toContain("must-not-leak");
  });

  it("keeps a non-owner response indistinguishable from missing", async () => {
    const status = vi.fn(async () => {
      throw notFound("产物");
    });
    const response = await handleGetChatArtifactStatus(
      new Request(`https://openvac.test/api/chat/artifacts/${artifactId}`),
      artifactId,
      { status }
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "NOT_FOUND" }
    });
  });

  it.each([
    [handlePreviewChatArtifact, "preview"],
    [handleDownloadChatArtifact, "download"]
  ])(
    "returns a private redirect for the frontend %s path",
    async (handler, path) => {
      const createAccessUrl = vi.fn(
        async () => "https://oss.test/short-private-artifact"
      );
      const response = await handler(
        new Request(
          `https://openvac.test/api/chat/artifacts/${artifactId}/${path}?format=pdf`
        ),
        artifactId,
        { createAccessUrl }
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://oss.test/short-private-artifact"
      );
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(createAccessUrl).toHaveBeenCalledWith({
        artifactId,
        userId: "user-1",
        format: "pdf"
      });
    }
  );

  it.each([
    ["not-a-uuid", "pdf"],
    [artifactId, "exe"],
    [artifactId, ""]
  ])(
    "rejects invalid artifact id/format before storage",
    async (id, format) => {
      const createAccessUrl = vi.fn(async () => "https://oss.test/never");
      const response = await handleDownloadChatArtifact(
        new Request(
          `https://openvac.test/api/chat/artifacts/${id}/download?format=${format}`
        ),
        id,
        { createAccessUrl }
      );

      expect(response.status).toBe(422);
      expect(createAccessUrl).not.toHaveBeenCalled();
    }
  );

  it("authenticates before resolving private object access", async () => {
    authMocks.getSession.mockResolvedValueOnce(null);
    const createAccessUrl = vi.fn(async () => "https://oss.test/never");
    const response = await handleDownloadChatArtifact(
      new Request(
        `https://openvac.test/api/chat/artifacts/${artifactId}/download?format=pdf`
      ),
      artifactId,
      { createAccessUrl }
    );

    expect(response.status).toBe(401);
    expect(createAccessUrl).not.toHaveBeenCalled();
  });
});
