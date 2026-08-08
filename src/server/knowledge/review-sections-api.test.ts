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
  handleCompleteKnowledgeSectionReview,
  handleGetKnowledgeSectionReview,
  handleKnowledgeSectionDecision
} from "./review-sections-api";

const ids = {
  document: "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
  version: "cb71f682-9bdc-4899-b7b3-c459402b192c",
  section: "ab71f682-9bdc-4899-b7b3-c459402b192c"
};

function store(role: "knowledge_editor" | "support" = "knowledge_editor") {
  return {
    getAdminRole: vi.fn().mockResolvedValue(role)
  } as unknown as ApiStore;
}

function request(path: string, body?: unknown): Request {
  return new Request(`https://openvac.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-request-id": "request-1"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

describe("knowledge section review API", () => {
  beforeEach(() => {
    cleanupMocks.isUserDeletionInProgress.mockResolvedValue(false);
    authMocks.getSession.mockResolvedValue({
      user: {
        id: "reviewer-1",
        email: "reviewer@example.com",
        emailVerified: true,
        name: "审核人"
      },
      session: { id: "session-1" }
    });
  });

  it("requires knowledge:review and returns the current section workspace", async () => {
    const service = {
      getWorkspace: vi.fn().mockResolvedValue({
        documentId: ids.document,
        versionId: ids.version,
        sections: []
      })
    };
    const response = await handleGetKnowledgeSectionReview(
      request(`/api/admin/knowledge/${ids.document}/review`),
      ids.document,
      store(),
      service
    );

    expect(response.status).toBe(200);
    expect(service.getWorkspace).toHaveBeenCalledWith(ids.document);
  });

  it("submits a pinned section decision as the authenticated reviewer", async () => {
    const service = { decide: vi.fn().mockResolvedValue({ id: ids.section }) };
    const response = await handleKnowledgeSectionDecision(
      request(
        `/api/admin/knowledge/${ids.document}/versions/${ids.version}/sections/${ids.section}/decision`,
        {
          expectedSectionHash: "a".repeat(64),
          expectedRevision: 0,
          decision: "changes_requested",
          note: "原文与中文表述不一致。"
        }
      ),
      {
        documentId: ids.document,
        versionId: ids.version,
        sectionId: ids.section
      },
      store(),
      service
    );

    expect(response.status).toBe(200);
    expect(service.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: ids.document,
        versionId: ids.version,
        sectionId: ids.section,
        reviewerId: "reviewer-1",
        decision: "changes_requested"
      })
    );
  });

  it("completes review without invoking publication", async () => {
    const service = {
      complete: vi.fn().mockResolvedValue({
        documentId: ids.document,
        versionStatus: "review"
      })
    };
    const response = await handleCompleteKnowledgeSectionReview(
      request(
        `/api/admin/knowledge/${ids.document}/versions/${ids.version}/complete-review`,
        {
          versionId: ids.version,
          expectedContentHash: "b".repeat(64)
        }
      ),
      { documentId: ids.document, versionId: ids.version },
      store(),
      service
    );

    expect(response.status).toBe(200);
    expect(service.complete).toHaveBeenCalledWith({
      documentId: ids.document,
      versionId: ids.version,
      expectedContentHash: "b".repeat(64),
      reviewerId: "reviewer-1"
    });
  });

  it("rejects a complete-review body pinned to another version", async () => {
    const service = { complete: vi.fn() };
    const response = await handleCompleteKnowledgeSectionReview(
      request(
        `/api/admin/knowledge/${ids.document}/versions/${ids.version}/complete-review`,
        {
          versionId: "eb71f682-9bdc-4899-b7b3-c459402b192c",
          expectedContentHash: "b".repeat(64)
        }
      ),
      { documentId: ids.document, versionId: ids.version },
      store(),
      service
    );

    expect(response.status).toBe(409);
    expect(service.complete).not.toHaveBeenCalled();
  });

  it("denies roles without knowledge:review", async () => {
    const service = { getWorkspace: vi.fn() };
    const response = await handleGetKnowledgeSectionReview(
      request(`/api/admin/knowledge/${ids.document}/review`),
      ids.document,
      store("support"),
      service
    );

    expect(response.status).toBe(403);
    expect(service.getWorkspace).not.toHaveBeenCalled();
  });
});
