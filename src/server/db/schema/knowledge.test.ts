import { readFileSync } from "node:fs";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as rootSchema from "../schema";
import * as knowledgeSchema from "./knowledge";
import {
  knowledgeChunk,
  knowledgeReviewSection,
  knowledgeSectionDecision,
  knowledgeStatus,
  knowledgeVersion
} from "./knowledge";

function requiredSchemaExport<T>(
  module: Record<string, unknown>,
  name: string
): T {
  const value = module[name];
  expect(value, `missing schema export ${name}`).toBeDefined();
  return value as T;
}

describe("knowledge schema safety gates", () => {
  it("includes the review lifecycle state", () => {
    expect(knowledgeStatus.enumValues).toContain("review");
  });

  it("enforces a lowercase SHA-256 content hash when present", () => {
    const config = getTableConfig(knowledgeVersion);

    expect(config.checks.map((item) => item.name)).toContain(
      "knowledge_version_content_hash_valid"
    );
  });

  it("indexes simple-config PostgreSQL full-text search with GIN", () => {
    const config = getTableConfig(knowledgeChunk);
    const fullTextIndex = config.indexes.find(
      (item) => item.config.name === "knowledge_chunk_content_fts_idx"
    );

    expect(fullTextIndex?.config.method).toBe("gin");
    expect(fullTextIndex?.config.columns[0]?.constructor.name).toBe("SQL");
  });

  it("normalizes stable review sections and one current decision per section", () => {
    const section = getTableConfig(knowledgeReviewSection);
    const decision = getTableConfig(knowledgeSectionDecision);

    expect(section.uniqueConstraints.map((item) => item.name)).toContain(
      "knowledge_review_section_version_index_unique"
    );
    expect(section.checks.map((item) => item.name)).toContain(
      "knowledge_review_section_hash_valid"
    );
    expect(decision.uniqueConstraints.map((item) => item.name)).toContain(
      "knowledge_section_decision_section_unique"
    );
    expect(decision.checks.map((item) => item.name)).toContain(
      "knowledge_section_decision_note_required"
    );
  });

  it("binds one retained private original to a knowledge version", () => {
    const table = requiredSchemaExport<typeof knowledgeVersion>(
      knowledgeSchema,
      "knowledgeOriginal"
    );
    const config = getTableConfig(table);
    const columnNames = config.columns.map((column) => column.name);

    expect(columnNames).toEqual(
      expect.arrayContaining([
        "version_id",
        "object_key",
        "original_filename",
        "mime_type",
        "size_bytes",
        "sha256",
        "uploaded_by",
        "retention_policy",
        "created_at",
        "updated_at"
      ])
    );
    expect(columnNames).not.toContain("expires_at");
    expect(columnNames).not.toContain("deleted_at");
    expect(config.indexes.map((item) => item.config.name)).toEqual(
      expect.arrayContaining([
        "knowledge_original_version_unique",
        "knowledge_original_object_key_unique"
      ])
    );
    expect(config.checks.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "knowledge_original_mime_type_valid",
        "knowledge_original_size_valid",
        "knowledge_original_sha256_valid",
        "knowledge_original_object_key_valid",
        "knowledge_original_retention_policy_valid"
      ])
    );
    expect(
      config.foreignKeys.every((item) => item.onDelete === "restrict")
    ).toBe(true);
  });

  it("models leased two-stage review runs without replacing legacy review", () => {
    const table = requiredSchemaExport<typeof knowledgeVersion>(
      knowledgeSchema,
      "knowledgeReviewRun"
    );
    const config = getTableConfig(table);
    const columnNames = config.columns.map((column) => column.name);

    expect(
      requiredSchemaExport<{ enumValues: string[] }>(
        knowledgeSchema,
        "knowledgeReviewPhase"
      ).enumValues
    ).toEqual(["initial", "verify"]);
    expect(
      requiredSchemaExport<{ enumValues: string[] }>(
        knowledgeSchema,
        "knowledgeReviewRunStatus"
      ).enumValues
    ).toEqual(["queued", "leased", "completed", "needs_human", "failed"]);
    expect(
      requiredSchemaExport<{ enumValues: string[] }>(
        knowledgeSchema,
        "knowledgeReviewRisk"
      ).enumValues
    ).toEqual(["low", "medium", "high"]);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "phase",
        "status",
        "input_version_id",
        "input_content_hash",
        "model",
        "prompt_version",
        "risk",
        "structured_report",
        "decision",
        "lease_token_hash",
        "lease_expires_at",
        "attempts",
        "revised_version_id",
        "completed_at",
        "created_at",
        "updated_at"
      ])
    );
    expect(config.indexes.map((item) => item.config.name)).toEqual(
      expect.arrayContaining([
        "knowledge_review_run_version_hash_prompt_phase_unique",
        "knowledge_review_run_lease_idx",
        "knowledge_review_run_revised_version_idx"
      ])
    );
    const phaseIndex = config.indexes.find(
      (item) =>
        item.config.name ===
        "knowledge_review_run_version_hash_prompt_phase_unique"
    );
    expect(phaseIndex?.config.unique).toBe(true);
    expect(
      phaseIndex?.config.columns.map((column) =>
        "name" in column ? column.name : null
      )
    ).toEqual([
      "input_version_id",
      "input_content_hash",
      "prompt_version",
      "phase"
    ]);
    expect(config.checks.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "knowledge_review_run_hashes_valid",
        "knowledge_review_run_attempts_valid",
        "knowledge_review_run_lease_valid",
        "knowledge_review_run_completion_valid"
      ])
    );

    expect(knowledgeSchema.knowledgeReviewSection).toBe(knowledgeReviewSection);
    expect(knowledgeSchema.knowledgeSectionDecision).toBe(
      knowledgeSectionDecision
    );
  });

  it("re-exports the additive knowledge schema from the root schema", () => {
    expect(rootSchema).toHaveProperty("knowledgeOriginal");
    expect(rootSchema).toHaveProperty("knowledgeReviewRun");
  });

  it("ships an additive executable migration with a literal size limit", () => {
    const migration = readFileSync(
      new URL(
        "../../../../drizzle/0013_talented_human_torch.sql",
        import.meta.url
      ),
      "utf8"
    );

    expect(migration).toContain('CREATE TABLE "knowledge_original"');
    expect(migration).toContain('CREATE TABLE "knowledge_review_run"');
    expect(migration).toContain("52428800");
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "knowledge_review_run_version_hash_prompt_phase_unique"'
    );
    expect(migration).not.toContain("$1");
    expect(migration).not.toContain('ALTER TABLE "knowledge_review_section"');
    expect(migration).not.toContain('ALTER TABLE "knowledge_section_decision"');
  });
});
