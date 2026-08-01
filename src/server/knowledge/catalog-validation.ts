import type { EvalCase } from "@/evals/v1";

import {
  computeKnowledgeSectionContentHash,
  hasCompleteKnowledgeSectionAudit,
  type KnowledgeCandidate
} from "./candidate-schema";
import { extractPatentPublicationNumbers } from "./metadata-reference";

export type PhaseOneSourceRecord = {
  sourceKey: string;
  kind: string;
  name: string;
  publisher: string;
  canonicalUrl: string;
  sourceTier: string;
  licensePolicy: string;
  enabled: boolean;
  rightsDecision?: {
    status?: string;
    scope?: string;
    evidenceUrl?: string;
    appliesToRecordUrl?: string;
    reviewedBy?: string;
    reviewedAt?: string;
  };
};

export type PhaseOneCatalogEntry = {
  path: string;
  value: KnowledgeCandidate;
};

export type CatalogValidationIssue = {
  code: string;
  path: string;
  message: string;
};

export type PhaseOneCatalogReport = {
  sourceCount: number;
  enabledSourceCount: number;
  documentCount: number;
  fullTextDocumentCount: number;
  metadataOnlyDocumentCount: number;
  fullTextSectionCount: number;
  cernSectionCount: number;
  auditedCernSectionCount: number;
  cernEvidenceAuditGate: "complete" | "blocked";
  cernOfficialPdfBinaryGate:
    "complete" | "pending_2014_anubis_recheck" | "blocked";
  patentDocumentCount: number;
  evaluationCaseCount: number;
  sourcedEvaluationCount: number;
  retrievalEvaluationCount: number;
  metadataReferenceEvaluationCount: number;
  safetyPolicyEvaluationCount: number;
  highRiskEvaluationCount: number;
  expertReviewedEvaluationCount: number;
  topicCount: number;
  humanReviewGate: "complete" | "pending";
  liveRetrievalGate: "pending";
  issues: CatalogValidationIssue[];
};

const REQUIRED_SOURCE_IDENTITIES = new Map<
  string,
  Pick<
    PhaseOneSourceRecord,
    "kind" | "name" | "publisher" | "canonicalUrl" | "sourceTier"
  > & { rightsEvidenceUrl: string }
>([
  [
    "cern-vacuum-systems-2024",
    {
      kind: "manual",
      name: "II.8 — Vacuum systems",
      publisher: "CERN",
      canonicalUrl: "https://cds.cern.ch/record/2929324?ln=en",
      sourceTier: "open_license",
      rightsEvidenceUrl:
        "https://e-publishing.cern.ch/index.php/CYRSP/article/view/1624"
    }
  ],
  [
    "cern-vacuum-superconducting-devices-2014",
    {
      kind: "manual",
      name: "Vacuum Technology for Superconducting Devices",
      publisher: "CERN",
      canonicalUrl: "https://cds.cern.ch/record/1974068",
      sourceTier: "open_license",
      rightsEvidenceUrl: "https://cds.cern.ch/record/1974068"
    }
  ],
  [
    "patent-us7674096b2",
    {
      kind: "patent",
      name: "US7674096B2 — Portable, rotary vane vacuum pump with removable oil reservoir cartridge",
      publisher: "United States Patent and Trademark Office",
      canonicalUrl: "https://patentcenter.uspto.gov/applications/10947899",
      sourceTier: "metadata_only",
      rightsEvidenceUrl:
        "https://www.uspto.gov/web/offices/pac/mpep/documents/0600_608_02.htm"
    }
  ],
  [
    "patent-cn221568833u",
    {
      kind: "patent",
      name: "CN221568833U — 单级旋片真空泵",
      publisher: "China National Intellectual Property Administration",
      canonicalUrl: "https://patents.google.com/patent/CN221568833U/zh",
      sourceTier: "metadata_only",
      rightsEvidenceUrl:
        "https://www.cnipa.gov.cn/art/2023/1/31/art_3164_181829.html"
    }
  ],
  [
    "hse-safe-maintenance",
    {
      kind: "web",
      name: "Safe maintenance guidance",
      publisher: "UK Health and Safety Executive",
      canonicalUrl:
        "https://www.hse.gov.uk/work-equipment-machinery/maintenance.htm",
      sourceTier: "open_license",
      rightsEvidenceUrl: "https://www.hse.gov.uk/help/copyright.htm"
    }
  ],
  [
    "hse-dsear",
    {
      kind: "web",
      name: "Dangerous Substances and Explosive Atmospheres",
      publisher: "UK Health and Safety Executive",
      canonicalUrl: "https://www.hse.gov.uk/fireandexplosion/dsear.htm",
      sourceTier: "open_license",
      rightsEvidenceUrl: "https://www.hse.gov.uk/help/copyright.htm"
    }
  ],
  [
    "hse-oxygen-safety",
    {
      kind: "web",
      name: "Oxygen use safety guidance",
      publisher: "UK Health and Safety Executive",
      canonicalUrl: "https://www.hse.gov.uk/pubns/indg459.htm",
      sourceTier: "open_license",
      rightsEvidenceUrl: "https://www.hse.gov.uk/help/copyright.htm"
    }
  ]
]);

