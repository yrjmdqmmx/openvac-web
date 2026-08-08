import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiStore } from "@/server/api/types";

const authMocks = vi.hoisted(() => ({ getSession: vi.fn() }));
const cleanupMocks = vi.hoisted(() => ({
  isUserDeletionInProgress: vi.fn()
}));

vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: authMocks.getSession } }
}));
vi.mock("@/server/auth/account-cleanup", () => cleanupMocks);

import {
  handleCompleteKnowledgeOriginalUpload,
  handleInitiateKnowledgeOriginalUpload
} from "./original-upload-api";

const versionId = "00000000-0000-4000-8000-000000000002";

describe("knowledge original upload API auth", () => {
  beforeEach(() => {
    authMocks.getSession.mockReset();
    cleanupMocks.isUserDeletionInProgress.mockReset();
    cleanupMocks.isUserDeletionInProgress.mockResolvedValue(false);
  });

  it("requires an authenticated admin with knowledge draft capability", async () => {
    const service = { initiate: vi.fn() };
    const store = partialStore({ getAdminRole: vi.fn() });
    authMocks.getSession.mockResolvedValue(null);

    const unauthenticated = await handleInitiateKnowledgeOriginalUpload(
      request("/api/admin/knowledge/uploads", validBody()),
      store,
      service
    );
    expect(unauthenticated.status).toBe(401);
    expect(service.initiate).not.toHaveBeenCalled();

    authMocks.getSession.mockResolvedValue(session());
    vi.mocked(store.getAdminRole).mockResolvedValue("support");
    const forbidden = await handleInitiateKnowledgeOriginalUpload(
      request("/api/admin/knowledge/uploads", validBody()),
      store,
      service
    );
    expect(forbidden.status).toBe(403);
    expect(service.initiate).not.toHaveBeenCalled();
  });

  it("binds the authenticated knowledge editor to initiation and completion", async () => {
    authMocks.getSession.mockResolvedValue(session());
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("knowledge_editor")
    });
    const initiate = vi.fn().mockResolvedValue({ versionId });
    const complete = vi.fn().mockResolvedValue({
      taskId: "task-1",
      taskStatus: "queued",
      documentId: "00000000-0000-4000-8000-000000000001",
      versionId,
      stage: "ocr_pending"
    });

    const initiated = await handleInitiateKnowledgeOriginalUpload(
      request("/api/admin/knowledge/uploads", validBody()),
      store,
      { initiate }
    );
    const completed = await handleCompleteKnowledgeOriginalUpload(
      request(`/api/admin/knowledge/uploads/${versionId}/complete`, {}),
      versionId,
      store,
      { complete }
    );

    expect(initiated.status).toBe(201);
    expect(completed.status).toBe(200);
    expect(initiate).toHaveBeenCalledWith(
      expect.objectContaining({ uploadedBy: "admin-1" })
    );
    expect(initiate.mock.calls[0]?.[0]).not.toHaveProperty("sourceUrl");
    expect(complete).toHaveBeenCalledWith({
      versionId,
      uploadedBy: "admin-1"
    });
  });
});

function partialStore(overrides: Partial<ApiStore>): ApiStore {
  return overrides as ApiStore;
}

function request(path: string, body: unknown): Request {
  return new Request(`https://openvac.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function validBody() {
  return {
    title: "Manual",
    filename: "manual.pdf",
    contentType: "application/pdf",
    sizeBytes: 10,
    sha256: "a".repeat(64)
  };
}

function session() {
  return {
    session: { id: "session-1" },
    user: {
      id: "admin-1",
      name: "Admin",
      email: "admin@example.com",
      banned: false
    }
  };
}
