# OpenVac Web

OpenVac Web is a Chinese-first vacuum-pump expert agent for engineers,
maintenance teams, and procurement staff. Users describe a pump, operating
condition, or fault in plain language; OpenVac answers with explicit
assumptions, traceable sources, missing inputs, and a safe next step.

The V1 product boundary is intentionally narrow:

- evidence-grounded vacuum Q&A with expandable citations;
- conversation history, message feedback/reports, and explicitly submitted
  problem reports with opt-in context/contact sharing;
- email/password accounts with verification, password reset, session
  revocation, account deletion, and a hidden daily quota;
- a governed knowledge workflow from draft and OCR review through evaluation,
  publication, and rollback;
- role-based operations for users, conversations, sources, prompts, budgets,
  problem reports, and audit logs.

V1 does **not** make final engineering decisions, expose a deterministic pump
calculator, display live inventory or prices, process payments, accept end-user
file uploads, provide a model picker, promise replies to problem reports, or
provide real-time/emergency support.

## Architecture

- Next.js 16 App Router, React 19, TypeScript, and Tailwind CSS
- Better Auth with verified email/password accounts
- Drizzle ORM, PostgreSQL 17, and pgvector (1024 dimensions)
- DeepSeek V4 Flash behind a replaceable server-side `ModelProvider`
- Alibaba Cloud adapters for embeddings, web search, document parsing,
  transactional mail, and private object storage
- a Node worker for OCR, review-gated ingestion, chunking, and embeddings
- Docker Compose for `web`, `worker`, `migrate`, and `postgres`

See [architecture](docs/architecture.md), [knowledge governance](docs/knowledge-governance.md),
[security](docs/security.md), and [deployment](docs/deployment.md).

## Local development

Requirements:

- Node.js 24+
- pnpm 10+
- Docker with Compose (for PostgreSQL + pgvector)

```bash
cp .env.example .env
pnpm install
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000`.

Provider credentials are optional for formatting, type checks, unit tests, and
the public landing page. A real authenticated answer requires PostgreSQL,
DeepSeek, and at least one reviewed knowledge source. Production refuses
development mocks.

## Commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm worker
pnpm problem-reports:cleanup
pnpm eval
pnpm eval:core
pnpm knowledge:validate
```

Knowledge Phase 1 uses only tracked, record-scoped source decisions. The local
`知识库/` directory is intentionally ignored by both Git and Docker and must not
be uploaded. `pnpm knowledge:seed` registers governed sources and
`pnpm knowledge:seed-candidates` creates review-required drafts. Candidate
seeding never impersonates a reviewer, creates patent vectors, or overwrites a
draft that may contain human edits. `pnpm knowledge:validate` checks the local
Phase 1 catalogue, record-scoped rights, page locators, patent metadata-only
boundary, and 150-case evaluation structure without claiming human approval or
live retrieval quality. After a human review, worker completion, and
publication, run `pnpm knowledge:verify-governance` and
`pnpm eval:core:live` against the real PostgreSQL/pgvector path.

Database changes are generated and applied with:

```bash
pnpm db:generate
pnpm db:migrate
```

## Quotas

The default account limit is 20 successful answers per Beijing calendar day.
Requests atomically reserve capacity by `clientRequestId`; completion commits
the lease, while model, retrieval, cancellation, or persistence errors release
it. The interface never exposes a remaining counter. It only reports the next
reset time when the limit is exhausted.

Web search is local-evidence-first and separately limited to five paid outbound
attempts per account and 500 globally per Beijing day. Its lease is committed
before the provider call, so a downstream failure cannot recycle paid global
capacity. Duplicate request IDs never start another search.

## Knowledge licensing

Every source has a license class:

- `open` / `public_domain`: full text only after record-level verification;
- `metadata_only`: title, summary, publisher, and source link only;
- `private_authorized`: full private text only after documented commercial AI
  rights;
- `unknown`: cannot be published into production retrieval.

Manufacturer sites and GB/ISO standards default to `metadata_only`. OCR never
publishes automatically: model numbers, decimals, units, and curves require
human review.

Patent records also default to `metadata_only`. The repository may store
bibliographic facts, short claim/figure locators, an independently written
summary, and an authority link; it does not store or vectorize patent full text
or drawings without a separate record-level rights decision. A patent
disclosure is not independent performance validation, a safety certification,
or legal advice. A reviewed metadata record can be recalled only by an explicit
publication-number lookup; this is not semantic retrieval and is not counted in
the Top-5 corpus hit rate.

## Security and privacy

- secrets stay in ECS environment files or GitHub environment secrets;
- the database is not bound to a public host port;
- private source files and rotating backups must use private OSS before public
  launch; current staging OSS upload is not yet configured;
- user Markdown is rendered as inert text, and citations require HTTPS;
- web fetching revalidates an authority allowlist and blocks private network
  addresses, slow responses, redirects, and oversized bodies;
- model output is buffered and withheld until its answer structure and
  citations validate;
- once enabled, OCR receives only short-lived private-OSS URLs on an exact
  HTTPS host allowlist, with bounded polling and result size;
- every admin write has a server-side role check and audit event;
- conversations remain until user deletion and online deletion is immediate;
  public launch additionally requires verified backup expiry within 30 days.
- problem reports expire after 180 days; optional contact details are removed
  30 days after closure, and owner notifications contain no report body or
  contact data.

Run the read-only ECS check before creating a site:

```bash
sh ./deploy/audit-ecs.sh
```

It does not install packages or modify ports, Docker, Nginx, or existing
services.

## Deployment

The public source repository drives CI and GHCR image publication. Runtime data
and secrets remain on Alibaba Cloud ECS. Deploy staging first at
`staging-openvac.openvac.cn`; production at `openvac.cn`
requires a manually approved GitHub environment.

The deployment workflow uses immutable image digests, applies migrations before
starting the new containers, and checks `/api/health`. A failed migration stops
the release; a failed health check starts the previous image.

Public launch remains blocked until HTTPS, ICP status, legal pages, complaint
contact details, AI-generated-content labelling, model filing disclosure, the
150-case launch evaluation (102 retrieval, 18 exact patent-metadata, and 30
safety-boundary cases), independent expert review, private-OSS backup upload,
and a real backup restore drill are all evidenced.

## Licence

Copyright © 2026 OpenVac contributors.

This project is licensed under the GNU Affero General Public License,
version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).
