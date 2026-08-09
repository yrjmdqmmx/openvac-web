import { readFileSync } from "node:fs";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as rootSchema from "../schema";
import {
  chatArtifact,
  chatArtifactFile,
  chatAttachment,
  chatAttachmentChunk,
  chatStorageAccount,
  chatStorageDeletionJob
} from "./chat-storage";

describe("chat attachment and artifact storage schema", () => {
  it("uses dedicated private tables rather than governed knowledge originals", () => {
    expect(rootSchema).toHaveProperty("chatAttachment");
    expect(rootSchema).toHaveProperty("chatAttachmentChunk");
    expect(rootSchema).toHaveProperty("chatArtifact");
    expect(rootSchema).toHaveProperty("chatArtifactFile");
    expect(chatAttachment).not.toBe(rootSchema.knowledgeOriginal);

    const attachment = getTableConfig(chatAttachment);
    expect(
      attachment.foreignKeys.map(
        (foreignKey) => foreignKey.reference().foreignTable
      )
    ).not.toContain(rootSchema.knowledgeVersion);
  });

  it("enforces file size, MIME, hash, object-key, and quota states", () => {
    const attachment = getTableConfig(chatAttachment);
    expect(attachment.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "chat_attachment_mime_type_valid",
        "chat_attachment_size_valid",
        "chat_attachment_sha256_valid",
        "chat_attachment_object_key_valid",
        "chat_attachment_kind_mime_valid",
        "chat_attachment_quota_state_valid"
      ])
    );
    expect(attachment.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "chat_attachment_user_status_idx",
        "chat_attachment_conversation_created_idx",
        "chat_attachment_message_idx",
        "chat_attachment_parse_queue_idx",
        "chat_attachment_orphan_expiry_idx"
      ])
    );

    const quota = getTableConfig(chatStorageAccount);
    expect(quota.checks.map((check) => check.name)).toContain(
      "chat_storage_account_bytes_valid"
    );
    expect(chatStorageAccount.limitBytes.default).toBe(500 * 1024 * 1024);
  });

  it("stores private locator chunks and idempotent deletion jobs", () => {
    const chunks = getTableConfig(chatAttachmentChunk);
    expect(chunks.indexes.map((index) => index.config.name)).toContain(
      "chat_attachment_chunk_ordinal_unique"
    );
    expect(chunks.foreignKeys[0]?.onDelete).toBe("cascade");

    const deletion = getTableConfig(chatStorageDeletionJob);
    expect(deletion.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "chat_storage_deletion_job_object_key_unique",
        "chat_storage_deletion_job_queue_idx",
        "chat_storage_deletion_job_user_idx"
      ])
    );
    expect(deletion.foreignKeys[0]?.onDelete).toBe("set null");
  });

  it("models artifact metadata and files without implementing renderers", () => {
    const artifact = getTableConfig(chatArtifact);
    const files = getTableConfig(chatArtifactFile);
    expect(artifact.indexes.map((index) => index.config.name)).toContain(
      "chat_artifact_source_turn_idx"
    );
    expect(files.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "chat_artifact_file_format_unique",
        "chat_artifact_file_object_key_unique"
      ])
    );
  });

  it("ships an additive literal migration with safe object-key constraints", () => {
    const migration = readFileSync(
      new URL("../../../../drizzle/0014_material_rage.sql", import.meta.url),
      "utf8"
    );
    expect(migration).toContain('CREATE TABLE "chat_attachment"');
    expect(migration).toContain('CREATE TABLE "chat_attachment_chunk"');
    expect(migration).toContain('CREATE TABLE "chat_storage_account"');
    expect(migration).toContain('CREATE TABLE "chat_storage_deletion_job"');
    expect(migration).toContain("26214400");
    expect(migration).toContain("524288000");
    expect(migration).toContain("'(^|/)\\.\\.(/|$)'");
    expect(migration).not.toContain("knowledge_original");
    expect(migration).not.toContain("$1");
  });
});
