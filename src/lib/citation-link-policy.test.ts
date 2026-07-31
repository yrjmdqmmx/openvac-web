import { describe, expect, it } from "vitest";
import { evaluateCitationLink } from "./citation-link-policy";

const authoritativePolicy = {
  linkAllowed: true,
  authoritative: true,
  allowedDomains: ["nist.gov"]
} as const;

describe("evaluateCitationLink", () => {
  it("allows an explicitly approved HTTPS hostname and its subdomains", () => {
    expect(
      evaluateCitationLink({
        url: "https://www.nist.gov/publication?id=42",
        sourcePolicy: authoritativePolicy
      })
    ).toEqual({
      allowed: true,
      authoritative: true,
      href: "https://www.nist.gov/publication?id=42"
    });
  });

  it("distinguishes a permitted reference from an authoritative source", () => {
    expect(
      evaluateCitationLink({
        url: "https://docs.example.com/manual",
        sourcePolicy: {
          linkAllowed: true,
          authoritative: false,
          allowedDomains: ["example.com"]
        }
      })
    ).toMatchObject({ allowed: true, authoritative: false });
  });

  it.each([
    "https://nist.gov.evil.example/manual",
    "https://user@nist.gov/manual",
    "http://nist.gov/manual",
    "//nist.gov/manual",
    String.raw`https:\nist.gov\manual`,
    " https://nist.gov/manual",
    "https://nist.gov/\nmanual"
  ])("rejects unsafe or bypass-shaped URL %s", (url) => {
    expect(
      evaluateCitationLink({ url, sourcePolicy: authoritativePolicy })
    ).toEqual({ allowed: false, authoritative: false });
  });

  it("fails closed when the server omits its source policy or allowlist", () => {
    expect(
      evaluateCitationLink({
        url: "https://nist.gov/manual"
      })
    ).toEqual({ allowed: false, authoritative: false });
    expect(
      evaluateCitationLink({
        url: "https://nist.gov/manual",
        sourcePolicy: { linkAllowed: true, authoritative: true }
      })
    ).toEqual({ allowed: false, authoritative: false });
  });

  it("accepts the compact server policy with a separate allowlist", () => {
    expect(
      evaluateCitationLink({
        url: "https://nist.gov/manual",
        sourcePolicy: "authoritative",
        allowedDomains: ["nist.gov"]
      })
    ).toMatchObject({ allowed: true, authoritative: true });
  });

  it("rejects malformed allowlist entries instead of interpreting them", () => {
    expect(
      evaluateCitationLink({
        url: "https://nist.gov/manual",
        sourcePolicy: {
          linkAllowed: true,
          authoritative: true,
          allowedDomains: ["*.nist.gov", "https://nist.gov"]
        }
      })
    ).toEqual({ allowed: false, authoritative: false });
  });
});
