import { describe, expect, it } from "vitest";

import { parseKnowledgeCandidate } from "./candidate-schema";
import {
  buildPendingReviewActivationMetadata,
  buildProvisionalKnowledgeChunks
} from "./provisional-activation";

const hash = "1".repeat(64);
const candidate = parseKnowledgeCandidate({
  sourceCanonicalUrl: "https://example.com/source",
  document: {
    externalKey: "test",
    title: "测试知识",
    description: "用于验证待人工复核知识激活流程。",
    language: "zh-CN",
    mimeType: "application/json",
    tags: ["测试"]
  },
  citation: { ingestionMode: "full_text", licenseClass: "open" },
  review: { status: "required", requirements: ["后续人工复核"] },
  sections: [
    {
      pageStart: 3,
      pageEnd: 4,
      sectionPath: ["基础", "流导"],
      keywords: ["流导"],
      content:
        "流导描述真空管路在给定流态下传输气体的能力，必须结合几何尺寸、气体种类、温度、压力范围和边界条件使用，不能脱离工况直接套用。"
    }
  ]
});

describe("provisional knowledge activation", () => {
  it("creates retrieval chunks while retaining pending-review metadata", () => {
    const chunks = buildProvisionalKnowledgeChunks(candidate);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      pageStart: 3,
      pageEnd: 4,
      sectionPath: ["基础", "流导"],
      metadata: {
        reviewStatus: "required",
        retrievalStatus: "active_pending_review"
      }
    });
    expect(chunks[0]?.content).toContain("不能脱离工况直接套用");
  });

  it("pins provisional activation to the exact content hash", () => {
    expect(
      buildPendingReviewActivationMetadata({
        contentHash: hash,
        embeddingStatus: "completed",
        embeddingModel: "text-embedding-v4",
        embeddedChunkCount: 1,
        activatedAt: new Date("2026-08-04T00:00:00.000Z"),
        sourcePath: "knowledge/test.json"
      })
    ).toMatchObject({
      reviewStatus: "required",
      retrievalStatus: "active_pending_review",
      retrievalContentHash: hash,
      embeddingStatus: "completed",
      humanTechnicalReviewRequired: true
    });
  });
});
