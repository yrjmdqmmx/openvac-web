import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import { conversation, message } from "./chat";

export const invocationPurpose = pgEnum("invocation_purpose", [
  "answer",
  "embedding",
  "ocr",
  "web_search",
  "evaluation"
]);

export const operationStatus = pgEnum("operation_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled"
]);

export const adminRoleName = pgEnum("admin_role_name", [
  "owner",
  "admin",
  "knowledge_editor",
  "support",
  "analyst"
]);

export const modelInvocation = pgTable(
  "model_invocation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").references(() => user.id, {
      onDelete: "cascade"
    }),
    conversationId: uuid("conversation_id").references(() => conversation.id, {
      onDelete: "set null"
    }),
    messageId: uuid("message_id").references(() => message.id, {
      onDelete: "set null"
    }),
    clientRequestId: text("client_request_id"),
    purpose: invocationPurpose("purpose").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    providerRequestId: text("provider_request_id"),
    status: operationStatus("status").default("running").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    costMicros: bigint("cost_micros", { mode: "number" }),
    latencyMs: integer("latency_ms"),
    requestMetadata: jsonb("request_metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    responseMetadata: jsonb("response_metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true
    })
  },
  (table) => [
    uniqueIndex("model_invocation_provider_request_unique").on(
      table.provider,
      table.providerRequestId
    ),
    index("model_invocation_user_started_idx").on(
      table.userId,
      table.startedAt
    ),
    index("model_invocation_status_started_idx").on(
      table.status,
      table.startedAt
    ),
    index("model_invocation_client_request_idx").on(table.clientRequestId)
  ]
);

export const dailyUsage = pgTable(
  "daily_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    date: timestamp("date", { mode: "date", withTimezone: true }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    requestCount: integer("request_count").default(0).notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    costCents: integer("cost_cents").default(0).notNull(),
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
    uniqueIndex("daily_usage_date_provider_model_unique").on(
      table.date,
      table.provider,
      table.model
    ),
    index("daily_usage_date_idx").on(table.date)
  ]
);

export const promptTemplate = pgTable("prompt_template", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
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

export const promptVersion = pgTable(
  "prompt_version",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => promptTemplate.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    variables: jsonb("variables").$type<string[]>().default([]).notNull(),
    modelSettings: jsonb("model_settings")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    isActive: boolean("is_active").default(false).notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .notNull()
  },
  (table) => [
    uniqueIndex("prompt_version_template_version_unique").on(
      table.templateId,
      table.version
    ),
    uniqueIndex("prompt_version_single_active_unique")
      .on(table.templateId)
      .where(sql`${table.isActive} = true`)
  ]
);

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    notes: text("notes"),
    status: text("status").default("draft").notNull(),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null"
    }),
    publishedAt: timestamp("published_at", {
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
    uniqueIndex("prompt_versions_key_version_unique").on(
      table.key,
      table.version
    ),
    index("prompt_versions_status_idx").on(table.status),
    check(
      "prompt_versions_status_valid",
      sql`${table.status} in ('draft', 'active', 'archived')`
    )
  ]
);

export const promptEvalCase = pgTable(
  "prompt_eval_case",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    expected: jsonb("expected")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    tags: text("tags").array().default([]).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null"
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
  (table) => [index("prompt_eval_case_enabled_idx").on(table.enabled)]
);

export const promptEvalRun = pgTable(
  "prompt_eval_run",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    promptVersionId: uuid("prompt_version_id")
      .notNull()
      .references(() => promptVersion.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    status: operationStatus("status").default("queued").notNull(),
    configuration: jsonb("configuration")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    summary: jsonb("summary")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    initiatedByUserId: text("initiated_by_user_id").references(() => user.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true
    })
  },
  (table) => [
    index("prompt_eval_run_status_created_idx").on(
      table.status,
      table.createdAt
    )
  ]
);

