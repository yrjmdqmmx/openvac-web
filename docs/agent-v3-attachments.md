# Agent V3 attachment and storage integration

Agent V3 chat attachments use dedicated private storage. They are never written
to `knowledge_original`, `knowledge_version`, or `knowledge_chunk`.

## HTTP lifecycle

- `POST /api/chat/attachments` initiates an upload for an authenticated user's
  active conversation. The request contains `conversationId`, `filename`,
  `mimeType`, `sizeBytes`, and lowercase `sha256`.
- The initiate response contains a 15-minute private PUT URL and the exact
  required headers. The PUT is bound to private ACL, MIME, SHA-256, declared
  size metadata, attachment ID, and OSS forbid-overwrite.
- `POST /api/chat/attachments/:attachmentId/complete` verifies authoritative
  object size, MIME, metadata, actual bytes, file signature, and SHA-256 before
  moving quota from reserved to committed.
- `GET /api/chat/attachments/:attachmentId` returns owner-scoped status without
  an object key or signed URL.
- `GET /api/chat/attachments/:attachmentId/preview` and `/download` return
  no-store redirects to five-minute private URLs after ownership and committed
  storage checks.

Supported files are PDF, DOCX, XLSX, CSV, TXT, Markdown, JPEG, and PNG. The
limits are 25 MiB per attachment, five distinct attachments per message, and
500 MiB combined committed plus reserved attachment/artifact storage per user.

## Message integration

The Agent V3 message transaction must call
`ChatAttachmentService.bindToMessage` after the user message exists and before
the run consumes attachment IDs. The binding transaction verifies the message
role, user, active conversation, upload completion, distinct IDs, and the
five-attachment limit. Document parsing starts after the authenticated upload is
verified so the composer can keep sending disabled until parsing is ready; the
committed storage quota and orphan TTL bound this pre-send processing. The Agent
still binds the ready attachment to the created user message before model work.

## Parsing and cleanup

The normal `pnpm worker` process now runs both knowledge ingestion and chat
storage loops. Chat documents use local UTF-8 parsing for TXT, Markdown, and
CSV, and DocMind for PDF, DOCX, and XLSX. Extracted private chunks are stored in
`chat_attachment_chunk` with page, line, or CSV-row locators. Images become
ready after upload verification and are not sent to DocMind here.

Unbound attachments expire after 24 hours. Conversation deletion and account
deletion enqueue private object keys before metadata is removed or cascaded.
Reserved browser uploads are scheduled after their PUT URL expires so a late
upload cannot recreate an orphan after an early delete. Queue workers use
`FOR UPDATE SKIP LOCKED`, leases, bounded retry counts, and idempotent OSS
deletion. Account cascades null the queue's user ID while retaining the cleanup
key.

## Artifact storage boundary

`ChatArtifactStorageService` validates `openvac.artifact.v1`, verifies the
source turn and conversation, reserves the same 500 MiB account quota, writes a
private no-overwrite object, verifies authoritative OSS metadata, and commits
the artifact file. The renderer remains outside this module and should call
this service rather than writing `chat_artifact_file` directly.

Account export includes allowlisted attachment/artifact metadata and hashes,
but excludes object keys, provider data, and signed URLs.
