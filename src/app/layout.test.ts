import { describe, expect, it } from "vitest";

import { metadata } from "./layout";

describe("root metadata", () => {
  it("keeps the public metadata base independent from build-time localhost values", () => {
    expect(metadata.metadataBase?.toString()).toBe("https://openvac.cn/");
    expect(metadata.icons).toBeNull();
  });
});
