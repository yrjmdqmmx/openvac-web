import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";

import { db } from "@/server/db";
import * as schema from "@/server/db/schema";

import {
  AdminAccountDeletionForbiddenError,
  cleanupDeletedUser,
  prepareUserDeletion
} from "./account-cleanup";
import { sendAuthEmail } from "./email";

function trustedOrigins() {
  return (process.env.AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export const auth = betterAuth({
  appName: "OpenVac",
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: trustedOrigins(),
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    transaction: true
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user: authUser, url }) => {
      await sendAuthEmail({
        kind: "reset-password",
        to: authUser.email,
        url
      });
    },
    customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
      ...coreFields,
      banned: false,
      banReason: null,
      banExpires: null,
      dailyQuotaBonus: 0,
      ...additionalFields,
      id
    })
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user: authUser, url }) => {
      await sendAuthEmail({
        kind: "verify-email",
        to: authUser.email,
        url
      });
    }
  },
  user: {
    additionalFields: {
      banned: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false
      },
      banReason: {
        type: "string",
        required: false,
        input: false
      },
      banExpires: {
        type: "date",
        required: false,
        input: false
      },
      dailyQuotaBonus: {
        type: "number",
        required: false,
        defaultValue: 0,
        input: false
      }
    },
    deleteUser: {
      enabled: true,
      sendDeleteAccountVerification: async ({ user: authUser, url }) => {
        await sendAuthEmail({
          kind: "delete-account",
          to: authUser.email,
          url
        });
      },
      beforeDelete: async (deletedUser) => {
        try {
          await prepareUserDeletion(deletedUser.id);
        } catch (error) {
          if (error instanceof AdminAccountDeletionForbiddenError) {
            throw APIError.from("CONFLICT", {
              code: error.code,
              message: "管理员账号需先移交并撤销全部管理员角色。"
            });
          }
          throw error;
        }
      },
      afterDelete: async (deletedUser) => {
        await cleanupDeletedUser(deletedUser.id);
      }
    }
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 60, max: 3 },
      "/send-verification-email": { window: 60, max: 3 },
      "/delete-user": { window: 60, max: 3 }
    }
  }
});
