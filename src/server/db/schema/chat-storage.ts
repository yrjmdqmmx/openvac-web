import { relations, sql } from "drizzle-orm";
import {
  bigint,
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

const MAX_CHAT_STORAGE_BYTES = 500 * 1024 * 1024;

export const chatAttachmentKind = pgEnum("chat_attachment_kind", [
  "document",
  "image"
]);

export const chatAttachmentStatus = pgEnum("chat_attachment_status", [
  "initiated",
  "uploading",
  "scanning",
  "processing",
  "ready",
  "failed",
  "deleted"
]);

export const chatAttachmentParseStatus = pgEnum(
  "chat_attachment_parse_status",
  ["not_required", "queued", "processing", "ready", "failed"]
);

export const chatStorageQuotaState = pgEnum("chat_storage_quota_state", [
  "reserved",
  "committed",
  "released"
]);

export const chatStorageDeletionStatus = pgEnum(
  "chat_storage_deletion_status",
  ["active", "queued", "deleting", "deleted", "failed"]
);

export const chatArtifactStatus = pgEnum("chat_artifact_status", [
  "generating",
  "ready",
  "failed",
  "deleted"
]);

export const chatArtifactKind = pgEnum("chat_artifact_kind", [
  "diagnosis_report",
  "selection_report",
  "inspection_checklist",
  "parameter_table"
]);

export const chatArtifactFormat = pgEnum("chat_artifact_format", [
  "md",
  "docx",
  "pdf",
  "csv"
]);

export const chatStorageObjectType = pgEnum("chat_storage_object_type", [
  "attachment",
  "artifact"
]);

export const chatStorageDeletionJobStatus = pgEnum(
  "chat_storage_deletion_job_status",
  ["queued", "running", "succeeded", "failed"]
);

export const chatStorageAccount = pgTable(
  "chat_storage_account",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    usedBytes: bigint("used_bytes", { mode: "number" }).default(0).notNull(),
    reservedBytes: bigint("reserved_bytes", { mode: "number" })
      .default(0)
      .notNull(),
    limitBytes: bigint("limit_bytes", { mode: "number" })
      .default(MAX_CHAT_STORAGE_BYTES)
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
    check(
      "chat_storage_account_bytes_valid",
      sql`${table.usedBytes} >= 0 and ${table.reservedBytes} >= 0 and ${table.limitBytes} > 0 and ${table.usedBytes} + ${table.reservedBytes} <= ${table.limitBytes}`
    )
  ]
);

