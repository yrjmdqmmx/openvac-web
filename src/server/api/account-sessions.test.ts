import { describe, expect, it, vi } from "vitest";

import {
  handleListAccountSessions,
  handleRevokeAccountSession,
  type AccountSessionRepository
} from "./account-sessions";

const user = {
  id: "user-1",
  email: "user@example.test",
  name: "User",
  banned: false,
  roleHint: null
};

describe("account session handlers", () => {
  it("returns only non-secret session summaries", async () => {
    const repository = makeRepository();
    const response = await handleListAccountSessions(
      new Request("https://openvac.example/api/account/sessions"),
      repository,
      vi.fn(async () => user)
    );
    const payload = (await response.json()) as {
      data: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(payload.data[0]).toMatchObject({
      id: "session-1",
      userAgent: "Browser"
    });
    expect(payload.data[0]).not.toHaveProperty("token");
  });

  it("revokes only through the authenticated user's ownership filter", async () => {
    const repository = makeRepository();
    const response = await handleRevokeAccountSession(
      new Request("https://openvac.example/api/account/sessions/session-1", {
        method: "DELETE"
      }),
      "session-1",
      repository,
      vi.fn(async () => user)
    );

    expect(response.status).toBe(200);
    expect(repository.revokeOwned).toHaveBeenCalledWith("user-1", "session-1");
  });

  it("rejects malformed and inaccessible session identifiers", async () => {
    const repository = makeRepository(false);
    const authenticate = vi.fn(async () => user);

    const malformed = await handleRevokeAccountSession(
      new Request("https://openvac.example/api/account/sessions/bad", {
        method: "DELETE"
      }),
      "../bad",
      repository,
      authenticate
    );
    expect(malformed.status).toBe(422);
    expect(authenticate).not.toHaveBeenCalled();

    const missing = await handleRevokeAccountSession(
      new Request("https://openvac.example/api/account/sessions/session-2", {
        method: "DELETE"
      }),
      "session-2",
      repository,
      authenticate
    );
    expect(missing.status).toBe(404);
  });
});

function makeRepository(revoked = true) {
  return {
    listOwned: vi.fn(async () => [
      {
        id: "session-1",
        userAgent: "Browser",
        ipAddress: null,
        createdAt: new Date("2026-07-31T00:00:00.000Z"),
        expiresAt: new Date("2026-08-07T00:00:00.000Z"),
        token: "must-never-reach-browser"
      }
    ]),
    revokeOwned: vi.fn(async () => revoked)
  } satisfies AccountSessionRepository;
}
