# Security model

## Trust boundaries

- Browser input is untrusted.
- Provider output is untrusted until section and citation validation passes.
- Web-search URLs are untrusted even when returned by Alibaba Cloud.
- Uploaded admin knowledge is untrusted until parsing, malware controls,
  licence review, and human content review complete.
- Administrator UI visibility is not an authorisation boundary; every
  `/api/admin/*` handler checks the database role.

## Required controls

- Better Auth database rate limiting for sign-in, verification, and password
  reset
- unique `clientRequestId` and database transactions for answer quota
- paid web-search attempts commit quota before provider execution
- password reset revokes existing sessions
- server-side ownership filters on every conversation and message query
- strict Zod request schemas and bounded text lengths
- no HTML rendering from user or model content
- no model text reaches the browser before answer and citation validation
- HTTPS-only citations with authority allowlist validation
- SSRF defence after every redirect and DNS resolution
- private database network and private OSS bucket with blocked public access
- append-only audit records for role, prompt, source, publication, rollback,
  quota, and user moderation changes
- compare-and-set worker leases with heartbeats, bounded OCR polling, and exact
  private-OSS host validation
- no secrets or direct contact information in logs or analytics

## Launch gate

Automated coverage must include brute-force login, horizontal access, role
elevation, prompt injection, Markdown/XSS, SSRF, malicious admin upload, and
secret scanning. Public launch cannot proceed with an unresolved critical or
high finding.
