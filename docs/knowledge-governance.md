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
