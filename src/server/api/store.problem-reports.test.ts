import { describe, expect, it } from "vitest";

import { serializeProblemReportContextMessages } from "./store";

describe("problem-report context snapshots", () => {
  it("orders equal-timestamp messages by their conversation sequence", () => {
    const createdAt = new Date("2026-08-01T00:00:00.000Z");

    expect(
      serializeProblemReportContextMessages([
        {
          id: "00000000-0000-4000-8000-000000000001",
          role: "assistant",
          content: "回答",
          sequence: 2,
          createdAt
        },
        {
          id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          role: "user",
          content: "问题",
          sequence: 1,
          createdAt
        }
      ])
    ).toEqual([
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        role: "user",
        content: "问题",
        createdAt: createdAt.toISOString()
      },
      {
        id: "00000000-0000-4000-8000-000000000001",
        role: "assistant",
        content: "回答",
        createdAt: createdAt.toISOString()
      }
    ]);
  });
});
