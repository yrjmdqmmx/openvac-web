import { describe, expect, it } from "vitest";

import {
  problemReportClosureTransition,
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

  it("preserves the original contact-purge deadline on repeated closure", () => {
    const closedAt = new Date("2026-08-01T00:00:00.000Z");
    const contactPurgeAt = new Date("2026-08-31T00:00:00.000Z");

    expect(
      problemReportClosureTransition({
        previousStatus: "closed",
        previousClosedAt: closedAt,
        previousContactPurgeAt: contactPurgeAt,
        nextStatus: "closed",
        now: new Date("2026-08-20T00:00:00.000Z")
      })
    ).toEqual({ closedAt, contactPurgeAt });
  });

  it("starts a new purge window only on a transition into closed", () => {
    const now = new Date("2026-08-20T00:00:00.000Z");

    expect(
      problemReportClosureTransition({
        previousStatus: "reviewing",
        previousClosedAt: null,
        previousContactPurgeAt: null,
        nextStatus: "closed",
        now
      })
    ).toEqual({
      closedAt: now,
      contactPurgeAt: new Date("2026-09-19T00:00:00.000Z")
    });
  });
});
