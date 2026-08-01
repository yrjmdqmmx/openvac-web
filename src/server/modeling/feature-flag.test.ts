import { describe, expect, it } from "vitest";

import { isModelingEnabled } from "./feature-flag";

describe("modeling feature flag", () => {
  it("fails closed in production when it is not configured", () => {
    expect(isModelingEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  it("can be explicitly enabled after acceptance", () => {
    expect(
      isModelingEnabled({
        NODE_ENV: "production",
        MODELING_ENABLED: "true"
      })
    ).toBe(true);
  });

  it("keeps local development and tests usable by default", () => {
    expect(isModelingEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(isModelingEnabled({ NODE_ENV: "test" })).toBe(true);
  });
});
