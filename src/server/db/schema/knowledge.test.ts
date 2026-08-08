import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  knowledgeChunk,
  knowledgeReviewSection,
  knowledgeSectionDecision,
  knowledgeStatus,
  knowledgeVersion
} from "./knowledge";

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
});
