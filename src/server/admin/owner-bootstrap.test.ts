import { describe, expect, it } from "vitest";

import {
  assertOwnerBootstrapUserEligible,
  resolveOwnerBootstrapEmail
} from "./owner-bootstrap";

describe("owner bootstrap", () => {
  it("prefers and normalizes an explicit email argument", () => {
    expect(
      resolveOwnerBootstrapEmail([" OWNER@Example.com "], {
        ADMIN_BOOTSTRAP_EMAIL: "ignored@example.com"
      })
    ).toEqual({ email: "owner@example.com", source: "argument" });
  });

  it("falls back to ADMIN_BOOTSTRAP_EMAIL", () => {
    expect(
      resolveOwnerBootstrapEmail([], {
        ADMIN_BOOTSTRAP_EMAIL: "owner@example.com"
      })
    ).toEqual({ email: "owner@example.com", source: "environment" });
  });

  it("rejects missing, invalid, or ambiguous email arguments", () => {
    expect(() => resolveOwnerBootstrapEmail([], {})).toThrow("缺少 owner 邮箱");
    expect(() => resolveOwnerBootstrapEmail(["not-an-email"], {})).toThrow();
    expect(() =>
      resolveOwnerBootstrapEmail(["one@example.com", "two@example.com"], {})
    ).toThrow("用法");
  });

  it("allows only verified, active users", () => {
    expect(() =>
      assertOwnerBootstrapUserEligible({
        id: "verified-user",
        emailVerified: true,
        banned: false
      })
    ).not.toThrow();
    expect(() =>
      assertOwnerBootstrapUserEligible({
        id: "unverified-user",
        emailVerified: false,
        banned: false
      })
    ).toThrow("已完成邮箱验证");
    expect(() =>
      assertOwnerBootstrapUserEligible({
        id: "banned-user",
        emailVerified: true,
        banned: true
      })
    ).toThrow("已停用");
  });
});
