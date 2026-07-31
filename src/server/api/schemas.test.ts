import { describe, expect, it } from "vitest";

import {
  adminRoleMutationSchema,
  budgetsSchema,
  consultationSchema,
  knowledgeDraftSchema,
  knowledgeDraftUpdateSchema,
  sourceSchema,
  sourceUpdateSchema,
  userBanSchema
} from "./schemas";

describe("API validation schemas", () => {
  it("requires explicit consultation confirmation", () => {
    const base = {
      confirmed: false,
      contactName: "王工",
      companyName: "示例真空",
      contactMethod: "phone",
      contactValue: "13800000000",
      problem: "旋片泵在启动阶段出现持续异响，需要工程师确认。",
      conversationSummary: "用户已经检查油位和电源，问题仍然存在。"
    };

    expect(consultationSchema.safeParse(base).success).toBe(false);
    expect(
      consultationSchema.safeParse({ ...base, confirmed: true }).success
    ).toBe(true);
    expect(
      consultationSchema.safeParse({
        ...base,
        confirmed: true,
        contactMethod: "email",
        contactValue: "not-an-email"
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
      name: "CERN Document Server",
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
