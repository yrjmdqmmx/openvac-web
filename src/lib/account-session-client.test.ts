import { describe, expect, it, vi } from "vitest";
import {
  deleteAccountSession,
  parseAccountSessionSummaries,
  SessionManagementUnavailableError
} from "@/lib/account-session-client";

describe("account session client", () => {
  it("maps session data without retaining bearer tokens", () => {
    const sessions = parseAccountSessionSummaries([
      {
        id: "session-1",
        token: "must-not-enter-react-state",
        userAgent: "Browser",
        ipAddress: "127.0.0.1",
        createdAt: "2026-07-31T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-08-07T00:00:00.000Z",
        isCurrent: true
      }
    ]);

    expect(sessions).toEqual([
      {
        id: "session-1",
        userAgent: "Browser",
        ipAddress: "127.0.0.1",
        createdAt: "2026-07-31T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-08-07T00:00:00.000Z",
        isCurrent: true
      }
    ]);
    expect(sessions[0]).not.toHaveProperty("token");
  });

  it("deletes by encoded opaque session id", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

    await deleteAccountSession("session/id", fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/sessions/session%2Fid",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it.each([404, 405, 501])(
    "reports status %i as a not-yet-available endpoint",
    async (status) => {
      const fetchMock = vi.fn(async () => new Response(null, { status }));

      await expect(
        deleteAccountSession("session-1", fetchMock)
      ).rejects.toBeInstanceOf(SessionManagementUnavailableError);
    }
  );
});
