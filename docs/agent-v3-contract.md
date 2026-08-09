# Agent V3 shared contract

Agent V3 replaces the text-only request and fixed five-section answer with
typed message parts and adaptive answer blocks. The runtime types and validators
live in `src/types/chat-v3.ts` and `src/server/chat-v3/contracts.ts`.

## Fixed product limits

- Authenticated chat only.
- Five attachments per user message.
- 25 MiB per attachment.
- 500 MiB combined attachment and artifact storage per user.
- Supported inputs: PDF, DOCX, XLSX, CSV, TXT, Markdown, JPEG, and PNG.
- Attachments are private, conversation-scoped, and never enter governed
  knowledge automatically.
- Artifacts are created only after an explicit user request.

## Trust boundaries

- Only server-verified HTTPS links become clickable.
- User files, extracted text, image analysis, web pages, and tool results are
  untrusted data rather than instructions.
- Browser events expose localized statuses and validated content blocks, never
  raw tool arguments, tool output, signed object URLs, prompts, or provider
  metadata.
- Existing `message.content` remains a plaintext projection for legacy history
  and previous-image rollback. New message parts are the V3 source of truth.

## Workstream ownership

- Storage owns attachment/artifact persistence, quota, object lifecycle, and
  account export/delete integration.
- Agent owns provider routing, attachment/link tools, adaptive answer creation,
  and localized calculation output.
- Frontend owns the composer, private previews, safe content-block rendering,
  and terminal-version reconciliation.
- Artifacts/evals own deterministic renderers and the strict automated release
  gate.

## Agent integration points

- `AgentRunOrchestrator` always uses DeepSeek Responses for the final
  `openvac.answer.v3` reasoning pass. `routeCapabilities` adds Qwen-VL only for
  image analysis and DocMind only for document parsing.
- Storage workstreams connect through `AttachmentStorage` and
  `ArtifactStorage`. The built-in implementations are deliberately
  unconfigured, fail-closed stubs; the Agent does not create attachment or
  artifact database tables.
- Attachment storage returns private bytes and cached text chunks to the
  server-side tool service. Signed object URLs are not part of either storage
  interface and must never be returned in stream events or answer metadata.
- Protocol 3 requests send `parts`. Protocol 2 text requests remain accepted
  as a compatibility projection, but every newly orchestrated answer is V3.
- Existing V2 answer payloads and legacy plaintext summaries remain readable.
  New summaries use `openvac.context.summary.v2` with confirmed facts,
  unresolved questions, source message IDs, and attachment references.
