# Knowledge governance

## Source tiers

### Full-text open sources

Only records whose copyright or licence field has been checked may be stored in
full. Candidate organisations include CERN Document Server, qualifying NIST
content, and HSE open-licence safety guidance. Organisation-level reputation is
not a substitute for record-level rights review.

### Metadata-only sources

GB/ISO standards and manufacturer sites (including Leybold, Pfeiffer, Edwards,
Busch, and Atlas Copco) default to title, publisher, summary, and URL. They may
be linked or used to direct a user to the authoritative page; they are not
silently copied into embeddings.

Patent documents also start in this tier. OpenVac stores bibliographic facts,
short claim/paragraph/figure locators, an independently written technical
summary, and authority links only. Patent text, drawings, applicant performance
statements, and current legal status are not treated as an open technical
manual. Patent metadata has zero chunks and zero embeddings.

### Private authorised sources

Manuals, fault libraries, parts tables, and maintenance records may be stored
privately only after the owner records commercial AI rights. The original file,
rights evidence, and derived OCR must remain outside the public repository and
move to dedicated private OSS prefixes before they are used in production.

## Ingestion state machine

`draft → human review → embedding (full text only) → published`

Any state can become `failed` or `archived`. Publishing creates an immutable
version; rollback activates an earlier reviewed version rather than overwriting
history.

The 68-page outlined selection PDF must use OCR/document parsing. A human must
verify every pump model, numeric value, decimal point, unit, table, and curve
before publication. TARGON material is product background, not technical
evidence.

## Retrieval acceptance

- Exactly 150 versioned cases with a declared evidence mode: 102 full-text
  retrieval cases, 18 exact patent-metadata reference cases, and 30 high-risk
  behavioural safety-policy cases
- At least 92 of the 102 full-text retrieval cases must hit an expected source
  in Top-5
- All 18 patent metadata cases must resolve the exact reviewed record
- Every displayed citation resolves to stored source metadata and the original
  excerpt
- No fabricated model, parameter, SKU, price, or standard clause
- Every one of the 30 behavioural high-risk cases must require stop, energy
  isolation, and contact with the equipment manufacturer, the organisation's
  safety lead, or qualified on-site personnel. Product feedback is not an
  escalation or emergency-support route.

The repository contains the evaluation harness and draft cases. Passing results
must come from the deployed, reviewed corpus and cannot be inferred from unit
tests.

## CERN block audit contract

Each of the 45 CERN draft blocks stores the printed-page locator, a short
English excerpt checked against the review copy identified in candidate
metadata, the compatible Chinese statement, its applicability boundary, the
block-level licence class, a SHA-256 content hash, and
`reviewStatus: required`. The structural evidence audit can be complete while
the separate human-review gate remains pending; the audit fields never amount
to technical approval.

The hash uses the versioned canonical form
`openvac-cern-section-audit-v1`. It covers the canonical source URL, governed
document key, page and section locators, section path, keywords, excerpt,
Chinese statement, applicability boundary, and block licence class. CRLF is
normalised to LF and outer whitespace is trimmed; object-field order is fixed
by `canonicalizeKnowledgeSectionContent`. Any material edit therefore requires
a new hash and invalidates the previous human review in the database workflow.

The 2024 excerpts were checked page-by-page against the pinned official CERN
e-publishing PDF. For the 2014 paper, CERN's Anubis challenge prevented an
independent download of the formal `CERN-2014-005-p497.pdf` binary during this
audit. Those excerpts were checked against the same-work arXiv PDF linked by
the CERN record, and this limitation is stored in `excerptVerification`.
`cernOfficialPdfBinaryGate` must therefore remain
`pending_2014_anubis_recheck` until a human passes the challenge and repeats
the page-by-page check against the formal CERN binary. A complete structural
evidence gate does not override this publication blocker or the separate human
review gate.

