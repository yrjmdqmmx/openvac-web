import { describe, expect, it } from "vitest";

import { pointDistanceMillimeters } from "./measurement";

describe("pointDistanceMillimeters", () => {
  it("removes the viewport fit scale from a world-space distance", () => {
    expect(pointDistanceMillimeters([0, 0, 0], [3, 4, 0], 20)).toBe(100);
  });

  it("rejects an unavailable or invalid scale", () => {
    expect(() => pointDistanceMillimeters([0, 0, 0], [1, 0, 0], 0)).toThrow(
      "测量比例必须是正有限数"
    );
  });
});
