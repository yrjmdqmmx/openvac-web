import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";

const authTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    banned: boolean("banned").default(false).notNull(),
    banReason: text("ban_reason"),
    banExpires: authTimestamp("ban_expires"),
    deletionRequestedAt: authTimestamp("deletion_requested_at"),
    dailyQuotaBonus: integer("daily_quota_bonus").default(0).notNull(),
    createdAt: authTimestamp("created_at").defaultNow().notNull(),
    updatedAt: authTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  (table) => [
    check(
      "user_daily_quota_bonus_non_negative",
      sql`${table.dailyQuotaBonus} >= 0`
    )
  ]
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: authTimestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: authTimestamp("created_at").defaultNow().notNull(),
    updatedAt: authTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" })
  },
  (table) => [index("session_user_id_idx").on(table.userId)]
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: authTimestamp("access_token_expires_at"),
    refreshTokenExpiresAt: authTimestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: authTimestamp("created_at").defaultNow().notNull(),
    updatedAt: authTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    uniqueIndex("account_provider_account_unique").on(
      table.providerId,
      table.accountId
    )
  ]
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: authTimestamp("expires_at").notNull(),
    createdAt: authTimestamp("created_at").defaultNow().notNull(),
    updatedAt: authTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  (table) => [
    index("verification_identifier_idx").on(table.identifier),
    index("verification_expires_at_idx").on(table.expiresAt)
  ]
);

export const rateLimit = pgTable(
  "rate_limit",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    count: integer("count").default(0).notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull()
  },
  (table) => [
    uniqueIndex("rate_limit_key_unique").on(table.key),
    index("rate_limit_last_request_idx").on(table.lastRequest),
    check("rate_limit_count_non_negative", sql`${table.count} >= 0`)
  ]
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account)
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id]
  })
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id]
  })
}));

export const betterAuthSchema = {
  user,
  session,
  account,
  verification,
  rateLimit,
  userRelations,
  sessionRelations,
  accountRelations
};
