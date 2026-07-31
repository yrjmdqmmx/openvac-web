import { describe, expect, it } from "vitest";

import { assertAllowedDocumentUrl, normalizeDocMindStatus } from "./docmind";

describe("DocMind input boundaries", () => {
  const allowedHosts = new Set([
    "openvac-private.oss-cn-hangzhou.aliyuncs.com"
  ]);

  it("accepts only exact HTTPS document hosts", () => {
    expect(() =>
      assertAllowedDocumentUrl(
        "https://openvac-private.oss-cn-hangzhou.aliyuncs.com/knowledge-originals/manual.pdf?signature=redacted",
        allowedHosts
      )
    ).not.toThrow();

    for (const value of [
      "http://openvac-private.oss-cn-hangzhou.aliyuncs.com/manual.pdf",
      "https://openvac-private.oss-cn-hangzhou.aliyuncs.com:8443/manual.pdf",
      "https://user:secret@openvac-private.oss-cn-hangzhou.aliyuncs.com/manual.pdf",
      "https://openvac-private.oss-cn-hangzhou.aliyuncs.com.attacker.example/manual.pdf"
    ]) {
      expect(() => assertAllowedDocumentUrl(value, allowedHosts)).toThrow(
        /allowlist/u
      );
    }
  });

  it("fails closed for missing or unknown provider statuses", () => {
    expect(normalizeDocMindStatus("running")).toBe("processing");
    expect(normalizeDocMindStatus("finished")).toBe("succeeded");
    expect(() => normalizeDocMindStatus("mystery-state")).toThrow(
      /unknown task status/u
    );
  });
});
