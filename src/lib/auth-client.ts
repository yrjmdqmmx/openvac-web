"use client";

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export const {
  changePassword,
  deleteUser,
  getSession,
  requestPasswordReset,
  resetPassword,
  revokeOtherSessions,
  revokeSession,
  revokeSessions,
  sendVerificationEmail,
  signIn,
  signOut,
  signUp,
  useSession,
  verifyEmail
} = authClient;
