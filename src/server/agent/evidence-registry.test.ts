import { describe, expect, it } from "vitest";

import { EvidenceRegistry } from "./evidence-registry";

describe("EvidenceRegistry verified web links", () => {
  it("exposes only the server-bound link id and hostname to the model", () => {
    const registry = new EvidenceRegistry();
    const evidenceId = registry.add(
      {
        citation: {
          sourceId: "web:manufacturer-manual",
          title: "Manufacturer manual",
          publisher: "Leybold",
          url: "https://www.leybold.com/manual",
          fetchedAt: new Date("2026-08-09T00:00:00.000Z"),
          licenseClass: "metadata_only"
        },
        excerpt: "Foreline pressure must be checked against the pump model."
      },
      {
        trustTier: "tier_a",
        reviewStatus: "runtime_verified",
        runtimeValidated: true
      }
    );

    expect(evidenceId).toBe("E1");
    registry.bindVerifiedLink(evidenceId!, "W1", "www.leybold.com");

    expect(registry.modelIndex()).toEqual([
      expect.objectContaining({
        evidenceId: "E1",
        linkId: "W1",
        linkHostname: "www.leybold.com"
      })
    ]);
  });
});
