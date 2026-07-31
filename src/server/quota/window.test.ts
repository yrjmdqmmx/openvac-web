import { describe, expect, it } from "vitest";

import { shanghaiDailyWindow } from "./window";

describe("shanghaiDailyWindow", () => {
  it("uses the Asia/Shanghai calendar day", () => {
    const beforeMidnight = shanghaiDailyWindow(
      new Date("2026-07-31T15:59:59.999Z")
    );
    const afterMidnight = shanghaiDailyWindow(
      new Date("2026-07-31T16:00:00.000Z")
    );

    expect(beforeMidnight.key).toBe("2026-07-31");
    expect(beforeMidnight.resetAt.toISOString()).toBe(
      "2026-07-31T16:00:00.000Z"
    );
    expect(afterMidnight.key).toBe("2026-08-01");
    expect(afterMidnight.resetAt.toISOString()).toBe(
      "2026-08-01T16:00:00.000Z"
    );
  });

  it("rejects invalid dates", () => {
    expect(() => shanghaiDailyWindow(new Date("invalid"))).toThrow(
      /must be valid/
    );
  });
});
