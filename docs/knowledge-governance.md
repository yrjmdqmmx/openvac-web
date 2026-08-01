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

1. `pnpm knowledge:seed` registers source policy and authorization metadata.
2. `pnpm knowledge:seed-core` publishes the tracked CERN Chinese curation. If
   the content hash is unchanged, existing chunk IDs and embeddings are kept.
3. `pnpm knowledge:embed-published` fills missing vectors only for published,
   reviewed full text with either record-level open-license approval or
   confirmed private commercial-AI rights. Standard and manufacturer metadata
   are always excluded.
4. `pnpm eval:core:live` runs 20 source-and-section-specific Top-5 checks against
   the deployed PostgreSQL/pgvector corpus and fails below 90%.

The 20-case core run is an early corpus health check, not the public-launch
acceptance gate. Launch still requires the 120 versioned cases and expert review
listed above. Rights-pending local materials stay in the ignored `知识库/`
directory and are never copied into Git or a Docker build context.
