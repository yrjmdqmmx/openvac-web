import { describe, expect, it } from "vitest";

import { POST as claim } from "./claims/route";
import { GET as getPackage } from "./jobs/[id]/package/route";
import { POST as submitResult } from "./jobs/[id]/result/route";

describe("internal knowledge review routes", () => {
  it("exposes only the claim, package, and result handlers", () => {
    expect(claim).toBeTypeOf("function");
    expect(getPackage).toBeTypeOf("function");
    expect(submitResult).toBeTypeOf("function");
  });
});
