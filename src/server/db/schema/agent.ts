import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import { conversation, message } from "./chat";
import { quotaEntryStatus } from "./quota";

export const agentRunStatus = pgEnum("agent_run_status", [
  "pending",
  "running",
  "completed",
  "incomplete",
  "failed",
  "cancelled"
]);

export const agentRunAction = pgEnum("agent_run_action", [
  "initial",
  "retry",
  "regenerate",
  "continue"
]);

export const agentRequestedMode = pgEnum("agent_requested_mode", [
  "auto",
  "deep"
]);

export const agentResolvedMode = pgEnum("agent_resolved_mode", [
  "fast",
  "deep"
]);

export const agentWebMode = pgEnum("agent_web_mode", ["auto", "always"]);

export const agentToolStatus = pgEnum("agent_tool_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled"
]);

export const agentRunSettlementStatus = pgEnum("agent_run_settlement_status", [
  "pending",
  "completed"
]);

export const memoryStatus = pgEnum("memory_status", ["active", "disabled"]);

export const memoryKind = pgEnum("memory_kind", [
  "equipment",
  "operating_context",
  "unit_preference"
]);

export const webTrustTier = pgEnum("web_trust_tier", [
  "tier_a",
  "tier_b",
  "tier_c",
  "blocked"
]);

export const conversationTurn = pgTable(
  "conversation_turn",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    userMessageId: uuid("user_message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    selectedRunId: uuid("selected_run_id"),
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
    uniqueIndex("conversation_turn_conversation_ordinal_unique").on(
      table.conversationId,
      table.ordinal
    ),
    uniqueIndex("conversation_turn_user_message_unique").on(
      table.userMessageId
    ),
    index("conversation_turn_selected_run_idx").on(table.selectedRunId)
  ]
);

export const agentRun = pgTable(
  "agent_run",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => conversationTurn.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    assistantMessageId: uuid("assistant_message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    clientRequestId: text("client_request_id").notNull(),
    version: integer("version").notNull(),
    action: agentRunAction("action").default("initial").notNull(),
    protocol: text("protocol").default("responses").notNull(),
    model: text("model").notNull(),
    requestedMode: agentRequestedMode("requested_mode")
      .default("auto")
      .notNull(),
    resolvedMode: agentResolvedMode("resolved_mode").default("fast").notNull(),
    webMode: agentWebMode("web_mode").default("auto").notNull(),
    status: agentRunStatus("status").default("pending").notNull(),
    answerQuotaLeaseId: uuid("answer_quota_lease_id"),
    answerQuotaStatus: quotaEntryStatus("answer_quota_status"),
    settlementStatus: agentRunSettlementStatus("settlement_status")
      .default("pending")
      .notNull(),
    riskLevel: text("risk_level").default("low").notNull(),
    answerPayload: jsonb("answer_payload").$type<Record<string, unknown>>(),
    contextMetadata: jsonb("context_metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    toolRoundCount: integer("tool_round_count").default(0).notNull(),
    toolCallCount: integer("tool_call_count").default(0).notNull(),
    modelRequestCount: integer("model_request_count").default(0).notNull(),
    retryCount: integer("retry_count").default(0).notNull(),
    repairCount: integer("repair_count").default(0).notNull(),
    cancelRequestedAt: timestamp("cancel_requested_at", {
      mode: "date",
      withTimezone: true
    }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", {
      mode: "date",
      withTimezone: true
    }),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true
    }),
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
    uniqueIndex("agent_run_user_client_request_unique").on(
      table.userId,
      table.clientRequestId
    ),
    uniqueIndex("agent_run_turn_version_unique").on(
      table.turnId,
      table.version
    ),
    index("agent_run_turn_status_idx").on(table.turnId, table.status),
    index("agent_run_user_created_idx").on(table.userId, table.createdAt),
    uniqueIndex("agent_run_answer_quota_lease_unique")
      .on(table.answerQuotaLeaseId)
      .where(sql`${table.answerQuotaLeaseId} is not null`),
    index("agent_run_settlement_recovery_idx").on(
      table.settlementStatus,
      table.status,
      table.updatedAt
    ),
    check("agent_run_version_positive", sql`${table.version} > 0`),
    check(
      "agent_run_answer_quota_shape_valid",
      sql`(${table.answerQuotaLeaseId} is null and ${table.answerQuotaStatus} is null) or (${table.answerQuotaLeaseId} is not null and ${table.answerQuotaStatus} is not null)`
    ),
    check(
      "agent_run_tool_round_count_non_negative",
      sql`${table.toolRoundCount} >= 0`
    ),
    check(
      "agent_run_tool_call_count_non_negative",
      sql`${table.toolCallCount} >= 0`
    ),
    check(
      "agent_run_model_request_count_non_negative",
      sql`${table.modelRequestCount} >= 0`
    )
  ]
);

