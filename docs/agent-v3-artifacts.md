# Agent V3 artifact integration

Agent V3 artifacts are generated from the shared `ArtifactSpec` contract. This
workstream supplies validation, deterministic renderers, and storage-facing
interfaces. It deliberately does not add attachment or artifact database
tables.

## Strict input contract

`parseArtifactSpec` in `src/server/artifacts/validation.ts` is the only accepted
entry point for untrusted artifact specifications. It rejects unknown fields,
duplicate formats, empty content, duplicate table columns, mismatched row
widths, unsupported control characters, CSV requests without a table, and
parameter-table requests without a table. The aggregate text limit is
2,000,000 characters.

The four supported kinds are diagnostic reports, selection/calculation
reports, inspection checklists, and parameter tables. The four output formats
are Markdown, DOCX, PDF, and CSV. CSV cells beginning with spreadsheet formula
characters are prefixed with an apostrophe.

## Deterministic rendering

`renderArtifactFiles` returns formats in `md`, `docx`, `pdf`, `csv` order,
filtered by the requested formats. Repeated rendering of the same validated
specification and bundled font bytes must return identical bytes.

- Markdown has canonical LF line endings and a final newline.
- CSV uses UTF-8 with BOM, CRLF records, quoted cells, and formula hardening.
- DOCX is a deterministic OOXML ZIP with fixed timestamps and an embedded,
  obfuscated Chinese font so it does not depend on a host CJK font.
- PDF uses fixed metadata dates and embeds the packaged Chinese font without a
  second CID-font subset pass. The full embed avoids missing GB2312 glyphs.

The PDF/DOCX dependency versions are exact in `package.json`:
`pdf-lib@1.17.1`, `@pdf-lib/fontkit@1.1.1`, and
`@embedpdf/fonts-sc@1.0.0`. The last package is OFL-1.1 and supplies the
Noto Sans Hans font bytes used by both document formats. Full font embedding
makes a typical Chinese PDF or DOCX about 7-8 MiB before object-storage
compression; storage must include that size in the shared 500 MiB per-user
attachment-and-artifact quota.

## Repository and object-store boundary

`ArtifactRepository` owns artifact status and file metadata. The storage
workstream implements it next to its additive schema migration. `ArtifactObjectStore`
owns private binary persistence. Neither interface accepts a client-provided
signed URL.

The repository records the internal object key, SHA-256 checksum, media type,
byte length, filename, format, and timestamps. Browser-facing
`ArtifactDownloadMetadata` omits the object key and exposes only a same-origin
path shaped as `/api/artifacts/{artifactId}/{format}`. The future download
handler must resolve that path through `findOwnedDownload`, verify ownership,
and only then create or proxy a short-lived private-object download.

## Failure isolation

Call `ArtifactService.generateSafely` after the text answer is committed or on
an independent artifact branch. It always resolves to an artifact result:
`ready` with download metadata, or `failed` with one stable failure code. It
does not rethrow validation, rendering, object-store, or repository failures
into the answer stream.

If any requested format or object write fails, the service deletes already
written objects with best-effort cleanup, records `failed`, returns no
downloads, and leaves the text answer intact. The browser receives only the
localized `artifact.updated` status; logs and browser events must not contain
raw tool output, object keys, signed URLs, provider metadata, or internal error
text.

## Storage integration checklist

1. Add the artifact tables and quota accounting through an additive migration.
2. Implement `ArtifactRepository` and `ArtifactObjectStore`; do not change the
   renderer contract or create a second `ArtifactSpec` schema.
3. Reserve shared storage quota before generation, then settle using the
   server-observed persisted byte lengths.
4. Scope every lookup and delete by owner and conversation. Account export and
   deletion must include artifact metadata and private objects.
5. Expose only the same-origin download path to the browser. Resolve private
   object access on the server after authorization.
6. Run `pnpm test:artifacts`, `pnpm eval:answer:v3`, and the storage integration
   tests before handing the implementation to the V3 browser flow.
