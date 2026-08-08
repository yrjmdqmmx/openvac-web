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
  unique,
  uniqueIndex,
  uuid,
  vector
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { user } from "./auth";

export const knowledgeSourceKind = pgEnum("knowledge_source_kind", [
  "upload",
  "manual",
  "manufacturer",
  "standard",
  "patent",
  "web"
]);

export const knowledgeStatus = pgEnum("knowledge_status", [
  "draft",
  "processing",
  "review",
  "published",
  "failed",
  "archived"
]);

export const knowledgeSectionDecisionStatus = pgEnum(
  "knowledge_section_decision_status",
  ["approved", "rejected", "changes_requested"]
);

export const knowledgeReviewPhase = pgEnum("knowledge_review_phase", [
  "initial",
  "verify"
]);

export const knowledgeReviewRunStatus = pgEnum("knowledge_review_run_status", [
  "queued",
  "leased",
  "completed",
  "needs_human",
  "failed"
]);

export const knowledgeReviewRisk = pgEnum("knowledge_review_risk", [
  "low",
  "medium",
  "high"
]);

export const knowledgeReviewDecision = pgEnum("knowledge_review_decision", [
  "approved",
  "rejected",
  "needs_human"
]);

export const knowledgeSourceTier = pgEnum("knowledge_source_tier", [
  "open_license",
  "metadata_only",
  "manufacturer_metadata",
  "standard_metadata",
  "internal"
]);

