import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiStore, AuditContext } from "./types";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn()
}));
const notificationMocks = vi.hoisted(() => ({
  sendProblemReportNotification: vi.fn()
}));

vi.mock("@/server/auth", () => ({
  auth: {
    api: {
      getSession: authMocks.getSession
    }
  }
}));
vi.mock("@/server/problem-reports/notification", () => notificationMocks);

import {
  handleArchiveKnowledge,
  handleGrantAdminRole,
  handleListAuditLogs,
  handleListAdminConversations,
  handleListAdminProblemReports,
  handleListAdmins,
  handleRevokeAdminRole,
  handleReviewKnowledgeDocument,
  handleSetProblemReportStatus,
  handleGetBudgets,
  handleUpdateBudgets
} from "./admin";
import { handleClearConversationData } from "./account";
import { handleCreateConversation } from "./conversations";
import { handleMessageFeedback } from "./messages";
import { handleCreateProblemReport } from "./problem-reports";

function partialStore(overrides: Partial<ApiStore>): ApiStore {
  return overrides as ApiStore;
}

function jsonRequest(path: string, body: unknown, method = "POST"): Request {
  return new Request(`https://openvac.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-1"
    },
    body: JSON.stringify(body)
  });
}

describe("API handlers", () => {
  beforeEach(() => {
    authMocks.getSession.mockReset();
    authMocks.getSession.mockResolvedValue({
      user: {
        id: "user-1",
        name: "测试用户",
        email: "user@example.com",
        banned: false
      }
    });
    notificationMocks.sendProblemReportNotification.mockReset();
    notificationMocks.sendProblemReportNotification.mockResolvedValue(true);
  });

  it("scopes conversation creation to the current user and passes audit context", async () => {
    const createConversation = vi.fn(
      async (userId: string, title: string, audit: AuditContext) => {
        void userId;
        void audit;
        return {
          id: "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
          title,
          summary: null,
          createdAt: new Date("2026-07-31T00:00:00.000Z"),
          updatedAt: new Date("2026-07-31T00:00:00.000Z")
        };
      }
    );
    const store = partialStore({ createConversation });

    const response = await handleCreateConversation(
      jsonRequest("/api/conversations", { title: "旋片泵选型" }),
      store
    );

    expect(response.status).toBe(201);
    expect(createConversation).toHaveBeenCalledWith(
      "user-1",
      "旋片泵选型",
      expect.objectContaining({
        requestId: "request-1",
        path: "/api/conversations",
        actor: expect.objectContaining({ id: "user-1", role: "user" })
      })
    );
  });

  it("routes an empty conversation-data clear through the auditable store path", async () => {
    const clearConversationData = vi.fn().mockResolvedValue({
      conversationsDeleted: 0,
      messagesDeleted: 0,
      candidateCitationsDeleted: 0
    });
    const store = partialStore({ clearConversationData });

    const response = await handleClearConversationData(
      jsonRequest("/api/account/conversation-data", {}, "DELETE"),
      store
    );

    expect(response.status).toBe(200);
    expect(clearConversationData).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        requestId: "request-1",
        path: "/api/account/conversation-data",
        method: "DELETE",
        actor: expect.objectContaining({ id: "user-1", role: "user" })
      })
    );
  });

  it("does not submit contact details without explicit contact consent", async () => {
    const createProblemReport = vi.fn();
    const store = partialStore({ createProblemReport });
    const response = await handleCreateProblemReport(
      jsonRequest("/api/problem-reports", {
        category: "system_error",
        description: "回答请求持续失败。",
        contactType: "phone",
        contactValue: "13800000000",
        consentToContact: false
      }),
      store
    );

    expect(response.status).toBe(422);
    expect(createProblemReport).not.toHaveBeenCalled();
  });

  it("does not infer contact details from the signed-in account", async () => {
    const createdAt = new Date("2026-08-01T00:00:00.000Z");
    const createProblemReport = vi.fn().mockResolvedValue({
      id: "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
      status: "new",
      createdAt
    });
    const store = partialStore({ createProblemReport });
    const response = await handleCreateProblemReport(
      jsonRequest("/api/problem-reports", {
        category: "product_suggestion",
        description: "希望增加按泵型筛选引用的能力。",
        context: { messages: ["客户端不应决定上下文快照"] }
      }),
      store
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      reportId: "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
      receivedAt: "2026-08-01T00:00:00.000Z"
    });
    expect(createProblemReport).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        includeContext: false,
        contactType: undefined,
        contactValue: undefined,
        consentToContact: false
      }),
      expect.objectContaining({
        requestId: "request-1",
        path: "/api/problem-reports",
        method: "POST",
        actor: expect.objectContaining({ id: "user-1", role: "user" })
      })
    );
    expect(createProblemReport.mock.calls[0]?.[1]).not.toHaveProperty(
      "context"
    );
    expect(
      notificationMocks.sendProblemReportNotification
    ).toHaveBeenCalledWith({
      id: "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
      category: "product_suggestion",
      createdAt
    });
    expect(
      notificationMocks.sendProblemReportNotification.mock.calls[0]?.[0]
    ).not.toHaveProperty("email");
  });

  it("keeps a saved problem report successful when notification mail fails", async () => {
    notificationMocks.sendProblemReportNotification.mockRejectedValueOnce(
      new Error("mail unavailable")
    );
    const createProblemReport = vi.fn().mockResolvedValue({
      id: "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
      status: "new",
      createdAt: new Date("2026-08-01T00:00:00.000Z")
    });
    const response = await handleCreateProblemReport(
      jsonRequest("/api/problem-reports", {
        category: "system_error",
        description: "回答请求持续失败。"
      }),
      partialStore({ createProblemReport })
    );

    expect(response.status).toBe(201);
    expect(createProblemReport).toHaveBeenCalledOnce();
  });

  it("lets support update problem-report status through an audited write", async () => {
    const setProblemReportStatus = vi.fn().mockResolvedValue({
      id: "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
      status: "reviewing"
    });
    const response = await handleSetProblemReportStatus(
      jsonRequest(
        "/api/admin/problem-reports/d607d4d6-82df-4f1b-a5d4-7d80277e327d",
        { status: "reviewing", note: "正在复核引用" },
        "PATCH"
      ),
      "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
      partialStore({
        getAdminRole: vi.fn().mockResolvedValue("support"),
        setProblemReportStatus
      })
    );

    expect(response.status).toBe(200);
    expect(setProblemReportStatus).toHaveBeenCalledWith(
      "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
      { status: "reviewing", note: "正在复核引用" },
      expect.objectContaining({
        path: "/api/admin/problem-reports/d607d4d6-82df-4f1b-a5d4-7d80277e327d",
        method: "PATCH",
        actor: expect.objectContaining({ role: "support" })
      })
    );
  });

  it("audits support access to the problem-report list", async () => {
    const listAdminProblemReports = vi.fn().mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0
    });
    const response = await handleListAdminProblemReports(
      new Request("https://openvac.test/api/admin/problem-reports?status=new", {
        headers: { "x-request-id": "request-1" }
      }),
      partialStore({
        getAdminRole: vi.fn().mockResolvedValue("support"),
        listAdminProblemReports
      })
    );

    expect(response.status).toBe(200);
    expect(listAdminProblemReports).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 20, status: "new" }),
      expect.objectContaining({
        path: "/api/admin/problem-reports",
        method: "GET",
        actor: expect.objectContaining({ role: "support" })
      })
    );
  });

  it("returns an ownership-safe 404 for feedback on another user's message", async () => {
    const store = partialStore({
      saveMessageFeedback: vi.fn().mockResolvedValue(null)
    });
    const response = await handleMessageFeedback(
      jsonRequest(
        "/api/messages/d607d4d6-82df-4f1b-a5d4-7d80277e327d/feedback",
        { rating: "helpful" }
      ),
      "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
      store
    );
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("rejects malformed resource identifiers before querying the store", async () => {
    const saveMessageFeedback = vi.fn();
    const store = partialStore({ saveMessageFeedback });
    const response = await handleMessageFeedback(
      jsonRequest("/api/messages/not-a-uuid/feedback", { rating: "helpful" }),
      "not-a-uuid",
      store
    );

    expect(response.status).toBe(422);
    expect(saveMessageFeedback).not.toHaveBeenCalled();
  });

  it("blocks analyst writes to model budgets", async () => {
    const updateBudgets = vi.fn();
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("analyst"),
      updateBudgets
    });
    const response = await handleUpdateBudgets(
      jsonRequest(
        "/api/admin/budgets",
        {
          budgets: [
            {
              model: "deepseek-v4-pro",
              dailyLimitCents: 1000,
              monthlyLimitCents: 20_000,
              enabled: true
            }
          ]
        },
        "PATCH"
      ),
      store
    );

    expect(response.status).toBe(403);
    expect(updateBudgets).not.toHaveBeenCalled();
  });

  it("passes the current role to the audit-log DTO boundary", async () => {
    const listAuditLogs = vi.fn().mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0
    });
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("analyst"),
      listAuditLogs
    });

    const response = await handleListAuditLogs(
      new Request("https://openvac.test/api/admin/audit?q=user-secret"),
      store
    );

    expect(response.status).toBe(200);
    expect(listAuditLogs).toHaveBeenCalledWith(
      {
        page: 1,
        pageSize: 20,
        query: "user-secret",
        status: undefined
      },
      "analyst"
    );
  });

  it("returns generic-table budget items as key and value records", async () => {
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("analyst"),
      getBudgets: vi.fn().mockResolvedValue([
        {
          model: "deepseek-v4-pro",
          dailyLimitCents: 1000,
          monthlyLimitCents: 20_000,
          enabled: true
        }
      ])
    });

    const response = await handleGetBudgets(
      new Request("https://openvac.test/api/admin/budgets"),
      store
    );
    const body = (await response.json()) as {
      data: { items: Array<Record<string, unknown>> };
    };

    expect(body.data.items).toEqual([
      {
        key: "deepseek-v4-pro",
        value: {
          dailyLimitCents: 1000,
          monthlyLimitCents: 20_000,
          enabled: true
        },
        updatedBy: null,
        updatedAt: null
      }
    ]);
  });

  it("takes the knowledge reviewer from the authenticated actor", async () => {
    const reviewKnowledgeDocument = vi.fn().mockResolvedValue({
      id: "d607d4d6-82df-4f1b-a5d4-7d80277e327d"
    });
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("knowledge_editor"),
      reviewKnowledgeDocument
    });
    const contentHash = "a".repeat(64);

    const response = await handleReviewKnowledgeDocument(
      jsonRequest(
        "/api/admin/knowledge/d607d4d6-82df-4f1b-a5d4-7d80277e327d/review",
        {
          versionId: "cb71f682-9bdc-4899-b7b3-c459402b192c",
          expectedContentHash: contentHash
        }
      ),
      "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
      store
    );

    expect(response.status).toBe(200);
    expect(reviewKnowledgeDocument).toHaveBeenCalledWith(
      "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
      {
        versionId: "cb71f682-9bdc-4899-b7b3-c459402b192c",
        expectedContentHash: contentHash,
        decision: "approved"
      },
      expect.objectContaining({
        actor: expect.objectContaining({
          id: "user-1",
          role: "knowledge_editor"
        })
      })
    );
  });

  it("archives knowledge through the authenticated audit context", async () => {
    const archiveKnowledgeDocument = vi.fn().mockResolvedValue({
      id: "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
      status: "archived"
    });
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("knowledge_editor"),
      archiveKnowledgeDocument
    });

    const response = await handleArchiveKnowledge(
      jsonRequest(
        "/api/admin/knowledge/d607d4d6-82df-4f1b-a5d4-7d80277e327d/archive",
        {}
      ),
      "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
      store
    );

    expect(response.status).toBe(200);
    expect(archiveKnowledgeDocument).toHaveBeenCalledWith(
      "d607d4d6-82df-4f1b-a5d4-7d80277e327d",
      expect.objectContaining({
        path: "/api/admin/knowledge/d607d4d6-82df-4f1b-a5d4-7d80277e327d/archive",
        actor: expect.objectContaining({
          id: "user-1",
          role: "knowledge_editor"
        })
      })
    );
  });

  it("lets admin search the read-only conversation index", async () => {
    const listAdminConversations = vi.fn().mockResolvedValue({
      items: [],
      page: 2,
      pageSize: 10,
      total: 0
    });
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("admin"),
      listAdminConversations
    });

    const response = await handleListAdminConversations(
      new Request(
        "https://openvac.test/api/admin/conversations?page=2&pageSize=10&q=旋片泵&status=active"
      ),
      store
    );

    expect(response.status).toBe(200);
    expect(listAdminConversations).toHaveBeenCalledWith({
      page: 2,
      pageSize: 10,
      query: "旋片泵",
      status: "active"
    });
  });

  it("lets admin read administrator role assignments", async () => {
    const listAdmins = vi.fn().mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0
    });
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("admin"),
      listAdmins
    });

    const response = await handleListAdmins(
      new Request("https://openvac.test/api/admin/admins?q=user@example.com"),
      store
    );

    expect(response.status).toBe(200);
    expect(listAdmins).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      query: "user@example.com",
      status: undefined
    });
  });

  it("blocks admin from granting administrator roles", async () => {
    const grantAdminRole = vi.fn();
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("admin"),
      grantAdminRole
    });

    const response = await handleGrantAdminRole(
      jsonRequest("/api/admin/admins", {
        userId: "user-2",
        role: "support"
      }),
      store
    );

    expect(response.status).toBe(403);
    expect(grantAdminRole).not.toHaveBeenCalled();
  });

  it("lets owner grant and revoke roles with audit context", async () => {
    const grantAdminRole = vi.fn().mockResolvedValue({
      userId: "user-2",
      role: "support"
    });
    const revokeAdminRole = vi.fn().mockResolvedValue({
      userId: "user-2",
      role: "support"
    });
    const store = partialStore({
      getAdminRole: vi.fn().mockResolvedValue("owner"),
      grantAdminRole,
      revokeAdminRole
    });

    const grantResponse = await handleGrantAdminRole(
      jsonRequest("/api/admin/admins", {
        userId: "user-2",
        role: "support"
      }),
      store
    );
    const revokeResponse = await handleRevokeAdminRole(
      jsonRequest(
        "/api/admin/admins",
        { userId: "user-2", role: "support" },
        "DELETE"
      ),
      store
    );

    expect(grantResponse.status).toBe(201);
    expect(revokeResponse.status).toBe(200);
    expect(grantAdminRole).toHaveBeenCalledWith(
      "user-2",
      "support",
      expect.objectContaining({
        requestId: "request-1",
        path: "/api/admin/admins",
        method: "POST",
        actor: expect.objectContaining({ id: "user-1", role: "owner" })
      })
    );
    expect(revokeAdminRole).toHaveBeenCalledWith(
      "user-2",
      "support",
      expect.objectContaining({
        requestId: "request-1",
        path: "/api/admin/admins",
        method: "DELETE",
        actor: expect.objectContaining({ id: "user-1", role: "owner" })
      })
    );
  });
});
