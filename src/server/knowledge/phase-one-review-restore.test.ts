import { describe, expect, it } from "vitest";

import {
  PHASE_ONE_CANDIDATE_ENTRIES,
  PHASE_ONE_SOURCE_MANIFEST
} from "./phase-one-catalog";
import {
  assertLegacyPhaseOneAdoption,
  assertPhaseOneReviewRestoreAuthorized,
  buildPhaseOneReviewRestorePlan
} from "./phase-one-review-restore";

describe("Phase 1 review restore plan", () => {
  it("restores seven governed documents as 66 unapproved review sections", () => {
    const plan = buildPhaseOneReviewRestorePlan({
      candidates: PHASE_ONE_CANDIDATE_ENTRIES,
      sources: PHASE_ONE_SOURCE_MANIFEST,
      sourceIdForUrl: (url) => `source-${Buffer.from(url).toString("hex")}`
    });

    expect(plan.documents).toHaveLength(7);
    expect(
      plan.documents.every((document) => document.status === "review")
    ).toBe(true);
    expect(
      plan.documents.flatMap((document) => document.sections)
    ).toHaveLength(66);
    expect(
      plan.documents
        .flatMap((document) => document.sections)
        .every(
          (section) =>
            section.reviewStatus === "required" && section.decision === null
        )
    ).toBe(true);
    expect(
      plan.documents.every((document) => document.chunks.length === 0)
    ).toBe(true);
  });

  it("keeps the CERN 2014 binary recheck in the restored citation evidence", () => {
    const cern2014Source = PHASE_ONE_SOURCE_MANIFEST.find(
      (source) =>
        source.sourceKey === "cern-vacuum-superconducting-devices-2014"
    );
    expect(cern2014Source).toMatchObject({
      officialPublishedPdfBinaryRequired: true
    });
    const plan = buildPhaseOneReviewRestorePlan({
      candidates: PHASE_ONE_CANDIDATE_ENTRIES,
      sources: PHASE_ONE_SOURCE_MANIFEST,
      sourceIdForUrl: (url) => `source-${Buffer.from(url).toString("hex")}`
    });
    const cern2014 = plan.documents.find((document) =>
      document.externalKey.includes("vacuum-superconducting-devices")
    );
    const verification = cern2014?.citationMetadata.excerptVerification as
      Record<string, unknown> | undefined;

    expect(verification?.officialPublishedPdfBinaryStatus).toBe(
      "pending_anubis_recheck"
    );
    expect(cern2014?.metadata.reviewStatus).toBe("required");
    expect(cern2014?.metadata.embeddingStatus).toBe("pending_review");
  });

  it("fails closed when a governed source is missing", () => {
    expect(() =>
      buildPhaseOneReviewRestorePlan({
        candidates: PHASE_ONE_CANDIDATE_ENTRIES,
        sources: [],
        sourceIdForUrl: () => "missing-source"
      })
    ).toThrowError(/缺少受治理来源/u);
  });

  it("fails closed instead of restoring through a disabled source", () => {
    expect(() =>
      buildPhaseOneReviewRestorePlan({
        candidates: PHASE_ONE_CANDIDATE_ENTRIES,
        sources: PHASE_ONE_SOURCE_MANIFEST.map((source, index) =>
          index === 0 ? { ...source, enabled: false } : source
        ),
        sourceIdForUrl: (url) => `source-${Buffer.from(url).toString("hex")}`
      })
    ).toThrowError(/未启用/u);
  });

  it("fails closed instead of restoring through a deleted source", () => {
    expect(() =>
      buildPhaseOneReviewRestorePlan({
        candidates: PHASE_ONE_CANDIDATE_ENTRIES,
        sources: PHASE_ONE_SOURCE_MANIFEST.map((source, index) =>
          index === 0
            ? { ...source, deletedAt: "2026-08-08T00:00:00.000Z" }
            : source
        ),
        sourceIdForUrl: (url) => `source-${Buffer.from(url).toString("hex")}`
      })
    ).toThrowError(/已删除/u);
  });

  it("requires an explicit confirmation phrase before database writes", () => {
    expect(() =>
      assertPhaseOneReviewRestoreAuthorized({ apply: false })
    ).not.toThrow();
    expect(() =>
      assertPhaseOneReviewRestoreAuthorized({
        apply: true,
        confirmation: "wrong"
      })
    ).toThrowError(/OPENVAC_KNOWLEDGE_RESTORE_CONFIRM/u);
    expect(() =>
      assertPhaseOneReviewRestoreAuthorized({
        apply: true,
        confirmation: "RESTORE_PHASE_ONE_REVIEW",
        adoptLegacy: true
      })
    ).toThrowError(/OPENVAC_KNOWLEDGE_LEGACY_ADOPTION_CONFIRM/u);
    expect(() =>
      assertPhaseOneReviewRestoreAuthorized({
        apply: true,
        confirmation: "RESTORE_PHASE_ONE_REVIEW",
        adoptLegacy: true,
        legacyConfirmation: "ADOPT_PHASE_ONE_LEGACY"
      })
    ).not.toThrow();
  });

  it("adopts only the exact unreviewed provisional legacy fingerprint", () => {
    const exact = {
      enabled: true,
      externalKey: "cern-legacy",
      expectedContentHash: "a".repeat(64),
      expectedChunkCount: 18,
      documentStatus: "published",
      versionStatus: "published",
      versionContentHash: "a".repeat(64),
      versionPublishedAt: new Date("2026-08-01T00:00:00.000Z"),
      metadata: {
        reviewStatus: "required",
        retrievalStatus: "active_pending_review",
        retrievalContentHash: "a".repeat(64)
      },
      sectionCount: 0,
      decisionCount: 0,
      chunkCount: 18
    };

    expect(() => assertLegacyPhaseOneAdoption(exact)).not.toThrow();
    expect(() =>
      assertLegacyPhaseOneAdoption({ ...exact, enabled: false })
    ).toThrowError(/--adopt-legacy/u);
    expect(() =>
      assertLegacyPhaseOneAdoption({ ...exact, decisionCount: 1 })
    ).toThrowError(/does not match/u);
    expect(() =>
      assertLegacyPhaseOneAdoption({
        ...exact,
        versionContentHash: "b".repeat(64)
      })
    ).toThrowError(/does not match/u);
  });
});
