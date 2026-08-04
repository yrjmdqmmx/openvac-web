# Architecture

## Request path

1. Better Auth validates the database-backed session and verified email.
2. `/api/chat` validates `clientRequestId` and atomically reserves one answer
   lease for the current Beijing day.
3. The question is classified for high-risk vacuum hazards.
4. PostgreSQL full-text search and pgvector similarity are fused into a ranked
   evidence set.
5. If eligible local evidence is insufficient or stale, a separate web-search
   lease is reserved and committed immediately before the paid outbound
   attempt. DashScope `turbo` search is restricted to the authority allowlist
   and must report exactly one `search_info` call.
6. Any fetched page is revalidated for HTTPS, authority hostname, DNS address,
   redirect target, response type, response size, and timeout.
7. DeepSeek V4 Flash receives an explicitly untrusted JSON data envelope.
   Instruction-like retrieved text is removed, and the provider drops
   `reasoning_content`.
8. OpenVac buffers the candidate answer, validates the fixed five sections and
   citation numbers, saves the answer and citations, commits the answer lease,
   and only then emits text events to the browser. Any failure releases it.

Phase 1 local evidence may be either human-approved or explicitly activated as
`active_pending_review`. Pending-review evidence is pinned to its content hash;
an edit, rejection, source disable, or archive removes it from retrieval.

## Stable provider boundaries

- `ModelProvider`
- `EmbeddingProvider`
- `WebSearchProvider`
- `DocumentParser`
- `EmailProvider`
- `ObjectStorage`

The UI never receives provider keys or a selectable model list.

## Data groups

- Better Auth identity, credentials, verification, and sessions
- quota buckets and idempotent reservation ledger
- conversations, messages, citations, message feedback, and problem reports
- source registry, knowledge documents, versions, chunks, and embeddings
- provider/tool invocations, prompt versions, evaluations, and budgets
- administrator roles, system settings, and append-only audit logs

Problem-report rows carry a maximum 180-day retention deadline. Optional
contact details are scheduled for deletion 30 days after a report is closed.
The maintenance cleanup command enforces both deadlines when it runs; its
recurring staging timer still requires deployment verification before public
launch.

## Answer contract

Every completed answer contains these headings in order:

1. 结论
2. 采用的条件/假设
3. 依据与来源
4. 仍缺少的信息
5. 建议下一步

Evidence absence is a valid product outcome: the agent asks for missing inputs,
states uncertainty, or recommends contacting the equipment manufacturer or a
qualified on-site professional. Problem reports are a separate product-quality
channel, require explicit context/contact consent, do not promise a reply, and
do not provide emergency support.
