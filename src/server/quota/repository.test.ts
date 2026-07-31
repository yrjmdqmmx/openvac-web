import { describe, expect, it } from "vitest";

import { reconcileQuotaBucketLimit } from "./repository";

describe("reconcileQuotaBucketLimit", () => {
  it("tightens an existing bucket when the current policy is lowered", () => {
    expect(
      reconcileQuotaBucketLimit({
        policyLimit: 20,
        reservedUnits: 2,
        committedUnits: 3
      })
    ).toBe(20);
  });

  it("never lowers the bucket below already reserved and committed usage", () => {
    expect(
      reconcileQuotaBucketLimit({
        policyLimit: 20,
        reservedUnits: 4,
        committedUnits: 21
      })
    ).toBe(25);
  });

  it("raises the bucket immediately when the current policy increases", () => {
    expect(
      reconcileQuotaBucketLimit({
        policyLimit: 30,
        reservedUnits: 0,
        committedUnits: 5
      })
    ).toBe(30);
  });
});
