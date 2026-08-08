import { describe, expect, it } from "vitest";

import {
  existingSeedSourcePatch,
  mergeSeedSourceMetadata
} from "./source-metadata";

describe("seed source metadata merge", () => {
  it("adds a manifest rights decision to a new source", () => {
    const rightsDecision = {
      status: "approved",
      scope: "full_text",
      appliesToRecordUrl: "https://cds.cern.ch/record/2929324"
    };

    expect(
      mergeSeedSourceMetadata(undefined, { sourceKey: "cern", rightsDecision })
    ).toEqual({ sourceKey: "cern", rightsDecision });
  });

  it("does not overwrite a manually recorded rights decision", () => {
    const manualDecision = {
      status: "rejected",
      scope: "metadata_only",
      appliesToRecordUrl: "https://example.com/record",
      reviewedBy: "human-reviewer"
    };

    expect(
      mergeSeedSourceMetadata(
        { rightsDecision: manualDecision, manualNote: "keep" },
        {
          sourceKey: "source",
          rightsDecision: {
            status: "approved",
            scope: "full_text",
            appliesToRecordUrl: "https://example.com/record"
          }
        }
      )
    ).toMatchObject({
      sourceKey: "source",
      manualNote: "keep",
      rightsDecision: manualDecision
    });
  });

  it("limits existing-source seed updates to metadata and timestamp", () => {
    const updatedAt = new Date("2026-08-08T00:00:00.000Z");
    const patch = existingSeedSourcePatch({
      existingMetadata: { rightsDecision: { status: "rejected" } },
      seededMetadata: { sourceKey: "cern" },
      updatedAt
    });

    expect(patch).toEqual({
      metadata: {
        sourceKey: "cern",
        rightsDecision: { status: "rejected" }
      },
      updatedAt
    });
    expect(patch).not.toHaveProperty("enabled");
    expect(patch).not.toHaveProperty("sourceTier");
    expect(patch).not.toHaveProperty("licensePolicy");
  });
});
