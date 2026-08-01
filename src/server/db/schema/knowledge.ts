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
    chunks: many(knowledgeChunk)
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