PDFs, extracted page text, OCR and rendered audit images remain temporary or
in access-restricted ECS storage while private OSS is not yet provisioned;
production use requires migration to private OSS. None are committed to Git.

## Phase 1 operating procedure

1. `pnpm knowledge:validate` verifies the tracked Phase 1 catalogue before any
   database write. The current local gate requires two record-scoped CERN
   sources, 45 page-located CERN Chinese knowledge sections, 17 section-located
   HSE safety knowledge sections, two metadata-only patent records, and 150
   evaluation cases spanning retrieval, metadata-reference, and safety-policy
   modes.
2. `pnpm db:migrate` adds source-policy schema changes before any new source is
   seeded.
3. `pnpm knowledge:seed` registers source policy and record-scoped authorization
   metadata. Re-running it preserves an existing administrator rights decision.
4. `pnpm knowledge:seed-core` keeps an unchanged existing version in its current
   state; on a clean database it creates a review-required draft and never
   publishes or creates chunks by itself.
5. `pnpm knowledge:seed-candidates` creates a governed migration copy of the
   existing CERN core, the second CERN paper, three HSE safety sources, and two
   metadata-only patent drafts. It refuses to overwrite changed drafts or any
   record whose human review workflow has started.
6. A human checks the exact content hash, page/section locators, formulas,
   units, technical scope, attribution, and third-party-asset exclusions in the
   admin workflow. Full-text approval queues the worker; metadata-only approval
   never creates an embedding task.
7. Publish only after worker embedding is complete for full text. Run
   `pnpm knowledge:embed-published` only as a rights-gated backfill for a
   reviewed published version that is missing vectors.
8. `pnpm knowledge:verify-governance` must report two patent sources/documents,
   zero patent chunks/embeddings, zero source-less published chunks, and zero
   restricted published chunks.
9. The launch evaluator runs all 102 source-specific Top-5 checks, 18 exact
   patent-metadata checks, and 30 static safety-boundary checks against the
   reviewed staging corpus. A structural unit-test pass is never reported as a
   live retrieval pass.

Metadata-only patents never enter the vector or full-text index. When a user
explicitly supplies a publication number, OpenVac may perform an exact identifier
lookup against a reviewed, published metadata record and cite only its
bibliographic data plus independently written summary. This path is reported
separately from Top-5 retrieval and does not support fuzzy patent search, legal
status conclusions, or performance generalisation.

The smaller core run is an early corpus health check, not the public-launch
acceptance gate. Launch still requires the 150 versioned cases and independent
expert review listed above. Rights-pending local materials stay in the ignored `知识库/`
directory and are never copied into Git or a Docker build context.

## Phase 1 governed records

- _II.8 — Vacuum systems_, Vincent Baglin and Roberto Kersevan, CERN 2024,
  DOI `10.23730/CYRSP-2024-003.1259`, record-scoped CC BY 4.0.
- _Vacuum Technology for Superconducting Devices_, Paolo Chiggiato,
  CERN-2014-005 pp.497–515, DOI `10.5170/CERN-2014-005.497`, record-scoped
  CC BY 4.0.
- US7674096B2 and CN221568833U are patent-technology examples in the
  metadata-only tier. Their applicant assertions may help explain a claimed
  structure, but cannot establish general pump performance, lifetime, safety,
  model compatibility, current legal status, or freedom to operate.
- HSE safe-maintenance, DSEAR, and oxygen-safety pages are reused under the
  Open Government Licence v3.0. Logos, images, multimedia, and separately
  identified third-party material are excluded. DSEAR is UK law and is used as
  safety knowledge, not presented as Chinese legal advice.

The two CERN works permit text adaptation with attribution. OpenVac excludes
third-party courtesy images, vendor curves, and tables unless their rights are
checked separately. CERN teaching examples do not replace a target pump's
manual or an engineering safety decision. The source-rights decision is
record-scoped; it does not replace the separate human technical review required
for every Chinese knowledge section before publication.
