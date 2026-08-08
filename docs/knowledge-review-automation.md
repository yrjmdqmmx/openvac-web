# Codex knowledge review automation runbook

This workflow moves review-required current knowledge versions into the
`codex_automation_v1` queue and lets a local Codex scheduled task perform the
semantic review. It does not call the ChatGPT API, approve a source merely by
queueing it, publish content, create an automation, or provision object storage.

## Security boundary

- The web service receives only
  `KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256`. The plaintext token must never be
  placed in Compose, ECS configuration, Git, a prompt, or task output.
- The Mac runner reads the plaintext token from the local process environment as
  `OPENVAC_KNOWLEDGE_REVIEW_TOKEN`. Prefer macOS Keychain as the durable store and
  export it only for the process that runs the client.
- `.openvac/knowledge-review/` contains lease-bearing job bundles. It is ignored
  by Git, and the runner creates the directory as `0700` and files as `0600`.
- Claim leases last two hours on the server. A task must stop after 60 minutes;
  any unfinished lease becomes claimable again after expiry.
- API errors redact the configured token. Do not add shell tracing (`set -x`) or
  print environment variables while running this workflow.

Create and store a high-entropy token through an interactive trusted terminal.
Do not pass it as a command-line argument. One possible Keychain service name is
`openvac-knowledge-review`. Derive its lowercase SHA-256 locally and place only
that hash in the server's protected `.env`:

```bash
security find-generic-password -a "$USER" -s openvac-knowledge-review -w | shasum -a 256
```

After changing the protected server environment, restart only through the
normal reviewed deployment procedure. This runbook does not authorize a
deployment.

## Requeue existing pending knowledge

The command selects only the current non-empty version of documents in
`review`/`processing` whose version metadata still says
`reviewStatus=required`. This includes the pending CERN material. It creates only
an `initial`, `queued`, `gpt-5.5-codex`, `codex_automation_v1` run bound to that
exact version ID and content hash. The database unique key and `ON CONFLICT DO
NOTHING` make the write idempotent. It creates no approval, decision, risk,
embedding, or publication record.

Preview first (the default and the only mode without `--apply`):

```bash
pnpm knowledge:requeue-pending
```

After checking every version ID/hash in the preview, explicitly apply against
the intended non-production database:

```bash
pnpm knowledge:requeue-pending --apply
```

Do not run `--apply` against production without separate deployment/DB change
authorization. Rights gaps, the CERN formal-binary gate, unsupported numeric
claims, high risk, or incomplete evidence may correctly end as `needs_human`;
being in the queue is never approval.

## Local runner commands

Set the base URL and load the plaintext token from Keychain into the current
process without echoing it:

```bash
export OPENVAC_BASE_URL="https://staging-openvac.openvac.cn"
export OPENVAC_KNOWLEDGE_REVIEW_TOKEN="$(security find-generic-password -a "$USER" -s openvac-knowledge-review -w)"
```

Claim at most ten jobs for a phase and download their strict review packages:

```bash
pnpm knowledge:automation-runner claim --phase initial --max 10
pnpm knowledge:automation-runner claim --phase verify --max 10
```

The command prints only local job paths. Each job file contains the claim lease
and package. Codex reads the package, performs the semantic review itself, and
writes a separate submission file. Submit one reviewed job with:

```bash
pnpm knowledge:automation-runner submit --job .openvac/knowledge-review/initial-RUN_ID.json --report /absolute/private/path/initial-RUN_ID-report.json
```

The report file is a strict JSON object. Unknown fields are rejected:

```json
{
  "report": {
    "summary": "Concise review summary",
    "risk": "low",
    "decision": "approved",
    "findings": [{ "code": "CHECKED", "message": "What was checked" }],
    "blockers": [],
    "evidence": [
      {
        "claim": "Claim being assessed",
        "exactEvidence": "Exact supporting text from the package",
        "sourceLocator": "page/section/paragraph locator"
      }
    ],
    "numericClaims": []
  }
}
```

An initial report may additionally contain top-level `revisedContent`; the
server creates an immutable new version and queues verify. A verify report must
never contain `revisedContent`. Use `needs_human` when evidence, rights,
locators, units, scope, or safety cannot be established. Use `rejected` for a
demonstrably false or unsafe item; do not turn uncertainty into approval.

Always clear the plaintext variable when finished:

```bash
unset OPENVAC_KNOWLEDGE_REVIEW_TOKEN
```

## Suggested Codex scheduled tasks (not created by this repository)

Configure these in the Codex desktop app only after an operator explicitly
authorizes automation creation. Both tasks must use this repository as the
working directory, have a 60-minute maximum runtime, and process no more than
ten jobs per run.

### 09:00 initial review prompt

> Load `OPENVAC_BASE_URL` and `OPENVAC_KNOWLEDGE_REVIEW_TOKEN` from the approved
> local environment/Keychain without printing either. Run
> `pnpm knowledge:automation-runner claim --phase initial --max 10`. For each
> returned local job file, independently review the exact content, source-rights
> metadata, citations, numeric values, units, technical scope and safety using
> only the supplied package/original. Produce the strict result JSON documented
> in `docs/knowledge-review-automation.md`; use `needs_human` whenever evidence
> is incomplete. Submit with `knowledge:automation-runner submit`. Do not call a
> ChatGPT API, approve merely because the job was queued, exceed 60 minutes, or
> print credentials.

### 10:00 verification prompt

> Load the approved local runner environment without printing credentials. Run
> `pnpm knowledge:automation-runner claim --phase verify --max 10`. Independently
> verify the immutable current content and all initial findings against exact
> evidence and locators. Produce the same strict report but never include
> `revisedContent`; use `needs_human` for any mismatch or unresolved risk. Submit
> each completed report, stop within 60 minutes, and do not call a ChatGPT API.

If the Mac is asleep, offline, or Codex is unavailable at either scheduled time,
the server queue remains intact. Do not create a second queue or manually mark
runs complete. The next successful task run claims queued work; expired leases
are released by the claim transaction after two hours.

## Operator checks

Before enabling a schedule:

1. Confirm the server has the hash but not the plaintext token.
2. Run the requeue dry run and verify current version IDs/content hashes.
3. Exercise one staging initial claim/package/result, then one verify flow.
4. Confirm task output and logs contain neither token nor authorization header.
5. Confirm rights-blocked/high-risk material resolves to `needs_human` and no
   queued item becomes published merely because the automation ran.