export const promptEvalResult = pgTable(
  "prompt_eval_result",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => promptEvalRun.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => promptEvalCase.id, { onDelete: "restrict" }),
    status: operationStatus("status").default("queued").notNull(),
    score: doublePrecision("score"),
    output: text("output"),
    metrics: jsonb("metrics")
      .$type<Record<string, number | boolean | string | null>>()
      .default({})
      .notNull(),
    latencyMs: integer("latency_ms"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .notNull()
  },
  (table) => [
    uniqueIndex("prompt_eval_result_run_case_unique").on(
      table.runId,
      table.caseId
    ),
    index("prompt_eval_result_status_idx").on(table.status)
  ]
);

export const role = pgTable("role", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  permissions: jsonb("permissions").$type<string[]>().default([]).notNull(),
  isSystem: boolean("is_system").default(false).notNull(),
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

export const adminRoles = pgTable(
  "admin_role",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: adminRoleName("role").notNull(),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({
      name: "admin_role_primary",
      columns: [table.userId, table.role]
    }),
    index("admin_role_role_idx").on(table.role)
  ]
);

export const userRole = pgTable(
  "user_role",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => role.id, { onDelete: "cascade" }),
    assignedByUserId: text("assigned_by_user_id").references(() => user.id, {
      onDelete: "set null"
    }),
    assignedAt: timestamp("assigned_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({
      name: "user_role_primary",
      columns: [table.userId, table.roleId]
    }),
    index("user_role_role_idx").on(table.roleId)
  ]
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null"
    }),
    actorRole: text("actor_role").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    requestId: text("request_id"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .notNull()
  },
  (table) => [
    index("audit_log_actor_created_idx").on(table.actorUserId, table.createdAt),
    index("audit_log_target_created_idx").on(
      table.targetType,
      table.targetId,
      table.createdAt
    ),
    index("audit_log_action_created_idx").on(table.action, table.createdAt)
  ]
);

export const systemSetting = pgTable("system_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  description: text("description"),
  isSecret: boolean("is_secret").default(false).notNull(),
  updatedBy: text("updated_by").references(() => user.id, {
    onDelete: "set null"
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
});

export const backgroundTask = pgTable(
  "background_task",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: text("type").notNull(),
    status: operationStatus("status").default("queued").notNull(),
    priority: integer("priority").default(0).notNull(),
    idempotencyKey: text("idempotency_key"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    runAt: timestamp("run_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    lockedAt: timestamp("locked_at", {
      mode: "date",
      withTimezone: true
    }),
    lockedBy: text("locked_by"),
    leaseToken: uuid("lease_token"),
    lastError: text("last_error"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null"
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
      .notNull(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true
    })
  },
  (table) => [
    uniqueIndex("background_task_idempotency_unique").on(table.idempotencyKey),
    index("background_task_queue_idx").on(
      table.status,
      table.runAt,
      table.priority
    ),
    check("background_task_attempts_non_negative", sql`${table.attempts} >= 0`),
    check(
      "background_task_max_attempts_positive",
      sql`${table.maxAttempts} > 0`
    )
  ]
);

export const promptTemplateRelations = relations(
  promptTemplate,
  ({ many }) => ({
    versions: many(promptVersion)
  })
);

export const promptVersionRelations = relations(
  promptVersion,
  ({ one, many }) => ({
    template: one(promptTemplate, {
      fields: [promptVersion.templateId],
      references: [promptTemplate.id]
    }),
    evalRuns: many(promptEvalRun)
  })
);

export const promptEvalRunRelations = relations(
  promptEvalRun,
  ({ one, many }) => ({
    promptVersion: one(promptVersion, {
      fields: [promptEvalRun.promptVersionId],
      references: [promptVersion.id]
    }),
    results: many(promptEvalResult)
  })
);

export const roleRelations = relations(role, ({ many }) => ({
  assignments: many(userRole)
}));

export const auditLogs = auditLog;
export const systemSettings = systemSetting;
export const backgroundTasks = backgroundTask;
export const modelInvocations = modelInvocation;
