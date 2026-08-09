import { describe, expect, it } from "vitest";

import { parsePublicHttpsUrl } from "./public-url";

describe("public verified-link URLs", () => {
  it.each([
    "https://example.com/manual?token=secret",
    "https://example.com/manual?Signature=secret",
    "https://example.com/manual?X-Amz-Credential=secret",
    "https://example.com/manual?x-oss-signature=secret"
  ])("rejects a sensitive query parameter in %s", (value) => {
    expect(parsePublicHttpsUrl(value)).toBeUndefined();
  });

  it("normalizes a public HTTPS URL consistently for live and stored links", () => {
    expect(
      parsePublicHttpsUrl(
        "https://docs.example.com:443/manual?lang=zh#section",
        "docs.example.com"
      )?.href
    ).toBe("https://docs.example.com/manual?lang=zh");
  });
});
