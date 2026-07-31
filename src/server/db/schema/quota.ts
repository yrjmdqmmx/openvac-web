import { relations, sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

import { user } from "./auth";

export const quotaResource = pgEnum("quota_resource", ["answer", "web_search"]);

export const quotaScope = pgEnum("quota_scope", ["user", "global"]);

export const quotaEntryStatus = pgEnum("quota_entry_status", [
  "reserved",
  "committed",
  "released"
]);

export const quotaBucket = pgTable(
  "quota_bucket",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    resource: quotaResource("resource").notNull(),
    scopeType: quotaScope("scope_type").notNull(),
    scopeKey: text("scope_key").notNull(),
    windowKey: date("window_key", { mode: "string" }).notNull(),
    limitValue: integer("limit_value").notNull(),
    reservedUnits: integer("reserved_units").default(0).notNull(),
    committedUnits: integer("committed_units").default(0).notNull(),
    resetAt: timestamp("reset_at", {
      mode: "date",
      withTimezone: true
    }).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  (table) => [
    uniqueIndex("quota_bucket_scope_window_unique").on(
      table.resource,
      table.scopeType,
      table.scopeKey,
      table.windowKey
    ),
    index("quota_bucket_reset_at_idx").on(table.resetAt),
    check("quota_bucket_limit_positive", sql`${table.limitValue} > 0`),
    check(
      "quota_bucket_counts_non_negative",
      sql`${table.reservedUnits} >= 0 and ${table.committedUnits} >= 0`
    ),
    check(
      "quota_bucket_within_limit",
      sql`${table.reservedUnits} + ${table.committedUnits} <= ${table.limitValue}`
    )
  ]
);

export const quotaLedger = pgTable(
  "quota_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    leaseId: uuid("lease_id").notNull(),
    bucketId: uuid("bucket_id")
      .notNull()
      .references(() => quotaBucket.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientRequestId: text("client_request_id").notNull(),
    resource: quotaResource("resource").notNull(),
    scopeType: quotaScope("scope_type").notNull(),
    scopeKey: text("scope_key").notNull(),
    windowKey: date("window_key", { mode: "string" }).notNull(),
    units: integer("units").default(1).notNull(),
    status: quotaEntryStatus("status").default("reserved").notNull(),
    releaseReason: text("release_reason"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    reservedAt: timestamp("reserved_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .notNull(),
    committedAt: timestamp("committed_at", {
      mode: "date",
      withTimezone: true
    }),
    releasedAt: timestamp("released_at", {
      mode: "date",
      withTimezone: true
    }),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  (table) => [
    uniqueIndex("quota_ledger_idempotency_unique").on(
      table.actorUserId,
      table.resource,
      table.clientRequestId,
      table.scopeType,
      table.scopeKey
    ),
    index("quota_ledger_lease_idx").on(table.leaseId),
    index("quota_ledger_actor_window_idx").on(
      table.actorUserId,
      table.resource,
      table.windowKey
    ),
    index("quota_ledger_status_idx").on(table.status),
    check("quota_ledger_units_positive", sql`${table.units} > 0`)
  ]
);

export const quotaBucketRelations = relations(quotaBucket, ({ many }) => ({
  entries: many(quotaLedger)
}));

export const quotaLedgerRelations = relations(quotaLedger, ({ one }) => ({
  bucket: one(quotaBucket, {
    fields: [quotaLedger.bucketId],
    references: [quotaBucket.id]
  }),
  actor: one(user, {
    fields: [quotaLedger.actorUserId],
    references: [user.id]
  })
}));
