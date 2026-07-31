import { describe, expect, it } from "vitest";

import { buildAuthEmail } from "./email";

describe("buildAuthEmail", () => {
  it("uses the original Better Auth URL without exposing a separate token", () => {
    const url =
      "https://openvac.example/api/auth/verify-email?token=secret&callbackURL=%2Fchat";
    const email = buildAuthEmail("verify-email", url);

    expect(email.subject).toContain("验证");
    expect(email.text).toContain(url);
    expect(email.html).toContain("token=secret&amp;callbackURL=");
    expect(email.html).not.toContain('href="javascript:');
  });

  it("rejects non-web protocols", () => {
    expect(() =>
      buildAuthEmail("reset-password", "javascript:alert(1)")
    ).toThrow(/HTTP or HTTPS/);
  });

  it("provides Chinese copy for all account actions", () => {
    const url = "https://openvac.example/action";

    expect(buildAuthEmail("verify-email", url).text).toContain("邮箱");
    expect(buildAuthEmail("reset-password", url).text).toContain("密码");
    expect(buildAuthEmail("delete-account", url).text).toContain("删除");
  });
});
