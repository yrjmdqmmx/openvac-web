import { describe, expect, it, vi } from "vitest";

import { ApiError } from "./errors";
import {
  handleExportAccountData,
  type AccountExportRepository,
  type AccountExportSnapshot
} from "./account-export";

const authenticatedUser = {
  id: "user-1",
  sessionId: "session-current",
  email: "user@example.test",
  emailVerified: true,
  name: "OpenVac User",
  image: null,
  banned: false,
  roleHint: null
};

describe("account data export", () => {
  it("rejects unauthenticated requests before reading any data", async () => {
    const repository = makeRepository();
    const response = await handleExportAccountData(
      new Request("https://openvac.test/api/account/export"),
      repository,
      vi.fn(async () => {
        throw new ApiError(401, "UNAUTHENTICATED", "请先登录。");
      })
    );

    expect(response.status).toBe(401);
    expect(repository.collectOwned).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("ignores attempted user-id overrides and exports only the authenticated owner", async () => {
    const repository = makeRepository();
    const response = await handleExportAccountData(
      new Request(
        "https://openvac.test/api/account/export?userId=another-user"
      ),
      repository,
      vi.fn(async () => authenticatedUser),
      () => new Date("2026-08-08T02:30:00.000Z")
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(repository.collectOwned).toHaveBeenCalledOnce();
    expect(repository.collectOwned).toHaveBeenCalledWith("user-1");
    expect(payload).toMatchObject({
      exportVersion: 2,
      generatedAt: "2026-08-08T02:30:00.000Z",
      account: { id: "user-1", email: "user@example.test" }
    });
    expect(JSON.stringify(payload)).not.toContain("another-user");
  });

  it("returns a no-store JSON attachment and strips session tokens and internal notes", async () => {
    const repository = makeRepository();
    const response = await handleExportAccountData(
      new Request("https://openvac.test/api/account/export"),
      repository,
      vi.fn(async () => authenticatedUser),
      () => new Date("2026-08-08T02:30:00.000Z")
    );
    const payload = (await response.json()) as {
      sessions: Array<Record<string, unknown>>;
      feedback: Array<Record<string, unknown>>;
      problemReports: Array<Record<string, unknown>>;
      attachments: Array<Record<string, unknown>>;
      artifactFiles: Array<Record<string, unknown>>;
    };

    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8"
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="openvac-account-export-2026-08-08.json"'
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(payload.sessions[0]).toMatchObject({
      id: "session-current",
      isCurrent: true,
      userAgent: "Test Browser"
    });
    expect(payload.sessions[0]).not.toHaveProperty("token");
    expect(payload.feedback[0]).not.toHaveProperty("adminNote");
    expect(payload.problemReports[0]).not.toHaveProperty("adminNote");
    expect(payload.attachments[0]).not.toHaveProperty("objectKey");
    expect(payload.attachments[0]).not.toHaveProperty("signedUrl");
    expect(payload.artifactFiles[0]).not.toHaveProperty("objectKey");
    expect(payload.artifactFiles[0]).not.toHaveProperty("signedUrl");
    expect(JSON.stringify(payload)).not.toContain("secret-session-token");
    expect(JSON.stringify(payload)).not.toContain("internal-only-note");
  });
});

function makeRepository() {
  const snapshot = {
    account: {
      id: "user-1",
      name: "OpenVac User",
      email: "user@example.test",
      emailVerified: true,
      image: null,
      banned: false,
      banExpires: null,
      deletionRequestedAt: null,
      dailyQuotaBonus: 0,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z")
    },
    sessions: [
      {
        id: "session-current",
        userAgent: "Test Browser",
        ipAddress: "127.0.0.1",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
        expiresAt: new Date("2026-09-01T00:00:00.000Z"),
        token: "secret-session-token"
      }
    ],
    conversations: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        title: "Vacuum question",
        summary: null,
        status: "active" as const,
        model: "test-model",
        lastMessageAt: new Date("2026-08-02T00:00:00.000Z"),
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
        deletedAt: null
      }
    ],
    messages: [
      {
        id: "00000000-0000-4000-8000-000000000002",
        conversationId: "00000000-0000-4000-8000-000000000001",
        sequence: 1,
        role: "user" as const,
        status: "completed" as const,
        content: "How do I size a pump?",
        model: null,
        answerPayload: null,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        completedAt: new Date("2026-08-01T00:00:01.000Z")
      }
    ],
    conversationMemories: [],
    userMemories: [],
    feedback: [
      {
        id: "00000000-0000-4000-8000-000000000003",
        messageId: "00000000-0000-4000-8000-000000000002",
        kind: "feedback" as const,
        rating: "helpful" as const,
        reason: null,
        comment: "Useful",
        category: null,
        details: null,
        status: "resolved",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
        adminNote: "internal-only-note"
      }
    ],
    problemReports: [
      {
        id: "00000000-0000-4000-8000-000000000004",
        conversationId: null,
        messageId: null,
        category: "product_suggestion",
        description: "Add export",
        includeContext: false,
        context: {},
        contactType: null,
        contactValue: null,
        consentToContact: false,
        status: "new",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
        closedAt: null,
        adminNote: "internal-only-note"
      }
    ],
    attachments: [
      {
        id: "00000000-0000-4000-8000-000000000005",
        conversationId: "00000000-0000-4000-8000-000000000001",
        messageId: "00000000-0000-4000-8000-000000000002",
        kind: "document" as const,
        originalFilename: "manual.pdf",
        mimeType: "application/pdf",
        declaredSizeBytes: 123,
        sizeBytes: 123,
        sha256: "a".repeat(64),
        status: "ready" as const,
        parseStatus: "ready" as const,
        failureCode: null,
        failureMessage: null,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
        readyAt: new Date("2026-08-02T00:00:00.000Z"),
        objectKey: "private/chat-attachments/secret-object",
        signedUrl: "https://oss.test/permanent-secret"
      }
    ],
    artifacts: [
      {
        id: "00000000-0000-4000-8000-000000000006",
        conversationId: "00000000-0000-4000-8000-000000000001",
        messageId: "00000000-0000-4000-8000-000000000002",
        sourceTurnId: "00000000-0000-4000-8000-000000000007",
        kind: "diagnosis_report" as const,
        title: "Diagnosis",
        status: "ready" as const,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
        readyAt: new Date("2026-08-02T00:00:00.000Z"),
        deletedAt: null
      }
    ],
    artifactFiles: [
      {
        id: "00000000-0000-4000-8000-000000000008",
        artifactId: "00000000-0000-4000-8000-000000000006",
        format: "pdf" as const,
        filename: "diagnosis.pdf",
        mimeType: "application/pdf",
        sizeBytes: 456,
        sha256: "b".repeat(64),
        quotaState: "committed" as const,
        deletionStatus: "active" as const,
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
        deletedAt: null,
        objectKey: "private/chat-artifacts/secret-object",
        signedUrl: "https://oss.test/permanent-artifact-secret"
      }
    ]
  } as unknown as AccountExportSnapshot;

  return {
    collectOwned: vi.fn(async () => snapshot)
  } satisfies AccountExportRepository;
}