export const knowledgeSource = pgTable(
  "knowledge_source",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: knowledgeSourceKind("kind").default("manual").notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url"),
    canonicalUrl: text("canonical_url"),
    publisher: text("publisher"),
    sourceTier: knowledgeSourceTier("source_tier")
      .default("internal")
      .notNull(),
    licensePolicy: text("license_policy"),
    notes: text("notes"),
    enabled: boolean("enabled").default(true).notNull(),
    trustLevel: integer("trust_level").default(0).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdBy: text("created_by").references(() => user.id, {
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
    deletedAt: timestamp("deleted_at", {
      mode: "date",
      withTimezone: true
    })
  },
  (table) => [
    index("knowledge_source_kind_idx").on(table.kind),
    index("knowledge_source_publisher_idx").on(table.publisher)
  ]
);

export const knowledgeDocument = pgTable(
  "knowledge_document",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id").references(() => knowledgeSource.id, {
      onDelete: "set null"
    }),
    externalKey: text("external_key"),
    title: text("title").notNull(),
    description: text("description"),
    language: text("language").default("zh-CN").notNull(),
    mimeType: text("mime_type"),
    status: text("status").default("draft").notNull(),
    currentVersionId: uuid("current_version_id").references(
      (): AnyPgColumn => knowledgeVersion.id,
      { onDelete: "set null" }
    ),
    tags: text("tags").array().default([]).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdBy: text("created_by").references(() => user.id, {
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
  (table) => [
    uniqueIndex("knowledge_document_source_external_unique").on(
      table.sourceId,
      table.externalKey
    ),
    index("knowledge_document_status_idx").on(table.status),
    index("knowledge_document_created_by_idx").on(table.createdBy),
    check(
      "knowledge_document_status_valid",
      sql`${table.status} in ('draft', 'processing', 'review', 'published', 'failed', 'archived')`
    )
  ]
);

export const knowledgeVersion = pgTable(
  "knowledge_version",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocument.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    contentHash: text("content_hash"),
    content: text("content").default("").notNull(),
    citationMetadata: jsonb("citation_metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    status: knowledgeStatus("status").default("draft").notNull(),
    objectKey: text("object_key"),
    parserVersion: text("parser_version"),
    sourceUpdatedAt: timestamp("source_updated_at", {
      mode: "date",
      withTimezone: true
    }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
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
    uniqueIndex("knowledge_version_document_version_unique").on(
      table.documentId,
      table.version
    ),
    index("knowledge_version_document_hash_idx").on(
      table.documentId,
      table.contentHash
    ),
    index("knowledge_version_published_at_idx").on(table.publishedAt),
    check(
      "knowledge_version_content_hash_valid",
      sql`${table.contentHash} is null or ${table.contentHash} ~ '^[0-9a-f]{64}$'`
    )
  ]
);

export const knowledgeOriginal = pgTable(
  "knowledge_original",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => knowledgeVersion.id, { onDelete: "restrict" }),
    objectKey: text("object_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    uploadedBy: text("uploaded_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    retentionPolicy: text("retention_policy")
      .default("retain_indefinitely")
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
    uniqueIndex("knowledge_original_version_unique").on(table.versionId),
    uniqueIndex("knowledge_original_object_key_unique").on(table.objectKey),
    index("knowledge_original_uploaded_by_idx").on(table.uploadedBy),
    check(
      "knowledge_original_mime_type_valid",
      sql`${table.mimeType} in ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'text/plain', 'text/markdown', 'image/jpeg', 'image/png')`
    ),
    check(
      "knowledge_original_size_valid",
      sql`${table.sizeBytes} > 0 and ${table.sizeBytes} <= 52428800`
    ),
    check(
      "knowledge_original_sha256_valid",
      sql`${table.sha256} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "knowledge_original_object_key_valid",
      sql`${table.objectKey} ~ '^private/knowledge-originals/[A-Za-z0-9][A-Za-z0-9._/-]*$' and ${table.objectKey} !~ '(^|/)\\.\\.(/|$)' and ${table.objectKey} !~ '//'`
    ),
    check(
      "knowledge_original_retention_policy_valid",
      sql`${table.retentionPolicy} = 'retain_indefinitely'`
    )
  ]
);

export const knowledgeReviewRun = pgTable(
  "knowledge_review_run",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    phase: knowledgeReviewPhase("phase").notNull(),
    status: knowledgeReviewRunStatus("status").default("queued").notNull(),
    inputVersionId: uuid("input_version_id")
      .notNull()
      .references(() => knowledgeVersion.id, { onDelete: "restrict" }),
    inputContentHash: text("input_content_hash").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    risk: knowledgeReviewRisk("risk"),
    structuredReport: jsonb("structured_report")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    decision: knowledgeReviewDecision("decision"),
    leaseTokenHash: text("lease_token_hash"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      mode: "date",
      withTimezone: true
    }),
    attempts: integer("attempts").default(0).notNull(),
    revisedVersionId: uuid("revised_version_id").references(
      () => knowledgeVersion.id,
      { onDelete: "restrict" }
    ),
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
    uniqueIndex("knowledge_review_run_version_hash_prompt_phase_unique").on(
      table.inputVersionId,
      table.inputContentHash,
      table.promptVersion,
      table.phase
    ),
    index("knowledge_review_run_lease_idx").on(
      table.status,
      table.leaseExpiresAt,
      table.createdAt
    ),
    index("knowledge_review_run_revised_version_idx").on(
      table.revisedVersionId
    ),
    check(
      "knowledge_review_run_hashes_valid",
      sql`${table.inputContentHash} ~ '^[0-9a-f]{64}$' and (${table.leaseTokenHash} is null or ${table.leaseTokenHash} ~ '^[0-9a-f]{64}$')`
    ),
    check("knowledge_review_run_attempts_valid", sql`${table.attempts} >= 0`),
    check(
      "knowledge_review_run_lease_valid",
      sql`(${table.status} = 'leased' and ${table.leaseTokenHash} is not null and ${table.leaseExpiresAt} is not null) or (${table.status} <> 'leased' and ${table.leaseTokenHash} is null and ${table.leaseExpiresAt} is null)`
    ),
    check(
      "knowledge_review_run_completion_valid",
      sql`${table.status} <> 'completed' or (${table.risk} is not null and ${table.decision} is not null and ${table.completedAt} is not null)`
    )
  ]
);

export const knowledgeReviewSection = pgTable(
  "knowledge_review_section",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => knowledgeVersion.id, { onDelete: "cascade" }),
    sectionIndex: integer("section_index").notNull(),
    contentZh: text("content_zh").notNull(),
    officialText: text("official_text").default("").notNull(),
    pageStart: integer("page_start"),
    pageEnd: integer("page_end"),
    rightsSnapshot: jsonb("rights_snapshot")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    rightsSnapshotHash: text("rights_snapshot_hash").notNull(),
    versionContentHash: text("version_content_hash").notNull(),
    sectionHash: text("section_hash").notNull(),
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
    unique("knowledge_review_section_version_index_unique").on(
      table.versionId,
      table.sectionIndex
    ),
    index("knowledge_review_section_version_idx").on(table.versionId),
    check(
      "knowledge_review_section_index_valid",
      sql`${table.sectionIndex} >= 0`
    ),
    check(
      "knowledge_review_section_pages_valid",
      sql`(${table.pageStart} is null or ${table.pageStart} > 0) and (${table.pageEnd} is null or ${table.pageEnd} >= ${table.pageStart})`
    ),
    check(
      "knowledge_review_section_hash_valid",
      sql`${table.sectionHash} ~ '^[0-9a-f]{64}$' and ${table.rightsSnapshotHash} ~ '^[0-9a-f]{64}$' and ${table.versionContentHash} ~ '^[0-9a-f]{64}$'`
    )
  ]
);

export const knowledgeSectionDecision = pgTable(
  "knowledge_section_decision",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => knowledgeReviewSection.id, { onDelete: "cascade" }),
    sectionHash: text("section_hash").notNull(),
    decision: knowledgeSectionDecisionStatus("decision").notNull(),
    note: text("note"),
    reviewerId: text("reviewer_id").references(() => user.id, {
      onDelete: "set null"
    }),
    revision: integer("revision").default(1).notNull(),
    decidedAt: timestamp("decided_at", {
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
    unique("knowledge_section_decision_section_unique").on(table.sectionId),
    index("knowledge_section_decision_reviewer_idx").on(table.reviewerId),
    check(
      "knowledge_section_decision_hash_valid",
      sql`${table.sectionHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "knowledge_section_decision_revision_valid",
      sql`${table.revision} > 0`
    ),
    check(
      "knowledge_section_decision_note_required",
      sql`${table.decision} = 'approved' or length(trim(coalesce(${table.note}, ''))) > 0`
    )
  ]
);

export const knowledgeChunk = pgTable(
  "knowledge_chunk",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => knowledgeVersion.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count"),
    pageStart: integer("page_start"),
    pageEnd: integer("page_end"),
    sectionPath: text("section_path").array().default([]).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    embedding: vector("embedding", { dimensions: 1024 }),
    embeddingModel: text("embedding_model"),
    embeddedAt: timestamp("embedded_at", {
      mode: "date",
      withTimezone: true
    }),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true
    })
      .defaultNow()
      .notNull()
  },
  (table) => [
    uniqueIndex("knowledge_chunk_version_index_unique").on(
      table.versionId,
      table.chunkIndex
    ),
    index("knowledge_chunk_version_idx").on(table.versionId),
    index("knowledge_chunk_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops")
    ),
    index("knowledge_chunk_content_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', ${table.content})`
    )
  ]
);

