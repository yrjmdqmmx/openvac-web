# Agent V3 artifact integration

Agent V3 artifacts are generated from the shared `ArtifactSpec` contract. This
implementation supplies validation, deterministic renderers, production
private-object persistence, shared quota settlement, and owner-scoped status,
preview, and download routes.

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

`ChatArtifactStorageService` owns artifact status, file metadata, shared quota,
and private binary persistence. Neither its repository nor its object-store
boundary accepts a client-provided signed URL.

Before metadata is created, the repository verifies the active Agent run,
source turn, conversation owner, and assistant message, then writes
`chat_artifact.message_id`. Owner status and file access also join that binding
to a `completed` or `incomplete` run, so a failed or still-running answer cannot
expose an artifact.

The repository records the internal object key, SHA-256 checksum, media type,
byte length, filename, format, and timestamps. Browser-facing
`ArtifactDownloadMetadata` omits the object key and exposes only a same-origin
path shaped as `/api/chat/artifacts/{artifactId}/download?format={format}`. The download
handler resolves that path through the owner-scoped repository, verifies the
completed run and committed file, and only then creates a five-minute private
download URL.

## Failure isolation

`ProductionArtifactStorage` runs only for an explicit artifact request and
always returns public metadata: `ready` or `failed`. Validation, rendering,
object-store, or repository failures become a failed tool result and do not
fail an otherwise valid text answer.

If any requested format or object write fails, the service deletes already
written objects with best-effort cleanup, records `failed`, returns no
downloads, and leaves the text answer intact. Rendering observes the run abort
signal before and after every persistence boundary. A failed, cancelled, or
timed-out run also calls `discardRun`, releases committed/reserved storage
bytes, and queues object deletion. The browser receives only localized public
metadata; logs and browser events must not contain raw tool output, object
keys, signed URLs, provider metadata, or internal error text.

## Storage integration checklist

1. Keep the artifact tables and quota accounting additive and compatible with
   the previous application image.
2. Keep one strict `ArtifactSpec` schema and the deterministic renderer
   contract.
3. Reserve shared storage quota before each object write, then settle using the
   server-observed persisted byte lengths.
4. Scope every lookup and delete by owner, conversation, run, turn, and
   assistant message. Account export and deletion include artifact metadata and
   private objects.
5. Expose only the same-origin download path to the browser. Resolve private
   object access on the server after authorization.
6. Run `pnpm test:artifacts`, `pnpm eval:answer:v3`, and the storage integration
   tests before handing the implementation to the V3 browser flow.
