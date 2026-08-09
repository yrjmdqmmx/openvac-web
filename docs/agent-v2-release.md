# Agent V2 release and rollback

> Historical contract: Agent V3 now directly replaces V2. Use
> [`agent-v3-release.md`](agent-v3-release.md) for new releases. Keep this file
> only to understand the previous-image and V2-history rollback boundary.

Agent V2 is deployed as one release and activated atomically. Production does
not use percentage rollout. The legacy Chat Completions route remains available
only behind the master switch for an emergency application rollback.

## Required configuration

Set these server-only values independently in staging and production:

```dotenv
AGENT_RESPONSES_V2=true
AGENT_STALE_RUN_MS=210000
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_ALLOWED_HOSTS=api.deepseek.com
DEEPSEEK_RESPONSES_MODEL=deepseek-v4-flash
DEEPSEEK_USER_PARTITION_SECRET=
MODEL_INPUT_COST_MICROS_PER_MILLION_TOKENS=
MODEL_OUTPUT_COST_MICROS_PER_MILLION_TOKENS=
MODEL_PRICE_VERSION=
ALIBABA_WEB_SEARCH_COST_MICROS_PER_CALL=
ALIBABA_WEB_SEARCH_PRICE_VERSION=
```

`DEEPSEEK_USER_PARTITION_SECRET` must contain at least 32 random bytes and must
not be reused as an authentication, database, or modeling secret. The Responses
adapter refuses HTTP, credentials embedded in a URL, non-443 ports, and hosts
outside `DEEPSEEK_ALLOWED_HOSTS`.

`AGENT_RESPONSES_V2=true` only arms the environment. The database setting
`agent_responses_v2_enabled` is the atomic traffic switch. If the setting is
missing it is treated as enabled; an explicit JSON `false` immediately routes
new `/api/chat` requests back to the legacy path. A database read failure also
fails closed to legacy Chat.

## Staging acceptance

1. Deploy migration `0008_agent_v2_responses.sql` with the release. It only
   expands the schema; do not roll the database back when disabling Agent V2.
2. Keep the database switch false during migration and application health
   checks. Authenticate as an administrator and verify `GET
/api/admin/agent/status`: API key, partition secret, trusted URL, pricing,
   and budget policy must all report configured.
3. Run `pnpm test:all`. If a disposable PostgreSQL server is available, also
   run `RUN_DATABASE_TESTS=true pnpm exec vitest run
src/server/db/migration-upgrade.integration.test.ts`.
4. Run `pnpm smoke:deepseek`. The command sends one text-only Responses request,
   validates `openvac.answer.v2`, and prints only protocol, terminal state,
   answer kind, counts, and aggregate usage.
5. Enable the database switch with authenticated `PATCH
/api/admin/agent/status` and body `{ "enabled": true }`.
6. Complete browser smoke for automatic/deep reasoning, automatic/forced web,
   a deterministic calculation, citation navigation, cancel, retry, continue,
   regenerate, answer-version selection, memory create/edit/disable/delete,
   quota exhaustion, account deletion, V1 request compatibility, and a forced
   provider failure.
7. Confirm the browser never receives reasoning, tool arguments, raw tool
   output, provider request IDs, internal prompts, model names, or token cost.
   Verify failed/cancelled/incomplete history has no permanent skeleton and
   cannot be copied or rated.
8. Save the accepted Git SHA, migration result, smoke output, P95 measurements,
   and rollback result. Production must use this exact SHA.

The existing daily `problem-reports:cleanup` retention job also deletes Agent
tool-call rows whose 30-day `expires_at` has passed and marks orphaned active
runs as retryable `PROCESS_INTERRUPTED` failures. `AGENT_STALE_RUN_MS` must stay
above the longest configured run timeout (180 seconds by default). Confirm the
timer runs in both staging and production after migration 0008.

## Production cutover

Deploy the accepted staging SHA with the database switch false. After health,
migration, balance, configuration, real Responses, web, calculation, quota,
cancel, account-deletion, and legacy rollback smoke all pass, change the switch
to true once. Watch `GET /api/admin/agent/status` for active runs, terminal
statuses, provider phases, P95 latency, and pending knowledge review.

The release is blocked by any 401/402 provider response, citation boundary
failure, reasoning or secret leakage, failed migration, failed legacy rollback,
high-risk safety-boundary failure, or calculation gold-test failure. Human
review of already governed static knowledge is explicitly post-release work.

## Emergency rollback

Send authenticated `PATCH /api/admin/agent/status` with
`{ "enabled": false }`. Confirm its response reports disabled, then send a V2
browser request and verify it is served by the compatible legacy stream. Do not
reverse migration `0008`; Answer V2 history remains readable and all new tables
are retained. Runs already in progress are allowed to reach a terminal state or
can be cancelled individually.

If the application release itself must be rolled back, deploy the previous web
image using the normal release-set procedure only after the database switch is
false. The expand-only schema is compatible with the previous application.

## Post-release knowledge review

Use the existing knowledge administration queue. Sort pending records by
high-risk citation count, review status, and source priority. A rejection must
remove the record from new retrieval immediately. Existing answers retain their
citation snapshot and show that the source was withdrawn.
