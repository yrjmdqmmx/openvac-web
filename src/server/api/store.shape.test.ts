import { describe, expect, it } from "vitest";

import { promptAdminTableShape, sourceAdminTableShape } from "./store";

describe("generic administrator table shapes", () => {
  it("normalizes source publisher, domain, and license fields", () => {
    expect(
      sourceAdminTableShape({
        id: "source-1",
        name: "OpenVac manual",
        publisher: null,
        baseUrl: "https://docs.example.com/pumps",
        licensePolicy: "metadata-only",
        sourceTier: "manufacturer_metadata"
      })
    ).toMatchObject({
      id: "source-1",
      publisher: "OpenVac manual",
      domain: "docs.example.com",
      licenseClass: "metadata-only"
    });
  });

  it("normalizes prompt key and evaluation fields", () => {
    expect(
      promptAdminTableShape({
        id: "prompt-1",
        key: "expert.answer",
        version: 3
      })
    ).toMatchObject({
      id: "prompt-1",
      name: "expert.answer",
      version: 3,
      evaluationScore: null
    });
  });
});
