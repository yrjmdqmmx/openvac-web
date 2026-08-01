import { describe, expect, it } from "vitest";

import {
  problemReportContactPurgeAt,
  problemReportRetentionUntil
} from "./retention";

describe("problem report retention deadlines", () => {
  it("retains a report for 180 days from creation", () => {
    expect(
      problemReportRetentionUntil(new Date("2026-08-01T00:00:00.000Z"))
    ).toEqual(new Date("2027-01-28T00:00:00.000Z"));
  });

  it("schedules contact deletion 30 days after closure", () => {
    expect(
      problemReportContactPurgeAt(new Date("2026-08-01T00:00:00.000Z"))
    ).toEqual(new Date("2026-08-31T00:00:00.000Z"));
  });
});