export const chatAttachment = pgTable(
  "chat_attachment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => message.id, {
      onDelete: "set null"
    }),
    kind: chatAttachmentKind("kind").notNull(),
    status: chatAttachmentStatus("status").default("initiated").notNull(),
    parseStatus: chatAttachmentParseStatus("parse_status")
      .default("queued")
      .notNull(),
    quotaState: chatStorageQuotaState("quota_state")
      .default("reserved")
      .notNull(),
    deletionStatus: chatStorageDeletionStatus("deletion_status")
      .default("active")
      .notNull(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    declaredSizeBytes: bigint("declared_size_bytes", {
      mode: "number"
    }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    objectEtag: text("object_etag"),
    uploadExpiresAt: timestamp("upload_expires_at", {
      mode: "date",
      withTimezone: true
    }).notNull(),
    orphanExpiresAt: timestamp("orphan_expires_at", {
      mode: "date",
      withTimezone: true
    }).notNull(),
    boundAt: timestamp("bound_at", {
      mode: "date",
      withTimezone: true
    }),
    parseProvider: text("parse_provider"),
    parseJobId: text("parse_job_id"),
    parseAttempts: integer("parse_attempts").default(0).notNull(),
    parseMaxAttempts: integer("parse_max_attempts").default(3).notNull(),
    parsePollCount: integer("parse_poll_count").default(0).notNull(),
    parseSubmittedAt: timestamp("parse_submitted_at", {
      mode: "date",
      withTimezone: true
    }),
    parseRunAt: timestamp("parse_run_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .notNull(),
    parseLockedAt: timestamp("parse_locked_at", {
      mode: "date",
      withTimezone: true
    }),
    parseLockedBy: text("parse_locked_by"),
    parseLeaseToken: uuid("parse_lease_token"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    readyAt: timestamp("ready_at", {
      mode: "date",
      withTimezone: true
    }),
    deletedAt: timestamp("deleted_at", {
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
    uniqueIndex("chat_attachment_object_key_unique").on(table.objectKey),
    index("chat_attachment_user_status_idx").on(
      table.userId,
      table.status,
      table.createdAt
    ),
    index("chat_attachment_conversation_created_idx").on(
      table.conversationId,
      table.createdAt
    ),
    index("chat_attachment_message_idx").on(table.messageId),
    index("chat_attachment_parse_queue_idx")
      .on(table.parseStatus, table.parseRunAt)
      .where(sql`${table.deletionStatus} = 'active'`),
    index("chat_attachment_orphan_expiry_idx")
      .on(table.orphanExpiresAt)
      .where(
        sql`${table.messageId} is null and ${table.deletionStatus} = 'active'`
      ),
    check(
      "chat_attachment_mime_type_valid",
      sql`${table.mimeType} in ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'text/plain', 'text/markdown', 'image/jpeg', 'image/png')`
    ),
    check(
      "chat_attachment_size_valid",
      sql`${table.declaredSizeBytes} > 0 and ${table.declaredSizeBytes} <= 26214400 and (${table.sizeBytes} is null or (${table.sizeBytes} > 0 and ${table.sizeBytes} <= 26214400))`
    ),
    check(
      "chat_attachment_sha256_valid",
      sql`${table.sha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "chat_attachment_object_key_valid",
      sql`${table.objectKey} ~ '^private/chat-attachments/[A-Za-z0-9][A-Za-z0-9._/-]*$' and ${table.objectKey} !~ '(^|/)\\.\\.(/|$)' and ${table.objectKey} !~ '//'`
    ),
    check(
      "chat_attachment_kind_mime_valid",
      sql`(${table.kind} = 'image' and ${table.mimeType} in ('image/jpeg', 'image/png')) or (${table.kind} = 'document' and ${table.mimeType} not in ('image/jpeg', 'image/png'))`
    ),
    check(
      "chat_attachment_quota_state_valid",
      sql`(${table.quotaState} = 'reserved' and ${table.sizeBytes} is null) or (${table.quotaState} = 'committed' and ${table.sizeBytes} is not null) or ${table.quotaState} = 'released'`
    ),
    check(
      "chat_attachment_parse_attempts_valid",
      sql`${table.parseAttempts} >= 0 and ${table.parseMaxAttempts} > 0 and ${table.parsePollCount} >= 0`
    )
  ]
);

export const chatAttachmentChunk = pgTable(
  "chat_attachment_chunk",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    attachmentId: uuid("attachment_id")
      .notNull()
      .references(() => chatAttachment.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
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
  (table) => [
    uniqueIndex("chat_attachment_chunk_ordinal_unique").on(
      table.attachmentId,
      table.ordinal
    ),
    check(
      "chat_attachment_chunk_content_valid",
      sql`${table.ordinal} >= 0 and char_length(${table.content}) > 0 and ${table.contentHash} ~ '^[0-9a-f]{64}$'`
    )
  ]
);

export const chatArtifact = pgTable(
  "chat_artifact",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => message.id, {
      onDelete: "set null"
    }),
    sourceTurnId: uuid("source_turn_id").notNull(),
    kind: chatArtifactKind("kind").notNull(),
    title: text("title").notNull(),
    status: chatArtifactStatus("status").default("generating").notNull(),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
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
    readyAt: timestamp("ready_at", {
      mode: "date",
      withTimezone: true
    }),
    deletedAt: timestamp("deleted_at", {
      mode: "date",
      withTimezone: true
    })
  },
  (table) => [
    index("chat_artifact_user_created_idx").on(table.userId, table.createdAt),
    index("chat_artifact_conversation_created_idx").on(
      table.conversationId,
      table.createdAt
    ),
    index("chat_artifact_message_idx").on(table.messageId),
    index("chat_artifact_source_turn_idx").on(table.sourceTurnId),
    check(
      "chat_artifact_title_valid",
      sql`char_length(${table.title}) between 1 and 240`
    )
  ]
);

export const chatArtifactFile = pgTable(
  "chat_artifact_file",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => chatArtifact.id, { onDelete: "cascade" }),
    format: chatArtifactFormat("format").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    quotaState: chatStorageQuotaState("quota_state")
      .default("committed")
      .notNull(),
    deletionStatus: chatStorageDeletionStatus("deletion_status")
      .default("active")
      .notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", {
      mode: "date",
      withTimezone: true
    })
  },
  (table) => [
    uniqueIndex("chat_artifact_file_format_unique").on(
      table.artifactId,
      table.format
    ),
    uniqueIndex("chat_artifact_file_object_key_unique").on(table.objectKey),
    check(
      "chat_artifact_file_size_valid",
      sql`${table.sizeBytes} > 0 and ${table.sizeBytes} <= 524288000`
    ),
    check(
      "chat_artifact_file_sha256_valid",
      sql`${table.sha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "chat_artifact_file_object_key_valid",
      sql`${table.objectKey} ~ '^private/chat-artifacts/[A-Za-z0-9][A-Za-z0-9._/-]*$' and ${table.objectKey} !~ '(^|/)\\.\\.(/|$)' and ${table.objectKey} !~ '//'`
    )
  ]
);

export const chatStorageDeletionJob = pgTable(
  "chat_storage_deletion_job",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").references(() => user.id, {
      onDelete: "set null"
    }),
    objectType: chatStorageObjectType("object_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    objectKey: text("object_key").notNull(),
    status: chatStorageDeletionJobStatus("status").default("queued").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
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
    uniqueIndex("chat_storage_deletion_job_object_key_unique").on(
      table.objectKey
    ),
    index("chat_storage_deletion_job_queue_idx").on(
      table.status,
      table.runAt,
      table.createdAt
    ),
    index("chat_storage_deletion_job_user_idx").on(table.userId),
    check(
      "chat_storage_deletion_job_attempts_valid",
      sql`${table.attempts} >= 0 and ${table.maxAttempts} > 0`
    ),
    check(
      "chat_storage_deletion_job_key_valid",
      sql`${table.objectKey} ~ '^private/chat-(attachments|artifacts)/[A-Za-z0-9][A-Za-z0-9._/-]*$' and ${table.objectKey} !~ '(^|/)\\.\\.(/|$)' and ${table.objectKey} !~ '//'`
    )
  ]
);

export const chatAttachmentRelations = relations(
  chatAttachment,
  ({ one, many }) => ({
    user: one(user, {
      fields: [chatAttachment.userId],
      references: [user.id]
    }),
    conversation: one(conversation, {
      fields: [chatAttachment.conversationId],
      references: [conversation.id]
    }),
    message: one(message, {
      fields: [chatAttachment.messageId],
      references: [message.id]
    }),
    chunks: many(chatAttachmentChunk)
  })
);

export const chatAttachmentChunkRelations = relations(
  chatAttachmentChunk,
  ({ one }) => ({
    attachment: one(chatAttachment, {
      fields: [chatAttachmentChunk.attachmentId],
      references: [chatAttachment.id]
    })
  })
);

export const chatArtifactRelations = relations(
  chatArtifact,
  ({ one, many }) => ({
    user: one(user, {
      fields: [chatArtifact.userId],
      references: [user.id]
    }),
    conversation: one(conversation, {
      fields: [chatArtifact.conversationId],
      references: [conversation.id]
    }),
    message: one(message, {
      fields: [chatArtifact.messageId],
      references: [message.id]
    }),
    files: many(chatArtifactFile)
  })
);

export const chatArtifactFileRelations = relations(
  chatArtifactFile,
  ({ one }) => ({
    artifact: one(chatArtifact, {
      fields: [chatArtifactFile.artifactId],
      references: [chatArtifact.id]
    })
  })
);

export const chatStorageAccounts = chatStorageAccount;
export const chatAttachments = chatAttachment;
export const chatAttachmentChunks = chatAttachmentChunk;
export const chatArtifacts = chatArtifact;
export const chatArtifactFiles = chatArtifactFile;
export const chatStorageDeletionJobs = chatStorageDeletionJob;
