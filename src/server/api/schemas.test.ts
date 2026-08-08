import { describe, expect, it } from "vitest";

import {
  adminRoleMutationSchema,
  budgetsSchema,
  knowledgeDraftSchema,
  knowledgeDraftUpdateSchema,
  knowledgeSectionDecisionSchema,
  knowledgeSectionReviewCompleteSchema,
  problemReportSchema,
  promptUpdateSchema,
  knowledgeReviewSchema,
  sourceSchema,
  sourceUpdateSchema,
  userBanSchema
} from "./schemas";

describe("API validation schemas", () => {
  it("validates problem-report context and contact consent independently", () => {
    const base = {
      clientRequestId: "b607d4d6-82df-4f1b-a5d4-7d80277e327d",
      category: "answer_incorrect" as const,
      description: "回答中的极限压力单位不正确。"
    };

    expect(problemReportSchema.parse(base)).toMatchObject({
      clientRequestId: "b607d4d6-82df-4f1b-a5d4-7d80277e327d",
      includeContext: false,
      consentToContact: false
    });
    expect(
      problemReportSchema.safeParse({
        ...base,
        clientRequestId: "not-a-request-id"
      }).success
    ).toBe(false);
    expect(
      problemReportSchema.safeParse({
        ...base,
        contactType: "email",
        contactValue: "engineer@example.com"
      }).success
    ).toBe(false);
    expect(
      problemReportSchema.safeParse({
        ...base,
        contactType: "email",
        contactValue: "engineer@example.com",
        consentToContact: true
      }).success
    ).toBe(true);
    expect(
      problemReportSchema.safeParse({ ...base, includeContext: true }).success
    ).toBe(false);
    expect(
      problemReportSchema.safeParse({
        ...base,
        includeContext: true,
        conversationId: "d607d4d6-82df-4f1b-a5d4-7d80277e327d"
      }).success
    ).toBe(true);
    expect(
      problemReportSchema.safeParse({
        ...base,
        description: "x".repeat(3001)
      }).success
    ).toBe(false);
  });

  it("requires a reason when banning a user", () => {
    expect(userBanSchema.safeParse({ banned: true }).success).toBe(false);
    expect(
      userBanSchema.safeParse({ banned: true, reason: "重复滥用服务" }).success
    ).toBe(true);
    expect(userBanSchema.safeParse({ banned: false }).success).toBe(true);
  });

  it("accepts only absolute source whitelist URLs", () => {
    const base = {
      kind: "manual",
      name: "CERN Document Server",
      publisher: "CERN",
      canonicalUrl: "https://cds.cern.ch/record/2929324?ln=en",
      sourceTier: "open_license",
      licensePolicy: "逐份核验开放许可",
      enabled: true
    };

    expect(
      sourceSchema.safeParse({ ...base, baseUrl: "/relative" }).success
    ).toBe(false);
    expect(
      sourceSchema.safeParse({ ...base, baseUrl: "https://cds.cern.ch/" })
        .success
    ).toBe(true);
    expect(
      sourceSchema.safeParse({
        ...base,
        baseUrl: "https://cds.cern.ch/",
        rightsDecision: {
          status: "approved",
          scope: "full_text",
          basis: "This exact record is published under CC BY 4.0.",
          evidenceUrl: "https://cds.cern.ch/record/2929324?ln=en",
          appliesToRecordUrl: "https://cds.cern.ch/record/another"
        }
      }).success
    ).toBe(false);
  });

  it("defaults knowledge drafts to full-text ingestion for policy enforcement", () => {
    const parsed = knowledgeDraftSchema.parse({
      title: "真空基础",
      content: "知识正文",
      citationMetadata: {}
    });

    expect(parsed.ingestionMode).toBe("full_text");
  });

  it("does not inject create defaults into partial updates", () => {
    expect(knowledgeDraftUpdateSchema.parse({ title: "新标题" })).toEqual({
      title: "新标题"
    });
    expect(sourceUpdateSchema.parse({ name: "新来源名" })).toEqual({
      name: "新来源名"
    });
  });

  it("allows only explicit prompt lifecycle transitions on an existing version", () => {
    expect(promptUpdateSchema.parse({ status: "active" })).toEqual({
      status: "active"
    });
    expect(promptUpdateSchema.parse({ status: "archived" })).toEqual({
      status: "archived"
    });
    expect(
      promptUpdateSchema.safeParse({ content: "覆盖已有版本" }).success
    ).toBe(false);
    expect(
      promptUpdateSchema.safeParse({ notes: "原地修改备注" }).success
    ).toBe(false);
    expect(promptUpdateSchema.safeParse({ status: "draft" }).success).toBe(
      false
    );
  });

  it("requires a review note when knowledge is rejected", () => {
    const base = {
      versionId: "cb71f682-9bdc-4899-b7b3-c459402b192c",
      expectedContentHash: "a".repeat(64)
    };

    expect(knowledgeReviewSchema.parse(base).decision).toBe("approved");
    expect(
      knowledgeReviewSchema.safeParse({ ...base, decision: "rejected" }).success
    ).toBe(false);
    expect(
      knowledgeReviewSchema.safeParse({
        ...base,
        decision: "rejected",
        note: "缺少来源页码，退回补充。"
      }).success
    ).toBe(true);
  });

  it("requires notes for rejected or change-requested sections", () => {
    const base = {
      expectedSectionHash: "a".repeat(64),
      expectedRevision: 0
    };

    expect(
      knowledgeSectionDecisionSchema.safeParse({
        ...base,
        decision: "approved"
      }).success
    ).toBe(true);
    expect(
      knowledgeSectionDecisionSchema.safeParse({
        ...base,
        decision: "rejected"
      }).success
    ).toBe(false);
    expect(
      knowledgeSectionDecisionSchema.safeParse({
        ...base,
        decision: "changes_requested",
        note: "中文段落与原文含义不一致。"
      }).success
    ).toBe(true);
  });

  it("pins complete-review to the exact version and content hash", () => {
    expect(
      knowledgeSectionReviewCompleteSchema.parse({
        versionId: "cb71f682-9bdc-4899-b7b3-c459402b192c",
        expectedContentHash: "b".repeat(64)
      })
    ).toEqual({
      versionId: "cb71f682-9bdc-4899-b7b3-c459402b192c",
      expectedContentHash: "b".repeat(64)
    });
  });

  it("rejects duplicate model budget entries", () => {
    const budget = {
      model: "deepseek-v4-pro",
      dailyLimitCents: 1000,
      monthlyLimitCents: 20_000,
      enabled: true
    };

    expect(budgetsSchema.safeParse({ budgets: [budget, budget] }).success).toBe(
      false
    );
  });

  it("accepts only persisted administrator roles", () => {
    expect(
      adminRoleMutationSchema.safeParse({
        userId: "user-2",
        role: "support"
      }).success
    ).toBe(true);
    expect(
      adminRoleMutationSchema.safeParse({
        userId: "user-2",
        role: "superuser"
      }).success
    ).toBe(false);
  });
});