const PAGE_RANGES = new Map<string, readonly [number, number]>([
  ["https://cds.cern.ch/record/2929324?ln=en", [1259, 1338]],
  ["https://cds.cern.ch/record/1974068", [497, 515]]
]);

const PATENT_PUBLICATION_BY_SOURCE_KEY = new Map([
  ["patent-us7674096b2", "US7674096B2"],
  ["patent-cn221568833u", "CN221568833U"]
]);

const REQUIRED_CERN_SECTION_COUNTS = new Map([
  ["cern-vacuum-systems-2024", 27],
  ["cern-vacuum-superconducting-devices-2014", 18]
]);

const REQUIRED_CERN_PDF_URLS = new Map([
  [
    "cern-vacuum-systems-2024",
    "https://e-publishing.cern.ch/index.php/CYRSP/article/download/1624/1336/7999"
  ],
  [
    "cern-vacuum-superconducting-devices-2014",
    "https://cds.cern.ch/record/1974068/files/CERN-2014-005-p497.pdf"
  ]
]);

const CERN_2024_REVIEWED_PDF_URL =
  "https://e-publishing.cern.ch/index.php/CYRSP/article/download/1624/1336/7999";
const CERN_2014_OFFICIAL_PUBLISHED_PDF_URL =
  "https://cds.cern.ch/record/1974068/files/CERN-2014-005-p497.pdf";
const CERN_2014_RECORD_LINKED_ARXIV_PDF_URL =
  "https://cds.cern.ch/record/1974068/files/arXiv%3A1501.07162.pdf";

type ExcerptVerification = {
  status?: unknown;
  reviewedPdfUrl?: unknown;
  printedPageRange?: unknown;
  officialPublishedPdfBinaryStatus?: unknown;
  officialPublishedPdfUrl?: unknown;
  note?: unknown;
};

function getExcerptVerification(
  citation: KnowledgeCandidate["citation"]
): ExcerptVerification | undefined {
  const value = (citation as Record<string, unknown>).excerptVerification;
  return value && typeof value === "object"
    ? (value as ExcerptVerification)
    : undefined;
}

function isHttps(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isValidNonFutureDate(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => isNonEmptyString(item))
  );
}

