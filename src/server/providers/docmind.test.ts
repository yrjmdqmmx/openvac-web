import { describe, expect, it } from "vitest";

import {
  assertAllowedDocumentUrl,
  assertTrustedPrivateOssUrl,
  normalizeDocMindStatus
} from "./docmind";

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

  it("accepts only signed public Alibaba OSS URLs from private storage", () => {
    expect(() =>
      assertTrustedPrivateOssUrl(
        "https://openvac-private.oss-cn-hangzhou.aliyuncs.com/chat/manual.pdf?x-oss-signature-version=OSS4-HMAC-SHA256&x-oss-credential=redacted&x-oss-date=20260811T001700Z&x-oss-expires=900&x-oss-signature=redacted"
      )
    ).not.toThrow();

    for (const value of [
      "https://openvac-private.oss-cn-hangzhou.aliyuncs.com/chat/manual.pdf",
      "https://openvac-private.oss-cn-hangzhou-internal.aliyuncs.com/chat/manual.pdf?x-oss-signature=redacted",
      "https://oss.attacker.example/chat/manual.pdf?x-oss-signature=redacted",
      "http://openvac-private.oss-cn-hangzhou.aliyuncs.com/chat/manual.pdf?x-oss-signature=redacted"
    ]) {
      expect(() => assertTrustedPrivateOssUrl(value)).toThrow();
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
