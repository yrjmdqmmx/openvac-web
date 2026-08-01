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
import { knowledgeChunk } from "./knowledge";

export const conversationStatus = pgEnum("conversation_status", [
  "active",
  "archived",
  "deleted"
]);

export const messageRole = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
  "tool"
]);

export const messageStatus = pgEnum("message_status", [
  "pending",
  "streaming",
  "completed",
  "failed",
  "cancelled"
]);

export const citationSourceType = pgEnum("citation_source_type", [
  "knowledge",
  "web",
  "manual"
]);

export const feedbackRating = pgEnum("feedback_rating", [
  "helpful",
  "not_helpful"
]);

export const feedbackKind = pgEnum("feedback_kind", ["feedback", "report"]);

export const conversation = pgTable(
  "conversation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    summary: text("summary"),
    status: conversationStatus("status").default("active").notNull(),
    model: text("model"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    lastMessageAt: timestamp("last_message_at", {
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
      .notNull(),
    deletedAt: timestamp("deleted_at", {
      mode: "date",
      withTimezone: true
    })
  },
  (table) => [
    index("conversation_user_updated_idx").on(table.userId, table.updatedAt),
    index("conversation_status_idx").on(table.status)
  ]
);

export const message = pgTable(
  "message",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, {
      onDelete: "set null"
    }),
    sequence: integer("sequence").notNull(),
    role: messageRole("role").notNull(),
    status: messageStatus("status").default("pending").notNull(),
    content: text("content").default("").notNull(),
    clientRequestId: text("client_request_id"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
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
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true
    })
  },
  (table) => [
    uniqueIndex("message_conversation_sequence_unique").on(
      table.conversationId,
      table.sequence
    ),
    uniqueIndex("message_conversation_client_request_unique").on(
      table.conversationId,
      table.clientRequestId
    ),
    index("message_conversation_created_idx").on(
      table.conversationId,
      table.createdAt
    ),
    index("message_user_idx").on(table.userId),
    index("message_status_idx").on(table.status)
  ]
);

export const citation = pgTable(
  "citation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceType: citationSourceType("source_type").notNull(),
    knowledgeChunkId: uuid("knowledge_chunk_id").references(
      () => knowledgeChunk.id,
      { onDelete: "set null" }
    ),
    title: text("title").notNull(),
    url: text("url"),
    quote: text("quote"),
    sourceTier: text("source_tier"),
    license: text("license"),
    locator: jsonb("locator")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
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
  (table) => [index("citation_chunk_idx").on(table.knowledgeChunkId)]
);

export const messageCitation = pgTable(
  "message_citation",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    citationId: uuid("citation_id")
      .notNull()
      .references(() => citation.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull()
  },
  (table) => [
    uniqueIndex("message_citation_message_ordinal_unique").on(
      table.messageId,
      table.ordinal
    ),
    uniqueIndex("message_citation_pair_unique").on(
      table.messageId,
      table.citationId
    ),
    index("message_citation_citation_idx").on(table.citationId)
  ]
);

export const feedback = pgTable(
  "message_feedback",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    kind: feedbackKind("kind").notNull(),
    rating: feedbackRating("rating"),
    reason: text("reason"),
    comment: text("comment"),
    category: text("category"),
    details: text("details"),
    status: text("status").default("open").notNull(),
    adminNote: text("admin_note"),
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
  },
  (table) => [
    uniqueIndex("feedback_user_message_kind_unique").on(
      table.messageId,
      table.userId,
      table.kind
    ),
    index("feedback_rating_idx").on(table.rating),
    check(
      "feedback_status_valid",
      sql`${table.status} in ('open', 'reviewing', 'resolved', 'dismissed')`
    )
  ]
);

export const problemReport = pgTable(
  "problem_report",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientRequestId: uuid("client_request_id").defaultRandom().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversation.id, {
      onDelete: "set null"
    }),
    messageId: uuid("message_id").references(() => message.id, {
      onDelete: "set null"
    }),
    category: text("category").notNull(),
    description: text("description").notNull(),
    includeContext: boolean("include_context").default(false).notNull(),
    context: jsonb("context")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    contactType: text("contact_type"),
    contactValue: text("contact_value"),
    consentToContact: boolean("consent_to_contact").default(false).notNull(),
    status: text("status").default("new").notNull(),
    adminNote: text("admin_note"),
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
    closedAt: timestamp("closed_at", {
      mode: "date",
      withTimezone: true
    }),
    retentionUntil: timestamp("retention_until", {
      mode: "date",
      withTimezone: true
    }).notNull(),
    contactPurgeAt: timestamp("contact_purge_at", {
      mode: "date",
      withTimezone: true
    })
  },
  (table) => [
    uniqueIndex("problem_report_user_client_request_unique").on(
      table.userId,
      table.clientRequestId
    ),
    index("problem_report_user_created_idx").on(table.userId, table.createdAt),
    index("problem_report_status_created_idx").on(
      table.status,
      table.createdAt
    ),
    index("problem_report_retention_idx").on(table.retentionUntil),
    index("problem_report_contact_purge_idx").on(table.contactPurgeAt),
    check(
      "problem_report_status_valid",
      sql`${table.status} in ('new', 'reviewing', 'closed')`
    ),
    check(
      "problem_report_category_valid",
      sql`${table.category} in ('answer_incorrect', 'citation_problem', 'unsafe_answer', 'system_error', 'product_suggestion', 'other')`
    ),
    check(
      "problem_report_description_length_valid",
      sql`char_length(${table.description}) between 1 and 3000`
    ),
    check(
      "problem_report_contact_type_valid",
      sql`${table.contactType} is null or ${table.contactType} in ('email', 'phone', 'wechat')`
    ),
    check(
      "problem_report_contact_pair_valid",
      sql`(${table.contactType} is null and ${table.contactValue} is null) or (${table.contactType} is not null and ${table.contactValue} is not null and ${table.consentToContact} = true)`
    )
  ]
);

export const conversationRelations = relations(
  conversation,
  ({ one, many }) => ({
    user: one(user, {
      fields: [conversation.userId],
      references: [user.id]
    }),
    messages: many(message),
    problemReports: many(problemReport)
  })
);

export const messageRelations = relations(message, ({ one, many }) => ({
  conversation: one(conversation, {
    fields: [message.conversationId],
    references: [conversation.id]
  }),
  citations: many(messageCitation),
  feedback: many(feedback)
}));

export const citationRelations = relations(citation, ({ one, many }) => ({
  messages: many(messageCitation),
  knowledgeChunk: one(knowledgeChunk, {
    fields: [citation.knowledgeChunkId],
    references: [knowledgeChunk.id]
  })
}));

export const messageCitationRelations = relations(
  messageCitation,
  ({ one }) => ({
    message: one(message, {
      fields: [messageCitation.messageId],
      references: [message.id]
    }),
    citation: one(citation, {
      fields: [messageCitation.citationId],
      references: [citation.id]
    })
  })
);

export const conversations = conversation;
export const messages = message;
export const citations = citation;
export const messageCitations = messageCitation;
export const messageFeedback = feedback;
export const problemReports = problemReport;