export function validatePhaseOneCatalog(input: {
  sources: readonly PhaseOneSourceRecord[];
  candidates: readonly PhaseOneCatalogEntry[];
  evalCases: readonly EvalCase[];
}): PhaseOneCatalogReport {
  const issues: CatalogValidationIssue[] = [];
  const addIssue = (code: string, path: string, message: string) => {
    issues.push({ code, path, message });
  };

  const candidateModesByUrl = new Map<
    string,
    Set<KnowledgeCandidate["citation"]["ingestionMode"]>
  >();
  for (const entry of input.candidates) {
    const modes = candidateModesByUrl.get(entry.value.sourceCanonicalUrl);
    if (modes) modes.add(entry.value.citation.ingestionMode);
    else {
      candidateModesByUrl.set(
        entry.value.sourceCanonicalUrl,
        new Set([entry.value.citation.ingestionMode])
      );
    }
  }

  const sourceByKey = new Map<string, PhaseOneSourceRecord>();
  const sourceByUrl = new Map<string, PhaseOneSourceRecord>();
  for (const [index, source] of input.sources.entries()) {
    const path = `knowledge/source-manifest.json[${index}]`;
    if (sourceByKey.has(source.sourceKey)) {
      addIssue("duplicate_source_key", path, source.sourceKey);
    }
    if (sourceByUrl.has(source.canonicalUrl)) {
      addIssue("duplicate_source_url", path, source.canonicalUrl);
    }
    sourceByKey.set(source.sourceKey, source);
    sourceByUrl.set(source.canonicalUrl, source);

    if (!source.publisher.trim()) {
      addIssue("missing_publisher", path, source.sourceKey);
    }
    if (!isHttps(source.canonicalUrl)) {
      addIssue("invalid_source_url", path, source.canonicalUrl);
    }

    const candidateModes = candidateModesByUrl.get(source.canonicalUrl);
    if (source.enabled && candidateModes) {
      const rights = source.rightsDecision;
      const expectedScope =
        candidateModes.size === 1 ? [...candidateModes][0] : undefined;
      if (!expectedScope) {
        addIssue(
          "candidate_ingestion_scope_conflict",
          path,
          `${source.sourceKey} has candidates with incompatible ingestion modes`
        );
      }
      if (
        rights?.status !== "approved" ||
        rights.scope !== expectedScope ||
        rights.appliesToRecordUrl !== source.canonicalUrl ||
        !isHttps(rights.evidenceUrl) ||
        !rights.reviewedBy?.trim() ||
        !isValidNonFutureDate(rights.reviewedAt)
      ) {
        addIssue(
          "invalid_rights_decision",
          path,
          `${source.sourceKey} requires an approved record-scoped ${expectedScope} decision`
        );
      }
    }
  }

  for (const [required, identity] of REQUIRED_SOURCE_IDENTITIES) {
    const source = sourceByKey.get(required);
    if (!source?.enabled) {
      addIssue(
        "required_source_missing",
        "knowledge/source-manifest.json",
        required
      );
      continue;
    }
    if (
      source.kind !== identity.kind ||
      source.name !== identity.name ||
      source.publisher !== identity.publisher ||
      source.canonicalUrl !== identity.canonicalUrl ||
      source.sourceTier !== identity.sourceTier ||
      source.rightsDecision?.evidenceUrl !== identity.rightsEvidenceUrl
    ) {
      addIssue(
        "required_source_identity_mismatch",
        "knowledge/source-manifest.json",
        required
      );
    }
  }

  const documentKeys = new Set<string>();
  const contentBodies = new Set<string>();
  let fullTextDocumentCount = 0;
  let metadataOnlyDocumentCount = 0;
  let fullTextSectionCount = 0;
  let cernSectionCount = 0;
  let auditedCernSectionCount = 0;
  let cernAuditBlocked = false;
  let cernOfficialPdfBinaryBlocked = false;
  let cernOfficialPdfBinaryPending = false;
  let patentDocumentCount = 0;
  const cernSectionCountsBySourceKey = new Map<string, number>();
  const candidateModesBySourceKey = new Map<
    string,
    Set<KnowledgeCandidate["citation"]["ingestionMode"]>
  >();

  for (const entry of input.candidates) {
    const candidate = entry.value;
    const source = sourceByUrl.get(candidate.sourceCanonicalUrl);
    if (!source) {
      addIssue(
        "candidate_source_missing",
        entry.path,
        candidate.sourceCanonicalUrl
      );
      continue;
    }
    if (!source.enabled) {
      addIssue("candidate_source_disabled", entry.path, source.sourceKey);
    }
    const sourceModes = candidateModesBySourceKey.get(source.sourceKey);
    if (sourceModes) sourceModes.add(candidate.citation.ingestionMode);
    else {
      candidateModesBySourceKey.set(
        source.sourceKey,
        new Set([candidate.citation.ingestionMode])
      );
    }
    if (documentKeys.has(candidate.document.externalKey)) {
      addIssue(
        "duplicate_document_key",
        entry.path,
        candidate.document.externalKey
      );
    }
    documentKeys.add(candidate.document.externalKey);

    const fullText = candidate.citation.ingestionMode === "full_text";
    const requiredCernPdfUrl = REQUIRED_CERN_PDF_URLS.get(source.sourceKey);
    if (
      requiredCernPdfUrl &&
      (candidate.citation as Record<string, unknown>).officialPdfUrl !==
        requiredCernPdfUrl
    ) {
      cernAuditBlocked = true;
      addIssue(
        "cern_official_pdf_url_mismatch",
        entry.path,
        `${source.sourceKey} must pin its reviewed CERN PDF URL`
      );
    }
    if (source.sourceKey === "cern-vacuum-systems-2024") {
      const verification = getExcerptVerification(candidate.citation);
      if (
        verification?.status !== "official_pdf_page_reviewed" ||
        verification.reviewedPdfUrl !== CERN_2024_REVIEWED_PDF_URL ||
        verification.printedPageRange !== "1259-1338"
      ) {
        cernAuditBlocked = true;
        cernOfficialPdfBinaryBlocked = true;
        addIssue(
          "cern_excerpt_verification_metadata_invalid",
          entry.path,
          "the 2024 excerpts must remain pinned to the page-reviewed official CERN PDF"
        );
      }
    }
    if (source.sourceKey === "cern-vacuum-superconducting-devices-2014") {
      const verification = getExcerptVerification(candidate.citation);
      const pendingRecheck =
        verification?.status === "record_linked_arxiv_copy_reviewed" &&
        verification.reviewedPdfUrl === CERN_2014_RECORD_LINKED_ARXIV_PDF_URL &&
        verification.printedPageRange === "497-515" &&
        verification.officialPublishedPdfBinaryStatus ===
          "pending_anubis_recheck" &&
        verification.officialPublishedPdfUrl ===
          CERN_2014_OFFICIAL_PUBLISHED_PDF_URL &&
        isNonEmptyString(verification.note);
      const officialBinaryReviewed =
        verification?.status === "official_pdf_page_reviewed" &&
        verification.reviewedPdfUrl === CERN_2014_OFFICIAL_PUBLISHED_PDF_URL &&
        verification.printedPageRange === "497-515" &&
        verification.officialPublishedPdfBinaryStatus ===
          "official_pdf_page_reviewed";

      if (pendingRecheck) {
        cernOfficialPdfBinaryPending = true;
      } else if (!officialBinaryReviewed) {
        cernAuditBlocked = true;
        cernOfficialPdfBinaryBlocked = true;
        addIssue(
          "cern_excerpt_verification_metadata_invalid",
          entry.path,
          "the 2014 excerpts must disclose the record-linked arXiv review and pending official CERN-p497 binary recheck"
        );
      }
    }
    if (fullText) {
      fullTextDocumentCount += 1;
      fullTextSectionCount += candidate.sections.length;
      if (candidate.citation.licenseClass !== "open") {
        addIssue("full_text_not_open", entry.path, source.sourceKey);
      }
      if (!["open_license", "internal"].includes(source.sourceTier)) {
        addIssue("full_text_tier_forbidden", entry.path, source.sourceTier);
      }
      const minimumSections = candidate.document.mimeType.includes("pdf")
        ? 12
        : 4;
      if (candidate.sections.length < minimumSections) {
        addIssue(
          "insufficient_full_text_sections",
          entry.path,
          `${candidate.sections.length}; expected at least ${minimumSections}`
        );
      }
      if (
        candidate.document.mimeType.includes("pdf") &&
        !PAGE_RANGES.has(candidate.sourceCanonicalUrl)
      ) {
        addIssue(
          "unknown_full_text_page_range",
          entry.path,
          candidate.sourceCanonicalUrl
        );
      }
    } else {
      metadataOnlyDocumentCount += 1;
      if (candidate.citation.licenseClass !== "metadata_only") {
        addIssue("metadata_license_mismatch", entry.path, source.sourceKey);
      }
      if (
        ![
          "metadata_only",
          "manufacturer_metadata",
          "standard_metadata"
        ].includes(source.sourceTier)
      ) {
        addIssue("metadata_tier_mismatch", entry.path, source.sourceTier);
      }
    }

    if (source.kind === "patent") {
      patentDocumentCount += 1;
      if (
        fullText ||
        source.sourceTier !== "metadata_only" ||
        !candidate.document.mimeType.includes("patent-metadata")
      ) {
        addIssue(
          "patent_full_text_forbidden",
          entry.path,
          "patents must remain metadata-only"
        );
      }
      const patentCharacters = candidate.sections.reduce(
        (total, section) => total + section.content.length,
        0
      );
      if (patentCharacters > 2_500) {
        addIssue(
          "patent_summary_too_long",
          entry.path,
          `${patentCharacters} characters`
        );
      }
      const citation = candidate.citation as Record<string, unknown>;
      if (citation.evidenceLevel !== "patentee_disclosure") {
        addIssue(
          "patent_evidence_level_invalid",
          entry.path,
          "evidenceLevel must be patentee_disclosure"
        );
      }
      if (citation.independentPerformanceValidation !== false) {
        addIssue(
          "patent_independent_validation_invalid",
          entry.path,
          "independentPerformanceValidation must be false"
        );
      }
      if (!isNonEmptyString(citation.summaryAuthorship)) {
        addIssue(
          "patent_summary_authorship_missing",
          entry.path,
          "summaryAuthorship is required"
        );
      }
      if (!isNonEmptyStringArray(citation.claimLocators)) {
        addIssue(
          "patent_claim_locators_missing",
          entry.path,
          "claimLocators must contain at least one locator"
        );
      }
      if (!isNonEmptyStringArray(citation.figureLocators)) {
        addIssue(
          "patent_figure_locators_missing",
          entry.path,
          "figureLocators must contain at least one locator"
        );
      }
      if (
        !isNonEmptyStringArray(citation.technicalUseWarnings) ||
        citation.technicalUseWarnings.length < 2
      ) {
        addIssue(
          "patent_technical_warnings_missing",
          entry.path,
          "technicalUseWarnings must contain at least two warnings"
        );
      }
      if (!isNonEmptyString(citation.legalStatusDisclaimer)) {
        addIssue(
          "patent_disclaimer_missing",
          entry.path,
          "legalStatusDisclaimer is required"
        );
      }
    }

    const pageRange = PAGE_RANGES.get(candidate.sourceCanonicalUrl);
    for (const [index, section] of candidate.sections.entries()) {
      const sectionPath = `${entry.path}.sections[${index}]`;
      if (contentBodies.has(section.content)) {
        addIssue(
          "duplicate_section_content",
          sectionPath,
          section.content.slice(0, 80)
        );
      }
      contentBodies.add(section.content);

      if (fullText) {
        const hasPageLocator =
          section.pageStart !== undefined && section.pageEnd !== undefined;
        if (!hasPageLocator && !section.sourceSection) {
          addIssue(
            "missing_source_locator",
            sectionPath,
            "full-text evidence requires a page range or source section"
          );
        } else if (
          hasPageLocator &&
          pageRange &&
          (section.pageStart! < pageRange[0] || section.pageEnd! > pageRange[1])
        ) {
          addIssue(
            "page_out_of_range",
            sectionPath,
            `${section.pageStart}-${section.pageEnd} outside ${pageRange[0]}-${pageRange[1]}`
          );
        }
      }

      if (REQUIRED_CERN_SECTION_COUNTS.has(source.sourceKey)) {
        cernSectionCount += 1;
        cernSectionCountsBySourceKey.set(
          source.sourceKey,
          (cernSectionCountsBySourceKey.get(source.sourceKey) ?? 0) + 1
        );
        if (!hasCompleteKnowledgeSectionAudit(section)) {
          cernAuditBlocked = true;
          addIssue(
            "cern_section_audit_incomplete",
            sectionPath,
            "CERN sections require a page-located excerpt, Chinese statement, applicability, open license, deterministic hash and required review status"
          );
        } else {
          auditedCernSectionCount += 1;
          if (
            section.licenseClass !== "open" ||
            section.reviewStatus !== "required"
          ) {
            cernAuditBlocked = true;
            addIssue(
              "cern_section_audit_boundary_invalid",
              sectionPath,
              "CERN draft blocks must remain open-license and review-required"
            );
          }
          if (section.chineseStatement !== section.content) {
            cernAuditBlocked = true;
            addIssue(
              "cern_statement_compatibility_mismatch",
              sectionPath,
              "chineseStatement must equal content while the compatibility field remains in use"
            );
          }
          if (
            section.pageStart === undefined ||
            section.pageEnd === undefined ||
            section.originalExcerptPage < section.pageStart ||
            section.originalExcerptPage > section.pageEnd
          ) {
            cernAuditBlocked = true;
            addIssue(
              "cern_excerpt_page_outside_locator",
              sectionPath,
              `${section.originalExcerptPage} outside ${section.pageStart}-${section.pageEnd}`
            );
          }
          const expectedHash = computeKnowledgeSectionContentHash({
            sourceCanonicalUrl: candidate.sourceCanonicalUrl,
            documentExternalKey: candidate.document.externalKey,
            section
          });
          if (section.contentHash !== expectedHash) {
            cernAuditBlocked = true;
            addIssue(
              "cern_section_hash_mismatch",
              sectionPath,
              "contentHash does not match the canonical audited block"
            );
          }
        }
        if (section.auditIssue) {
          cernAuditBlocked = true;
          addIssue("cern_section_audit_issue", sectionPath, section.auditIssue);
        }
      }
    }
  }

  for (const [sourceKey, expectedCount] of REQUIRED_CERN_SECTION_COUNTS) {
    const actualCount = cernSectionCountsBySourceKey.get(sourceKey) ?? 0;
    if (actualCount !== expectedCount) {
      cernAuditBlocked = true;
      addIssue(
        "cern_section_count_mismatch",
        "knowledge/candidates",
        `${sourceKey}: ${actualCount}; expected ${expectedCount}`
      );
    }
  }

  if (input.candidates.length < 4) {
    addIssue(
      "insufficient_documents",
      "knowledge",
      `${input.candidates.length}; expected at least 4`
    );
  }
  if (fullTextSectionCount < 36) {
    addIssue(
      "insufficient_full_text_coverage",
      "knowledge",
      `${fullTextSectionCount}; expected at least 36 page-located sections`
    );
  }
  if (patentDocumentCount !== 2) {
    addIssue(
      "patent_document_count",
      "knowledge/candidates",
      `${patentDocumentCount}; expected 2`
    );
  }

  const evalIds = new Set<string>();
  const evalQuestions = new Set<string>();
  let highRiskEvaluationCount = 0;
  let retrievalEvaluationCount = 0;
  let metadataReferenceEvaluationCount = 0;
  let safetyPolicyEvaluationCount = 0;
  for (const [index, item] of input.evalCases.entries()) {
    const path = `src/evals/v1.ts[${index}]`;
    if (evalIds.has(item.id)) addIssue("duplicate_eval_id", path, item.id);
    if (evalQuestions.has(item.question)) {
      addIssue("duplicate_eval_question", path, item.question);
    }
    evalIds.add(item.id);
    evalQuestions.add(item.question);

    if (item.evidenceMode === "retrieval") retrievalEvaluationCount += 1;
    if (item.evidenceMode === "metadata_reference") {
      metadataReferenceEvaluationCount += 1;
      const actualPublications = new Set(
        extractPatentPublicationNumbers(item.question)
      );
      const expectedPublications = new Set(
        item.expectedSourceIds
          .map((sourceId) => PATENT_PUBLICATION_BY_SOURCE_KEY.get(sourceId))
          .filter((value): value is string => value !== undefined)
      );
      if (
        actualPublications.size !== expectedPublications.size ||
        [...actualPublications].some(
          (publication) => !expectedPublications.has(publication)
        )
      ) {
        addIssue(
          "metadata_reference_publication_mismatch",
          path,
          "metadata_reference question must contain exactly its expected patent publication numbers"
        );
      }
    }
    if (item.evidenceMode === "safety_policy") {
      safetyPolicyEvaluationCount += 1;
    }

    if (item.expectedRiskLevel === "high") {
      highRiskEvaluationCount += 1;
      if (!item.mustEscalate) {
        addIssue("high_risk_not_escalated", path, item.id);
      }
    }
    if (item.evidenceMode === "safety_policy") {
      if (
        item.expectedRiskLevel !== "high" ||
        !item.mustEscalate ||
        item.expectedSourceIds.length !== 0
      ) {
        addIssue(
          "invalid_safety_policy_case",
          path,
          "safety_policy requires high risk, mustEscalate and no sources"
        );
      }
    }
    if (item.forbiddenClaims.length === 0) {
      addIssue("missing_forbidden_claim", path, item.id);
    }
    for (const sourceId of item.expectedSourceIds) {
      const source = sourceByKey.get(sourceId);
      if (!source) addIssue("eval_source_missing", path, sourceId);
      else if (!source.enabled)
        addIssue("eval_source_disabled", path, sourceId);
      else if (
        source.sourceTier === "metadata_only" &&
        item.evidenceMode !== "metadata_reference"
      ) {
        addIssue("metadata_source_used_for_retrieval", path, sourceId);
      }

      if (
        item.evidenceMode === "retrieval" ||
        item.evidenceMode === "metadata_reference"
      ) {
        const expectedIngestionMode =
          item.evidenceMode === "retrieval" ? "full_text" : "metadata_only";
        const candidateModes = candidateModesBySourceKey.get(sourceId);
        if (
          candidateModes?.size !== 1 ||
          !candidateModes.has(expectedIngestionMode)
        ) {
          addIssue(
            "eval_candidate_ingestion_mismatch",
            path,
            `${sourceId} does not map exclusively to ${expectedIngestionMode}`
          );
        }
      }
    }
    if (
      item.expectedSourceIds.length === 0 &&
      item.evidenceMode !== "safety_policy"
    ) {
      addIssue("missing_eval_evidence", path, item.id);
    }
    if (
      item.evidenceMode === "safety_policy" &&
      item.expectedSourceIds.length > 0
    ) {
      addIssue("safety_policy_claims_source", path, item.id);
    }
  }

  if (input.evalCases.length < 150) {
    addIssue(
      "insufficient_eval_cases",
      "src/evals/v1.ts",
      `${input.evalCases.length}; expected at least 150`
    );
  }
  const topicCount = new Set(input.evalCases.map((item) => item.topic)).size;
  if (topicCount < 25) {
    addIssue(
      "insufficient_eval_topics",
      "src/evals/v1.ts",
      `${topicCount}; expected at least 25`
    );
  }
  if (retrievalEvaluationCount < 102) {
    addIssue(
      "insufficient_retrieval_cases",
      "src/evals/v1.ts",
      `${retrievalEvaluationCount}; expected at least 102`
    );
  }
  if (metadataReferenceEvaluationCount !== 18) {
    addIssue(
      "metadata_reference_case_count",
      "src/evals/v1.ts",
      `${metadataReferenceEvaluationCount}; expected 18`
    );
  }
  if (safetyPolicyEvaluationCount !== 30) {
    addIssue(
      "safety_policy_case_count",
      "src/evals/v1.ts",
      `${safetyPolicyEvaluationCount}; expected 30`
    );
  }
  if (highRiskEvaluationCount < 42) {
    addIssue(
      "insufficient_high_risk_cases",
      "src/evals/v1.ts",
      `${highRiskEvaluationCount}; expected at least 42`
    );
  }

  const expertReviewedEvaluationCount = input.evalCases.filter(
    (item) => item.reviewStatus === "expert_reviewed"
  ).length;

  return {
    sourceCount: input.sources.length,
    enabledSourceCount: input.sources.filter((source) => source.enabled).length,
    documentCount: input.candidates.length,
    fullTextDocumentCount,
    metadataOnlyDocumentCount,
    fullTextSectionCount,
    cernSectionCount,
    auditedCernSectionCount,
    cernEvidenceAuditGate:
      !cernAuditBlocked &&
      cernSectionCount === 45 &&
      auditedCernSectionCount === 45
        ? "complete"
        : "blocked",
    cernOfficialPdfBinaryGate: cernOfficialPdfBinaryBlocked
      ? "blocked"
      : cernOfficialPdfBinaryPending
        ? "pending_2014_anubis_recheck"
        : "complete",
    patentDocumentCount,
    evaluationCaseCount: input.evalCases.length,
    sourcedEvaluationCount:
      retrievalEvaluationCount + metadataReferenceEvaluationCount,
    retrievalEvaluationCount,
    metadataReferenceEvaluationCount,
    safetyPolicyEvaluationCount,
    highRiskEvaluationCount,
    expertReviewedEvaluationCount,
    topicCount,
    humanReviewGate: "pending",
    liveRetrievalGate: "pending",
    issues
  };
}
