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
rights evidence, and derived OCR remain in private OSS prefixes.

## Ingestion state machine

`draft → processing → review → published`

Any state can become `failed` or `archived`. Publishing creates an immutable
version; rollback activates an earlier reviewed version rather than overwriting
history.

The 68-page outlined selection PDF must use OCR/document parsing. A human must
verify every pump model, numeric value, decimal point, unit, table, and curve
before publication. TARGON material is product background, not technical
evidence.

## Retrieval acceptance

- At least 120 versioned questions with expected source IDs
- Top-5 source hit rate of at least 90%
- Every displayed citation resolves to stored source metadata and the original
  excerpt
- No fabricated model, parameter, SKU, price, or standard clause
- Every high-risk case activates the safety boundary and human escalation

The repository contains the evaluation harness and draft cases. Passing results
must come from the deployed, reviewed corpus and cannot be inferred from unit
tests.

## Phase 1 operating procedure

1. `pnpm db:migrate` adds source-policy schema changes before any new source is
   seeded.
2. `pnpm knowledge:seed` registers source policy and record-scoped authorization
   metadata. Re-running it preserves an existing administrator rights decision.
3. `pnpm knowledge:seed-core` keeps an unchanged existing version in its current
   state; on a clean database it creates a review-required draft and never
   publishes or creates chunks by itself.
4. `pnpm knowledge:seed-candidates` creates a governed migration copy of the
   existing CERN core, the second CERN paper, and two metadata-only patent
   drafts. It refuses to overwrite changed drafts or any record whose human
   review workflow has started.
5. A human checks the exact content hash, page/section locators, formulas,
   units, technical scope, attribution, and third-party-asset exclusions in the
   admin workflow. Full-text approval queues the worker; metadata-only approval
   never creates an embedding task.
6. Publish only after worker embedding is complete for full text. Run
   `pnpm knowledge:embed-published` only as a rights-gated backfill for a
   reviewed published version that is missing vectors.
7. `pnpm knowledge:verify-governance` must report two patent sources/documents,
   zero patent chunks/embeddings, zero source-less published chunks, and zero
   restricted published chunks.
8. `pnpm eval:core:live` runs 20 source-and-section-specific Top-5 checks against
   the deployed PostgreSQL/pgvector corpus and fails below 90%.

The 20-case core run is an early corpus health check, not the public-launch
acceptance gate. Launch still requires the 120 versioned cases and expert review
listed above. Rights-pending local materials stay in the ignored `知识库/`
directory and are never copied into Git or a Docker build context.

## Phase 1 reviewed records

- _II.8 — Vacuum systems_, Vincent Baglin and Roberto Kersevan, CERN 2024,
  DOI `10.23730/CYRSP-2024-003.1259`, record-scoped CC BY 4.0.
- _Vacuum Technology for Superconducting Devices_, Paolo Chiggiato,
  CERN-2014-005 pp.497–515, DOI `10.5170/CERN-2014-005.497`, record-scoped
  CC BY 4.0.
- US7674096B2 and CN221568833U are patent-technology examples in the
  metadata-only tier. Their applicant assertions may help explain a claimed
  structure, but cannot establish general pump performance, lifetime, safety,
  model compatibility, current legal status, or freedom to operate.

The two CERN works permit text adaptation with attribution. OpenVac excludes
third-party courtesy images, vendor curves, and tables unless their rights are
checked separately. CERN teaching examples do not replace a target pump's
manual or an engineering safety decision.
