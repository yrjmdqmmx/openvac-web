import { describe, expect, it } from "vitest";

import {
  answerV3Schema,
  inputMessagePartsSchema,
  normalizeStoredMessageParts
} from "./contracts";

describe("Agent V3 shared contracts", () => {
  it("accepts text, verified-link candidates, and up to five attachments", () => {
    const parts = [
      { type: "text", text: "分析这些资料" },
      { type: "link", url: "https://www.cern.ch/", label: "CERN" },
      ...Array.from({ length: 5 }, (_, index) => ({
        type: "attachment",
        attachmentId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
      }))
    ];
    expect(inputMessagePartsSchema.safeParse(parts).success).toBe(true);
  });

  it("rejects an attachment count above the public limit", () => {
    const parts = Array.from({ length: 6 }, (_, index) => ({
      type: "attachment",
      attachmentId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
    }));
    expect(inputMessagePartsSchema.safeParse(parts).success).toBe(false);
  });

  it("rejects duplicate attachment refs and cumulative text overflow", () => {
    const attachmentId = "00000000-0000-4000-8000-000000000001";
    expect(
      inputMessagePartsSchema.safeParse([
        { type: "attachment", attachmentId },
        { type: "attachment", attachmentId }
      ]).success
    ).toBe(false);
    expect(
      inputMessagePartsSchema.safeParse([
        { type: "text", text: "甲".repeat(9_000) },
        { type: "text", text: "乙".repeat(9_000) }
      ]).success
    ).toBe(false);
  });

  it("rejects unverified protocols", () => {
    expect(
      inputMessagePartsSchema.safeParse([
        { type: "link", url: "http://127.0.0.1/admin" }
      ]).success
    ).toBe(false);
  });

  it("rejects signed or token-bearing URLs before persistence", () => {
    expect(
      inputMessagePartsSchema.safeParse([
        {
          type: "link",
          url: "https://example.com/private?X-Amz-Signature=secret"
        }
      ]).success
    ).toBe(false);
  });

  it("accepts adaptive direct answers without empty fixed sections", () => {
    expect(
      answerV3Schema.safeParse({
        schemaVersion: "openvac.answer.v3",
        answerKind: "direct",
        riskLevel: "low",
        blocks: [
          {
            type: "paragraph",
            text: "真空是低于环境压力的气体状态。",
            evidenceIds: []
          }
        ],
        missingInputs: [],
        usedEvidenceIds: [],
        usedLinkIds: []
      }).success
    ).toBe(true);
  });

  it("adapts legacy content into one text part", () => {
    expect(normalizeStoredMessageParts("旧回答", null)).toEqual([
      { type: "text", text: "旧回答" }
    ]);
  });
});
