import { describe, expect, it } from "vitest";
import { resolveSafeReturnTo } from "@/lib/safe-return-to";

describe("resolveSafeReturnTo", () => {
  it.each([
    ["/chat", "/chat"],
    ["/chat?conversation=abc#latest", "/chat?conversation=abc#latest"],
    ["/settings", "/settings"]
  ])("keeps a same-origin path", (input, expected) => {
    expect(resolveSafeReturnTo(input)).toBe(expected);
  });

  it.each([
    null,
    "",
    "chat",
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/%5cevil.example",
    "%2f%2fevil.example",
    "/%2f%2fevil.example",
    "%252f%252fevil.example",
    "/%255cevil.example",
    "/chat\u0000",
    "/chat%"
  ])("falls back for unsafe input %#", (input) => {
    expect(resolveSafeReturnTo(input)).toBe("/chat");
  });

  it("fails closed when an input remains encoded past the decode limit", () => {
    let deeplyEncoded = "//evil.example";
    for (let depth = 0; depth < 6; depth += 1) {
      deeplyEncoded = encodeURIComponent(deeplyEncoded);
    }

    expect(resolveSafeReturnTo(`/${deeplyEncoded}`)).toBe("/chat");
  });
});
