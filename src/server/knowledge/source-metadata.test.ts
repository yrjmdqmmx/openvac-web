import { describe, expect, it } from "vitest";

import { mergeSeedSourceMetadata } from "./source-metadata";

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
});
