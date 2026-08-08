import { describe, expect, it, vi } from "vitest";

import {
  handleChangeAccountEmail,
  handleGetAccountProfile,
  handleUpdateAccountProfile,
  type AccountEmailAuthApi
} from "./account-profile";
import type { ApiStore } from "./types";

const user = {
  id: "user-1",
  email: "old@example.test",
  emailVerified: true,
  name: "Old Name",
  banned: false,
  roleHint: null
};

function profileStore() {
  return {
    getAccountProfile: vi.fn(async () => ({
      id: "user-1",
      name: "Old Name",
      email: "old@example.test",
      emailVerified: true,
      image: null,
      avatarRevision: 0,
      twoFactorEnabled: false
    })),
    updateAccountProfileName: vi.fn(async (_userId, name) => ({
      id: "user-1",
      name,
      email: "old@example.test",
      emailVerified: true,
      image: null,
      avatarRevision: 0,
      twoFactorEnabled: false
    }))
  } as unknown as ApiStore;
}

describe("account profile handlers", () => {
  it("returns the authenticated account profile", async () => {
    const store = profileStore();
    const response = await handleGetAccountProfile(
      new Request("https://openvac.test/api/account/profile"),
      store,
      vi.fn(async () => user)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        id: "user-1",
        name: "Old Name",
        email: "old@example.test",
        emailVerified: true,
        image: null,
        avatarRevision: 0,
        twoFactorEnabled: false
      }
    });
    expect(store.getAccountProfile).toHaveBeenCalledWith("user-1");
  });

  it("trims and audits a name-only update", async () => {
    const store = profileStore();
    const response = await handleUpdateAccountProfile(
      new Request("https://openvac.test/api/account/profile", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-request-id": "request-1"
        },
        body: JSON.stringify({ name: "  New Name  " })
      }),
      store,
      vi.fn(async () => user)
    );

    expect(response.status).toBe(200);
    expect(store.updateAccountProfileName).toHaveBeenCalledWith(
      "user-1",
      "New Name",
      expect.objectContaining({
        requestId: "request-1",
        path: "/api/account/profile",
        method: "PATCH"
      })
    );
  });

  it.each([
    { name: "   " },
    { name: "x".repeat(81) },
    { name: "Valid", email: "not-allowed@example.test" }
  ])("rejects an invalid or non-name patch: %o", async (body) => {
    const store = profileStore();
    const response = await handleUpdateAccountProfile(
      new Request("https://openvac.test/api/account/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }),
      store,
      vi.fn(async () => user)
    );

    expect(response.status).toBe(422);
    expect(store.updateAccountProfileName).not.toHaveBeenCalled();
  });
});

describe("account email change handler", () => {
  it("verifies the password before starting Better Auth's email flow and revoking other sessions", async () => {
    const calls: string[] = [];
    const authApi: AccountEmailAuthApi = {
      verifyPassword: vi.fn(async () => {
        calls.push("verifyPassword");
        return { status: true };
      }),
      changeEmail: vi.fn(async () => {
        calls.push("changeEmail");
        return { status: true };
      }),
      revokeOtherSessions: vi.fn(async () => {
        calls.push("revokeOtherSessions");
        return { status: true };
      })
    };
    const request = new Request(
      "https://openvac.test/api/account/profile/email",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "session=x" },
        body: JSON.stringify({
          currentPassword: "current-password",
          newEmail: "NEW@example.test"
        })
      }
    );

    const response = await handleChangeAccountEmail(request, authApi);

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "verifyPassword",
      "changeEmail",
      "revokeOtherSessions"
    ]);
    expect(authApi.verifyPassword).toHaveBeenCalledWith({
      body: { password: "current-password" },
      headers: request.headers
    });
    expect(authApi.changeEmail).toHaveBeenCalledWith({
      body: { newEmail: "new@example.test", callbackURL: "/settings" },
      headers: request.headers
    });
    expect(authApi.revokeOtherSessions).toHaveBeenCalledWith({
      headers: request.headers
    });
  });

  it("does not start the email flow when password verification fails", async () => {
    const authApi: AccountEmailAuthApi = {
      verifyPassword: vi.fn(async () => {
        throw new Error("invalid password");
      }),
      changeEmail: vi.fn(),
      revokeOtherSessions: vi.fn()
    };
    const response = await handleChangeAccountEmail(
      new Request("https://openvac.test/api/account/profile/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: "wrong-password",
          newEmail: "new@example.test"
        })
      }),
      authApi
    );

    expect(response.status).toBe(400);
    expect(authApi.changeEmail).not.toHaveBeenCalled();
    expect(authApi.revokeOtherSessions).not.toHaveBeenCalled();
  });
});
