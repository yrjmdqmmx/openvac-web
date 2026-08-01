import { describe, expect, it } from "vitest";

import {
  PHASE_ONE_CANDIDATE_ENTRIES,
  PHASE_ONE_EVAL_CASES,
  PHASE_ONE_SOURCE_MANIFEST
} from "./phase-one-catalog";
import {
  validatePhaseOneCatalog,
  type PhaseOneSourceRecord
} from "./catalog-validation";

describe("phase-one knowledge catalog", () => {
  it("passes the local content, provenance and evaluation gate", () => {
    const report = validatePhaseOneCatalog({
      sources: PHASE_ONE_SOURCE_MANIFEST,
      candidates: PHASE_ONE_CANDIDATE_ENTRIES,
      evalCases: PHASE_ONE_EVAL_CASES
    });

    expect(report.issues).toEqual([]);
    expect(report.fullTextDocumentCount).toBe(5);
    expect(report.metadataOnlyDocumentCount).toBe(2);
    expect(report.patentDocumentCount).toBe(2);
    expect(report.fullTextSectionCount).toBeGreaterThanOrEqual(53);
    expect(report.cernSectionCount).toBe(45);
    expect(report.auditedCernSectionCount).toBe(45);
    expect(report.cernEvidenceAuditGate).toBe("complete");
    expect(report.cernOfficialPdfBinaryGate).toBe(
      "pending_2014_anubis_recheck"
    );
    expect(report.evaluationCaseCount).toBe(150);
    expect(report.sourcedEvaluationCount).toBe(120);
    expect(report.retrievalEvaluationCount).toBe(102);
    expect(report.metadataReferenceEvaluationCount).toBe(18);
    expect(report.safetyPolicyEvaluationCount).toBe(30);
    expect(report.humanReviewGate).toBe("pending");
    expect(report.liveRetrievalGate).toBe("pending");
  });

  it("blocks the CERN evidence audit when a block hash no longer matches", () => {
    const candidates = structuredClone(PHASE_ONE_CANDIDATE_ENTRIES);
    const candidate = candidates.find((entry) =>
      entry.value.document.externalKey.includes(
        "vacuum-superconducting-devices"
      )
    );
    expect(candidate).toBeDefined();
    if (!candidate) return;
    candidate.value.sections[0].contentHash = "0".repeat(64);

    const report = validatePhaseOneCatalog({
      sources: PHASE_ONE_SOURCE_MANIFEST,
      candidates,
      evalCases: PHASE_ONE_EVAL_CASES
    });

    expect(report.cernEvidenceAuditGate).toBe("blocked");
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cern_section_hash_mismatch" })
      ])
    );
  });

  it("blocks the CERN evidence audit when a block loses audit metadata", () => {
    const candidates = structuredClone(PHASE_ONE_CANDIDATE_ENTRIES);
    const candidate = candidates.find((entry) =>
      entry.value.document.externalKey.includes(
        "vacuum-superconducting-devices"
      )
    );
    expect(candidate).toBeDefined();
    if (!candidate) return;
    delete candidate.value.sections[0].originalExcerpt;

    const report = validatePhaseOneCatalog({
      sources: PHASE_ONE_SOURCE_MANIFEST,
      candidates,
      evalCases: PHASE_ONE_EVAL_CASES
    });

    expect(report.cernEvidenceAuditGate).toBe("blocked");
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cern_section_audit_incomplete" })
      ])
    );
  });

  it("pins each CERN audit to the reviewed official PDF URL", () => {
    const candidates = structuredClone(PHASE_ONE_CANDIDATE_ENTRIES);
    const candidate = candidates.find((entry) =>
      entry.value.document.externalKey.includes(
        "vacuum-superconducting-devices"
      )
    );
    expect(candidate).toBeDefined();
    if (!candidate) return;
    (candidate.value.citation as Record<string, unknown>).officialPdfUrl =
      "https://example.com/unreviewed.pdf";

    const report = validatePhaseOneCatalog({
      sources: PHASE_ONE_SOURCE_MANIFEST,
      candidates,
      evalCases: PHASE_ONE_EVAL_CASES
    });

    expect(report.cernEvidenceAuditGate).toBe("blocked");
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cern_official_pdf_url_mismatch" })
      ])
    );
  });

  it("keeps the 2014 official published PDF binary recheck as a visible gate", () => {
    const candidates = structuredClone(PHASE_ONE_CANDIDATE_ENTRIES);
    const candidate = candidates.find((entry) =>
      entry.value.document.externalKey.includes(
        "vacuum-superconducting-devices"
      )
    );
    expect(candidate).toBeDefined();
    if (!candidate) return;
    const citation = candidate.value.citation as Record<string, unknown>;
    const verification = citation.excerptVerification as Record<
      string,
      unknown
    >;
    delete verification.officialPublishedPdfBinaryStatus;

    const report = validatePhaseOneCatalog({
      sources: PHASE_ONE_SOURCE_MANIFEST,
      candidates,
      evalCases: PHASE_ONE_EVAL_CASES
    });

    expect(report.cernEvidenceAuditGate).toBe("blocked");
    expect(report.cernOfficialPdfBinaryGate).toBe("blocked");
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "cern_excerpt_verification_metadata_invalid"
        })
      ])
    );
  });

  it("rejects a record-scoped rights decision that targets another URL", () => {
    const sources = structuredClone(
      PHASE_ONE_SOURCE_MANIFEST
    ) as PhaseOneSourceRecord[];
    const source = sources.find(
      (item) => item.sourceKey === "cern-vacuum-systems-2024"
    );
    expect(source?.rightsDecision).toBeDefined();
    if (!source?.rightsDecision) return;
    source.rightsDecision.appliesToRecordUrl = "https://example.com/other";

    const report = validatePhaseOneCatalog({
      sources,
      candidates: PHASE_ONE_CANDIDATE_ENTRIES,
      evalCases: PHASE_ONE_EVAL_CASES
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_rights_decision" })
      ])
    );
  });

  it("pins every required source to its reviewed identity", () => {
    const sources = structuredClone(
      PHASE_ONE_SOURCE_MANIFEST
    ) as PhaseOneSourceRecord[];
    const source = sources.find(
      (item) => item.sourceKey === "patent-us7674096b2"
    );
    expect(source).toBeDefined();
    if (!source) return;
    source.publisher = "Unreviewed mirror";

    const report = validatePhaseOneCatalog({
      sources,
      candidates: PHASE_ONE_CANDIDATE_ENTRIES,
      evalCases: PHASE_ONE_EVAL_CASES
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "required_source_identity_mismatch" })
      ])
    );
  });

  it("pins the rights evidence used for each required source", () => {
    const sources = structuredClone(
      PHASE_ONE_SOURCE_MANIFEST
    ) as PhaseOneSourceRecord[];
    const source = sources.find(
      (item) => item.sourceKey === "cern-vacuum-systems-2024"
    );
    expect(source?.rightsDecision).toBeDefined();
    if (!source?.rightsDecision) return;
    source.rightsDecision.evidenceUrl = "https://example.com/unreviewed";

    const report = validatePhaseOneCatalog({
      sources,
      candidates: PHASE_ONE_CANDIDATE_ENTRIES,
      evalCases: PHASE_ONE_EVAL_CASES
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "required_source_identity_mismatch" })
      ])
    );
  });

  it("requires a rights decision for every enabled source used by a candidate", () => {
    const sources = structuredClone(
      PHASE_ONE_SOURCE_MANIFEST
    ) as PhaseOneSourceRecord[];
    const source = sources.find(
      (item) => item.sourceKey === "patent-cn221568833u"
    );
    expect(source).toBeDefined();
    if (!source) return;
    delete source.rightsDecision;

    const report = validatePhaseOneCatalog({
      sources,
      candidates: PHASE_ONE_CANDIDATE_ENTRIES,
      evalCases: PHASE_ONE_EVAL_CASES
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_rights_decision" })
      ])
    );
  });

  it.each([["not-a-date"], [new Date(Date.now() + 86_400_000).toISOString()]])(
    "rejects invalid or future rights review time %s",
    (reviewedAt) => {
      const sources = structuredClone(
        PHASE_ONE_SOURCE_MANIFEST
      ) as PhaseOneSourceRecord[];
      const source = sources.find(
        (item) => item.sourceKey === "cern-vacuum-systems-2024"
      );
      expect(source?.rightsDecision).toBeDefined();
      if (!source?.rightsDecision) return;
      source.rightsDecision.reviewedAt = reviewedAt;

      const report = validatePhaseOneCatalog({
        sources,
        candidates: PHASE_ONE_CANDIDATE_ENTRIES,
        evalCases: PHASE_ONE_EVAL_CASES
      });

      expect(report.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "invalid_rights_decision" })
        ])
      );
    }
  );

  it("rejects patent content if it is reclassified as full text", () => {
    const candidates = structuredClone(PHASE_ONE_CANDIDATE_ENTRIES);
    const patent = candidates.find((entry) =>
      entry.value.document.externalKey.includes("us7674096b2")
    );
    expect(patent).toBeDefined();
    if (!patent) return;
    patent.value.citation.ingestionMode = "full_text";
    patent.value.citation.licenseClass = "open";

    const report = validatePhaseOneCatalog({
      sources: PHASE_ONE_SOURCE_MANIFEST,
      candidates,
      evalCases: PHASE_ONE_EVAL_CASES
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "patent_full_text_forbidden" })
      ])
    );
  });

  it("requires every patent evidence-boundary field", () => {
    const candidates = structuredClone(PHASE_ONE_CANDIDATE_ENTRIES);
    const patent = candidates.find((entry) =>
      entry.value.document.externalKey.includes("us7674096b2")
    );
    expect(patent).toBeDefined();
    if (!patent) return;
    const citation = patent.value.citation as Record<string, unknown>;
    citation.evidenceLevel = "manufacturer_manual";
    citation.independentPerformanceValidation = true;
    delete citation.summaryAuthorship;
    citation.claimLocators = [];
    delete citation.figureLocators;
    citation.technicalUseWarnings = ["Only one warning"];
    delete citation.legalStatusDisclaimer;

    const report = validatePhaseOneCatalog({
      sources: PHASE_ONE_SOURCE_MANIFEST,
      candidates,
      evalCases: PHASE_ONE_EVAL_CASES
    });

    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "patent_evidence_level_invalid",
        "patent_independent_validation_invalid",
        "patent_summary_authorship_missing",
        "patent_claim_locators_missing",
        "patent_figure_locators_missing",
        "patent_technical_warnings_missing",
        "patent_disclaimer_missing"
      ])
    );
  });

  it.each([
    ["retrieval", "metadata_reference"],
    ["metadata_reference", "retrieval"]
  ] as const)(
    "strictly maps %s evidence to candidate ingestion when changed to %s",
    (originalMode, changedMode) => {
      const evalCases = structuredClone(PHASE_ONE_EVAL_CASES);
      const item = evalCases.find(
        (candidate) => candidate.evidenceMode === originalMode
      );
      expect(item).toBeDefined();
      if (!item) return;
      item.evidenceMode = changedMode;

      const report = validatePhaseOneCatalog({
        sources: PHASE_ONE_SOURCE_MANIFEST,
        candidates: PHASE_ONE_CANDIDATE_ENTRIES,
        evalCases
      });

      expect(report.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "eval_candidate_ingestion_mismatch"
          })
        ])
      );
    }
  );

  it("requires metadata-reference cases to name exactly their expected patents", () => {
    const evalCases = structuredClone(PHASE_ONE_EVAL_CASES);
    const item = evalCases.find(
      (candidate) => candidate.evidenceMode === "metadata_reference"
    );
    expect(item).toBeDefined();
    if (!item) return;
    item.question = "请介绍这份单级旋片真空泵专利。";

    const report = validatePhaseOneCatalog({
      sources: PHASE_ONE_SOURCE_MANIFEST,
      candidates: PHASE_ONE_CANDIDATE_ENTRIES,
      evalCases
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "metadata_reference_publication_mismatch"
        })
      ])
    );
  });

  it.each(["risk", "escalation", "source"] as const)(
    "allows safety_policy only with high risk, escalation and no source: %s",
    (mutation) => {
      const evalCases = structuredClone(PHASE_ONE_EVAL_CASES);
      const item = evalCases.find(
        (candidate) => candidate.evidenceMode === "safety_policy"
      );
      expect(item).toBeDefined();
      if (!item) return;
      if (mutation === "risk") item.expectedRiskLevel = "medium";
      if (mutation === "escalation") item.mustEscalate = false;
      if (mutation === "source") {
        item.expectedSourceIds = ["cern-vacuum-systems-2024"];
      }

      const report = validatePhaseOneCatalog({
        sources: PHASE_ONE_SOURCE_MANIFEST,
        candidates: PHASE_ONE_CANDIDATE_ENTRIES,
        evalCases
      });

      expect(report.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "invalid_safety_policy_case" })
        ])
      );
    }
  );

  it("keeps the local human-review gate pending even when eval labels are reviewed", () => {
    const evalCases = structuredClone(PHASE_ONE_EVAL_CASES);
    for (const item of evalCases) item.reviewStatus = "expert_reviewed";

    const report = validatePhaseOneCatalog({
      sources: PHASE_ONE_SOURCE_MANIFEST,
      candidates: PHASE_ONE_CANDIDATE_ENTRIES,
      evalCases
    });

    expect(report.expertReviewedEvaluationCount).toBe(evalCases.length);
    expect(report.humanReviewGate).toBe("pending");
  });

  it("rejects full-text evidence whose authoritative page range is unknown", () => {
    const sources = structuredClone(
      PHASE_ONE_SOURCE_MANIFEST
    ) as PhaseOneSourceRecord[];
    const candidates = structuredClone(PHASE_ONE_CANDIDATE_ENTRIES);
    const source = sources.find(
      (item) => item.sourceKey === "cern-vacuum-superconducting-devices-2014"
    );
    const candidate = candidates.find(
      (entry) =>
        entry.value.document.externalKey ===
        "cern-2014-005-vacuum-superconducting-devices"
    );
    expect(source?.rightsDecision).toBeDefined();
    expect(candidate).toBeDefined();
    if (!source?.rightsDecision || !candidate) return;
    const unknownUrl = "https://example.com/unreviewed-document.pdf";
    source.canonicalUrl = unknownUrl;
    source.rightsDecision.appliesToRecordUrl = unknownUrl;
    candidate.value.sourceCanonicalUrl = unknownUrl;

    const report = validatePhaseOneCatalog({
      sources,
      candidates,
      evalCases: PHASE_ONE_EVAL_CASES
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unknown_full_text_page_range" })
      ])
    );
  });
});