export const agentToolCall = pgTable(
  "agent_tool_call",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRun.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    sequence: integer("sequence").notNull(),
    providerCallId: text("provider_call_id"),
    toolName: text("tool_name").notNull(),
    argumentsDigest: text("arguments_digest").notNull(),
    resultDigest: text("result_digest"),
    sanitizedPreview: jsonb("sanitized_preview")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    citationIds: text("citation_ids").array().default([]).notNull(),
    status: agentToolStatus("status").default("pending").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    latencyMs: integer("latency_ms"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", {
      mode: "date",
      withTimezone: true
    }),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true
    }),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true
    })
      .notNull()
      .$defaultFn(() => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .notNull()
  },
  (table) => [
    uniqueIndex("agent_tool_call_run_sequence_unique").on(
      table.runId,
      table.sequence
    ),
    uniqueIndex("agent_tool_call_idempotency_unique").on(table.idempotencyKey),
    index("agent_tool_call_expiry_idx").on(table.expiresAt),
    check("agent_tool_call_round_positive", sql`${table.round} > 0`),
    check("agent_tool_call_sequence_positive", sql`${table.sequence} > 0`)
  ]
);

export const conversationMemory = pgTable("conversation_memory", {
  conversationId: uuid("conversation_id")
    .primaryKey()
    .references(() => conversation.id, { onDelete: "cascade" }),
  version: integer("version").default(1).notNull(),
  summary: text("summary").default("").notNull(),
  confirmedFacts: jsonb("confirmed_facts")
    .$type<Array<Record<string, unknown>>>()
    .default([])
    .notNull(),
  unresolvedQuestions: text("unresolved_questions")
    .array()
    .default([])
    .notNull(),
  throughSequence: integer("through_sequence").default(0).notNull(),
  sourceMessageIds: uuid("source_message_ids").array().default([]).notNull(),
  contentHash: text("content_hash").notNull(),
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
});

export const userMemory = pgTable(
  "user_memory",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: memoryKind("kind").notNull(),
    label: text("label").notNull(),
    facts: jsonb("facts").$type<Record<string, unknown>>().notNull(),
    sourceMessageIds: uuid("source_message_ids").array().default([]).notNull(),
    status: memoryStatus("status").default("active").notNull(),
    lastUsedAt: timestamp("last_used_at", {
      mode: "date",
      withTimezone: true
    }),
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
    index("user_memory_user_status_idx").on(table.userId, table.status),
    check(
      "user_memory_label_length",
      sql`char_length(${table.label}) between 1 and 120`
    )
  ]
);

export const webDomainPolicy = pgTable("web_domain_policy", {
  domain: text("domain").primaryKey(),
  trustTier: webTrustTier("trust_tier").default("tier_c").notNull(),
  licenseClass: text("license_class").default("unknown").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  reviewedByUserId: text("reviewed_by_user_id").references(() => user.id, {
    onDelete: "set null"
  }),
  reviewedAt: timestamp("reviewed_at", {
    mode: "date",
    withTimezone: true
  }),
  metadata: jsonb("metadata")
    .$type<Record<string, unknown>>()
    .default({})
    .notNull(),
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
});

export const conversationTurnRelations = relations(
  conversationTurn,
  ({ one, many }) => ({
    conversation: one(conversation, {
      fields: [conversationTurn.conversationId],
      references: [conversation.id]
    }),
    userMessage: one(message, {
      fields: [conversationTurn.userMessageId],
      references: [message.id]
    }),
    runs: many(agentRun)
  })
);

export const agentRunRelations = relations(agentRun, ({ one, many }) => ({
  turn: one(conversationTurn, {
    fields: [agentRun.turnId],
    references: [conversationTurn.id]
  }),
  assistantMessage: one(message, {
    fields: [agentRun.assistantMessageId],
    references: [message.id]
  }),
  toolCalls: many(agentToolCall)
}));

export const agentToolCallRelations = relations(agentToolCall, ({ one }) => ({
  run: one(agentRun, {
    fields: [agentToolCall.runId],
    references: [agentRun.id]
  })
}));

export const conversationTurns = conversationTurn;
export const agentRuns = agentRun;
export const agentToolCalls = agentToolCall;
export const conversationMemories = conversationMemory;
export const userMemories = userMemory;
export const webDomainPolicies = webDomainPolicy;
