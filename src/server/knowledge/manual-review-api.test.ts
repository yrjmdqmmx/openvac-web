import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiStore } from "@/server/api/types";

const authMocks = vi.hoisted(() => ({ getSession: vi.fn() }));
const cleanupMocks = vi.hoisted(() => ({ isUserDeletionInProgress: vi.fn() }));

vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: authMocks.getSession } }
}));
vi.mock("@/server/auth/account-cleanup", () => cleanupMocks);

import {
  handleKnowledgeManualResolution,
  handleRetryKnowledgeAutomation
} from "./manual-review-api";

const documentId = "00000000-0000-4000-8000-000000000001";
const versionId = "00000000-0000-4000-8000-000000000002";
const contentHash = "a".repeat(64);

describe("knowledge manual review API", () => {
  beforeEach(() => {
    authMocks.getSession.mockReset();
    cleanupMocks.isUserDeletionInProgress.mockReset();
    cleanupMocks.isUserDeletionInProgress.mockResolvedValue(false);
  });

  it("uses the same knowledge:draft capability for retry and manual resolution", async () => {
    authMocks.getSession.mockResolvedValue(session());
    const forbiddenStore = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("support")
    });
    const service = { retry: vi.fn(), resolve: vi.fn() };

    const retry = await handleRetryKnowledgeAutomation(
      request("retry", {
        expectedVersionId: versionId,
        expectedContentHash: contentHash
      }),
      documentId,
      forbiddenStore,
      service
    );
    const resolve = await handleKnowledgeManualResolution(
      request("manual-resolution", {
        action: "archive",
        expectedVersionId: versionId,
        expectedContentHash: contentHash
      }),
      documentId,
      forbiddenStore,
      service
    );

    expect(retry.status).toBe(403);
    expect(resolve.status).toBe(403);
    expect(service.retry).not.toHaveBeenCalled();
    expect(service.resolve).not.toHaveBeenCalled();
  });

  it("binds the authenticated knowledge editor and current target to retry", async () => {
    authMocks.getSession.mockResolvedValue(session());
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("knowledge_editor")
    });
    const service = {
      retry: vi.fn().mockResolvedValue({ status: "queued" }),
      resolve: vi.fn()
    };

    const response = await handleRetryKnowledgeAutomation(
      request("retry", {
        expectedVersionId: versionId,
        expectedContentHash: contentHash
      }),
      documentId,
      store,
      service
    );

    expect(response.status).toBe(200);
    expect(service.retry).toHaveBeenCalledWith({
      documentId,
      expectedVersionId: versionId,
      expectedContentHash: contentHash,
      actorId: "admin-1",
      actorRole: "knowledge_editor",
      requestId: expect.any(String)
    });
  });

  it("requires a non-empty note for manual approval before calling the service", async () => {
    authMocks.getSession.mockResolvedValue(session());
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("knowledge_editor")
    });
    const service = { retry: vi.fn(), resolve: vi.fn() };

    const response = await handleKnowledgeManualResolution(
      request("manual-resolution", {
        action: "manual_approve_with_note",
        expectedVersionId: versionId,
        expectedContentHash: contentHash,
        note: " "
      }),
      documentId,
      store,
      service
    );

    expect(response.status).toBe(422);
    expect(service.resolve).not.toHaveBeenCalled();
  });
});

function partialStore(overrides: Partial<ApiStore>): ApiStore {
  return overrides as ApiStore;
}

function request(action: string, body: unknown): Request {
  return new Request(
    `https://openvac.test/api/admin/knowledge/${documentId}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }
  );
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