export const knowledgeSourceRelations = relations(
  knowledgeSource,
  ({ many }) => ({
    documents: many(knowledgeDocument)
  })
);

export const knowledgeDocumentRelations = relations(
  knowledgeDocument,
  ({ one, many }) => ({
    source: one(knowledgeSource, {
      fields: [knowledgeDocument.sourceId],
      references: [knowledgeSource.id]
    }),
    versions: many(knowledgeVersion, {
      relationName: "knowledge_document_versions"
    }),
    currentVersion: one(knowledgeVersion, {
      fields: [knowledgeDocument.currentVersionId],
      references: [knowledgeVersion.id],
      relationName: "knowledge_document_current_version"
    })
  })
);

export const knowledgeVersionRelations = relations(
  knowledgeVersion,
  ({ one, many }) => ({
    document: one(knowledgeDocument, {
      fields: [knowledgeVersion.documentId],
      references: [knowledgeDocument.id],
      relationName: "knowledge_document_versions"
    }),
    chunks: many(knowledgeChunk),
    reviewSections: many(knowledgeReviewSection),
    original: one(knowledgeOriginal),
    reviewRuns: many(knowledgeReviewRun, {
      relationName: "knowledge_review_run_input_version"
    }),
    revisedByReviewRuns: many(knowledgeReviewRun, {
      relationName: "knowledge_review_run_revised_version"
    })
  })
);

export const knowledgeOriginalRelations = relations(
  knowledgeOriginal,
  ({ one }) => ({
    version: one(knowledgeVersion, {
      fields: [knowledgeOriginal.versionId],
      references: [knowledgeVersion.id]
    }),
    uploader: one(user, {
      fields: [knowledgeOriginal.uploadedBy],
      references: [user.id]
    })
  })
);

export const knowledgeReviewRunRelations = relations(
  knowledgeReviewRun,
  ({ one }) => ({
    inputVersion: one(knowledgeVersion, {
      fields: [knowledgeReviewRun.inputVersionId],
      references: [knowledgeVersion.id],
      relationName: "knowledge_review_run_input_version"
    }),
    revisedVersion: one(knowledgeVersion, {
      fields: [knowledgeReviewRun.revisedVersionId],
      references: [knowledgeVersion.id],
      relationName: "knowledge_review_run_revised_version"
    })
  })
);

export const knowledgeReviewSectionRelations = relations(
  knowledgeReviewSection,
  ({ one }) => ({
    version: one(knowledgeVersion, {
      fields: [knowledgeReviewSection.versionId],
      references: [knowledgeVersion.id]
    }),
    decision: one(knowledgeSectionDecision, {
      fields: [knowledgeReviewSection.id],
      references: [knowledgeSectionDecision.sectionId]
    })
  })
);

export const knowledgeSectionDecisionRelations = relations(
  knowledgeSectionDecision,
  ({ one }) => ({
    section: one(knowledgeReviewSection, {
      fields: [knowledgeSectionDecision.sectionId],
      references: [knowledgeReviewSection.id]
    }),
    reviewer: one(user, {
      fields: [knowledgeSectionDecision.reviewerId],
      references: [user.id]
    })
  })
);

export const knowledgeChunkRelations = relations(knowledgeChunk, ({ one }) => ({
  version: one(knowledgeVersion, {
    fields: [knowledgeChunk.versionId],
    references: [knowledgeVersion.id]
  })
}));

export const knowledgeSources = knowledgeSource;
export const knowledgeDocuments = knowledgeDocument;
export const knowledgeVersions = knowledgeVersion;
export const knowledgeChunks = knowledgeChunk;
export const knowledgeOriginals = knowledgeOriginal;
export const knowledgeReviewRuns = knowledgeReviewRun;
export const knowledgeReviewSections = knowledgeReviewSection;
export const knowledgeSectionDecisions = knowledgeSectionDecision;
