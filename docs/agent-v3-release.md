# Agent V3 direct replacement release and rollback

Agent V3 directly replaces Agent V2. It is not a percentage rollout and there
is no long-lived V2/V3 traffic split. The release uses additive database
migration, automated staging acceptance, production promotion of the exact
staging image digest, and application rollback to the previously recorded
image.

This document is a deployment contract only. Completing these steps in the
repository does not authorize or claim an actual staging or production
operation.

## Preconditions and ownership

The storage workstream supplies the attachment/artifact schema migration,
private object lifecycle, quota settlement, account export, and account
deletion. That migration must be additive and backward-compatible with the
previous application image. Do not add a destructive down migration and do not
remove the existing V2 tables or plaintext `message.content` projection.

The agent/provider workstreams supply the V3 runtime, Qwen visual provider, and
the live evaluation adapter. The artifacts/evals workstream supplies the
strict renderers and gate. This workstream does not implement the Composer,
Qwen provider, attachment database schema, or production operation.

## Automated staging acceptance

Build the production-target OCI image once from the accepted default-branch
Git SHA. Record both the 40-character Git SHA and immutable
`sha256:<64 lowercase hex>` image digest before changing staging.

The staging workflow must then perform these steps without a manual score
override:

1. Take the required pre-migration backup and run the additive migration. A
   migration failure must restart the previous image while leaving
   `current-release` unchanged.
2. Install with `pnpm install --frozen-lockfile`, then run `pnpm test:all` and
   the database migration-upgrade integration test when PostgreSQL is
   available.
3. Run `pnpm test:e2e:agent-v3`. The checked-in mocks make the upload, link,
   image, table, artifact, quota, deletion, old-history, and failed-version
   browser contract executable. Mock success is necessary but is not a
   substitute for the authenticated staging smoke below.
4. Set `ANSWER_V3_EVAL_ADAPTER` to the reviewed live adapter and run
   `pnpm eval:answer:v3:live`. DeepSeek text outputs must be judged by an
   independent Qwen model. Qwen visual outputs must pass standard fact checks
   and a DeepSeek cross-judge. A missing, unreachable, malformed, or same-model
   judge is a failure, never a skip.
5. Archive the generated Answer V3 report. It must record the Git SHA, case
   version, candidate and judge model versions, category scores, deterministic
   gate scores, and failed case IDs. Safety, citation, link, permission, and
   tool-protocol gates must each equal 100%; aggregate score must be at least
   90%; text, multi-turn, visual, document-QA, and artifact categories must
   each be at least 85%.
6. Generate Chinese MD, DOCX, PDF, and CSV samples inside the built image.
   Verify deterministic checksums, valid DOCX ZIP structure, PDF page render,
   Chinese glyphs, tables, and CSV formula hardening. Force one renderer
   failure and confirm the text answer remains completed while the artifact is
   `failed` with no download.
7. Complete authenticated browser smoke for five-file upload, the 25 MiB file
   limit, 500 MiB shared quota, verified and unavailable links, private image
   preview, document QA, tables, all four artifact downloads, attachment and
   account deletion, V2 plaintext history, terminal-version reconciliation,
   and forced provider/tool/render failures.
8. Confirm browser events contain localized status and validated answer blocks
   only. They must not contain raw tool arguments/output, internal object keys,
   signed URLs, prompts, reasoning, provider request IDs, model names, or token
   cost.
9. Rehearse rollback to the previously recorded image digest. The previous
   web and worker must become healthy without reversing the additive schema.

The signed staging acceptance record contains the Git SHA, exact image digest,
migration result, test commands, Answer V3 report, browser evidence, artifact
checksums, health result, and previous-image rollback result. Any missing field
blocks production.

## Production promotion

Production must consume the same immutable image digest accepted in staging.
Do not rebuild, retag by a mutable name, or accept a matching Git SHA with a
different digest. The existing release workflow's staging provenance and
protected production approval remain mandatory.

Apply the same additive migration through the managed deployment transaction,
start web and worker from the accepted digest, and run health plus a bounded
smoke that does not create unreviewed persistent data. Promote the release
pointer only after health succeeds. Monitor terminal run states, artifact
failure rate, storage quota settlement, provider/judge availability, latency,
and deletion jobs.

Production is blocked by any migration or health failure, judge unavailable
result, deterministic gate below 100%, aggregate score below 90%, category
score below 85%, unsafe or unverified link, citation boundary failure, private
data leak, Chinese render failure, quota bypass, deletion failure, or rollback
rehearsal failure.

## Previous-image rollback

On a V3 application regression, activate the previous image digest recorded by
the managed release state and restore its web and worker together. Do not run a
database down migration: the additive V3 schema, V2 history, attachment rows,
artifact metadata, and private objects remain in place for a corrected image.

Verify the previous image health check and a V2 history read after rollback.
Do not delete new private objects merely because the old application ignores
them; normal retention and account-deletion jobs retain ownership. If the
additive migration itself corrupted data, stop and use the approved backup
recovery procedure rather than treating an image rollback as a database
restore.
