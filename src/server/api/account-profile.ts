import { z } from "zod";

import { auth } from "@/server/auth";

import { asUserActor, authenticate, auditContext } from "./auth";
import {
  ApiError,
  jsonData,
  notFound,
  parseJson,
  withApiErrors
} from "./errors";
import { apiStore } from "./store";
import type { ApiStore, AuthenticatedUser } from "./types";

const profilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80)
  })
  .strict();

const emailChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newEmail: z.email().transform((value) => value.trim().toLowerCase())
  })
  .strict();

type AuthenticateRequest = (request: Request) => Promise<AuthenticatedUser>;

export type AccountEmailAuthApi = {
  verifyPassword(input: {
    body: { password: string };
    headers: Headers;
  }): Promise<unknown>;
  changeEmail(input: {
    body: { newEmail: string; callbackURL: string };
    headers: Headers;
  }): Promise<unknown>;
  revokeOtherSessions(input: { headers: Headers }): Promise<unknown>;
};

export const handleGetAccountProfile = withApiErrors(
  async (
    request: Request,
    store: ApiStore = apiStore,
    authenticateRequest: AuthenticateRequest = authenticate
  ) => {
    const user = await authenticateRequest(request);
    const profile = await store.getAccountProfile(user.id);
    if (!profile) throw notFound("账户资料");
    return jsonData(profile);
  }
);

export const handleUpdateAccountProfile = withApiErrors(
  async (
    request: Request,
    store: ApiStore = apiStore,
    authenticateRequest: AuthenticateRequest = authenticate
  ) => {
    const input = await parseJson(request, profilePatchSchema);
    const user = await authenticateRequest(request);
    const profile = await store.updateAccountProfileName(
      user.id,
      input.name,
      auditContext(request, asUserActor(user))
    );
    if (!profile) throw notFound("账户资料");
    return jsonData(profile);
  }
);

export const handleChangeAccountEmail = withApiErrors(
  async (request: Request, authApi: AccountEmailAuthApi = auth.api) => {
    const input = await parseJson(request, emailChangeSchema);
    try {
      await authApi.verifyPassword({
        body: { password: input.currentPassword },
        headers: request.headers
      });
    } catch {
      throw new ApiError(400, "INVALID_PASSWORD", "当前密码不正确。");
    }

    await authApi.changeEmail({
      body: { newEmail: input.newEmail, callbackURL: "/settings" },
      headers: request.headers
    });

    // Better Auth completes email changes through two verification callbacks.
    // Revoke other sessions at the earliest unambiguous point: immediately
    // after the authenticated change request has been accepted.
    await authApi.revokeOtherSessions({ headers: request.headers });

    return jsonData({
      confirmationRequired: true,
      otherSessionsRevoked: true
    });
  }
);
