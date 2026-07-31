import { describe, expect, it } from "vitest";

import { citationSourcePolicy } from "./citation-policy";

describe("server citation display policy", () => {
  it("explicitly allows a public HTTPS authority hostname", () => {
    expect(
      citationSourcePolicy(
        "https://www.nist.gov/publications/example",
        "public_domain",
        "nist.gov"
      )
    ).toEqual({
      linkAllowed: true,
      authoritative: true,
      allowedDomains: ["www.nist.gov"]
    });
  });

  it("blocks unlisted, credentialed, and private source links", () => {
    expect(
      citationSourcePolicy(
        "https://nist.gov.attacker.example/manual",
        "open",
        "nist.gov"
      )
    ).toBe("blocked");
    expect(
      citationSourcePolicy("https://user@nist.gov/manual", "open", "nist.gov")
    ).toBe("blocked");
    expect(
      citationSourcePolicy(
        "https://private.example/manual",
        "private_authorized",
        "private.example"
      )
    ).toBe("blocked");
  });
});
