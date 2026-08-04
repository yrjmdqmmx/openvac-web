# ECS deployment

## 1. Read-only audit

Copy `deploy/audit-ecs.sh` to the intended host and run it explicitly with
`sh audit-ecs.sh`, without sudo. Record:

- CPU count and available memory
- free disk space
- Docker Engine and Compose versions
- listening ports
- complete Nginx configuration

Do not deploy unless OpenVac can retain at least 2 vCPU, 4 GB memory budget, and
30 GB disk after accounting for existing services.

`deploy/preflight-host.sh` repeats the resource check before any Docker pull or
container execution. It requires at least 2 logical CPUs, 3,800,000 KiB of
visible memory (a nominal 4 GB host), and 31,457,280 KiB (30 GiB) available on
the target filesystem. Missing or non-numeric host data fails closed. The audit
is informational; this deploy-time preflight is the release gate.

## 2. Isolated Compose projects

- Staging: directory `/opt/openvac-staging`, Compose project
  `openvac-staging`, and localhost port `3011`.
- Production: directory `/opt/openvac`, Compose project
  `openvac-production`, and localhost port `3010`.

The release workflow passes the project name explicitly and `deploy.sh` rejects
every directory/project mismatch before calling Docker. Every pull, migration,
start, inspection, and rollback command uses that validated project name, so
the two deployments receive distinct containers, networks, and Postgres
volumes. The Compose file intentionally has no top-level `name`; local
`docker compose` commands continue to use the checkout directory as their
default project. Each deployment also keeps its own `.env`, backup directory,
and Nginx site. Never edit or replace another site configuration.

## 3. CI and environment gates

The release workflow must be dispatched from the repository default branch. It
requires an exact lowercase 40-character `commit_sha`; branch names, tags, and
short SHAs are not accepted. The commit must still be reachable from the current
default-branch history. Before building anything, the workflow queries the
GitHub Actions API for a completed, successful `CI` run whose `head_sha` is that
exact commit, whose source repository is this repository, whose `head_branch`
is the default branch, and whose event was a push or manual CI run. Both the
image builds and deployment-bundle checkout then use that same SHA. The web and
CAD-kernel images are built separately, must have distinct immutable digests,
and are deployed as one release set; mutable tags are never used for
activation. The ECS host authenticates to the private GHCR package with the
job-scoped GitHub token in an ephemeral mode-`0700` Docker configuration. The
token is supplied through `docker login --password-stdin` and both the token
file and temporary Docker configuration are removed after the run.

This rule applies to both staging and production. A feature-branch CI result is
never a deployment credential: branch code can change its own CI and deployment
scripts, while the ECS deployment credential can modify the host. Test a feature
branch through CI, merge it, and deploy the resulting default-branch commit.
Production additionally requires the latest GitHub deployment status for the
same SHA in the `staging` environment to be `success`; a successful run for a
different SHA cannot authorize production.

Create these two GitHub environments before enabling the workflow:

- `staging`: staging-only ECS secrets and an environment URL of
  `https://staging-openvac.openvac.cn`.
- `production`: production-only ECS secrets and an environment URL of
  `https://openvac.cn`.

For `production`, configure at least one required reviewer, restrict deployment
branches to the protected default branch, and disable administrator bypass
where the repository plan supports it. If the repository has a second trusted
reviewer, enable **Prevent self-review**; a one-owner repository must leave it
off or every production deployment becomes impossible. Treat
the absence of an enforceable required-reviewer rule as a production blocker,
not as implicit approval. Approval is given only after the staging acceptance
record identifies the same commit SHA. For a production dispatch, the CI gate
also reads the `production` environment through the GitHub API and refuses to
build unless it finds required reviewers and a branch policy. GitHub documents
the available environment protection controls in [Deployments and
environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

The workflow references the selected environment before SSH secrets are read,
so protected environment secrets are unavailable until its rules pass. Do not
also define ECS credentials as repository-level secrets; keep a separate copy
in each environment.

## 4. Secrets

Create the environment file directly on ECS with mode `0600`. Use RAM roles or
STS where Alibaba services support them. Never copy `.env` into Git, a Docker
image, CI logs, or chat.

Set `ALIBABA_OCR_ALLOWED_DOCUMENT_HOSTS` to the exact hostname used by private
OSS signed download URLs (for example, the bucket-qualified OSS hostname).
OCR fails closed when this allowlist is empty or does not match.

GitHub environment secrets:

- `ECS_HOST`
- `ECS_USER`
- `ECS_SSH_KEY`
- `ECS_KNOWN_HOSTS`
- `MODELING_SERVICE_TOKEN` (exactly 64 lowercase hexadecimal characters)

Generate independent modeling-service tokens for staging and production. The
release sends a token only over standard input to
`deploy/configure-modeling-runtime.sh`, which atomically updates the target
mode-`0600` `.env` without printing the value. An existing valid token cannot
be replaced by the release workflow; rotation requires a separate approved
procedure. Staging and production are separate GitHub environments as
described above.

### Alibaba Cloud DirectMail

Use the verified transactional sender `no-reply@mail.openvac.cn` in the
`cn-hangzhou` region. The application calls the DirectMail OpenAPI endpoint
`dm.aliyuncs.com`; it does not use SMTP, so no SMTP password is required.

Create these DirectMail tags before sending authentication mail:

- `auth-verify-email`
- `auth-reset-password`
- `auth-delete-account`
- `problem-report-notification`

Create a dedicated RAM user with OpenAPI access only and grant the minimum
custom policy below. Do not use the Alibaba Cloud account owner's AccessKey.

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dm:SingleSendMail"],
      "Resource": "*"
    }
  ]
}
```

Store its AccessKey only in the ECS environment file (mode `0600`) or a
protected GitHub environment secret. Where supported, restrict the credential
to the ECS public source IP. Set:

```dotenv
ALIBABA_DIRECTMAIL_ACCESS_KEY_ID=
ALIBABA_DIRECTMAIL_ACCESS_KEY_SECRET=
ALIBABA_DIRECTMAIL_ACCOUNT_NAME=no-reply@mail.openvac.cn
ALIBABA_DIRECTMAIL_REGION=cn-hangzhou
ALIBABA_DIRECTMAIL_ENDPOINT=dm.aliyuncs.com
PROBLEM_REPORT_NOTIFICATION_EMAIL=product-owner@example.com
```

`PROBLEM_REPORT_NOTIFICATION_EMAIL` is the product-owner-only destination for
best-effort problem-report alerts. The alert contains only the report ID,
category, received time, and admin link. It never sends an acknowledgement to
the reporting user and is silently skipped when the variable is empty.

Set `MODEL_INPUT_COST_MICROS_PER_MILLION_TOKENS` and
`MODEL_OUTPUT_COST_MICROS_PER_MILLION_TOKENS` from the provider's current
contract price before enabling a model budget in the admin console. The unit is
currency micros per one million tokens (1 CNY = 1,000,000 micros). An enabled
budget fails closed when either price is absent; this prevents a configured
cost breaker from silently treating paid calls as free.

For the first staging bootstrap, configure the model and DirectMail credentials
from a trusted local terminal. The helper disables terminal echo and sends the
three values to ECS over SSH standard input, so they do not enter shell history
or process arguments:

```bash
sh deploy/configure-staging-secrets.sh user@ecs-host
```

## 5. First release

1. Verify DNS and ICP state.
2. Install the new Nginx file under a new filename.
3. Obtain the dedicated TLS certificate.
4. Run `nginx -t`, then reload Nginx.
5. Trigger the workflow with the exact default-branch SHA, target `staging`,
   and `enable_modeling=true`. Before changing the active release it runs all
   modeling benchmarks for 20 iterations in the isolated CAD image, starts the
   authenticated CAD service, and verifies a private-OSS put/get/signed-HTTPS-
   download/delete round trip. Benchmark JSON is retained as a 30-day workflow
   artifact. Missing OSS credentials or any failed round trip stops the release.
6. Seed and activate the governed Phase 1 knowledge inside the deployed web
   container with `pnpm knowledge:seed` followed by
   `pnpm knowledge:activate-phase-one`. Verify the reported document and chunk
   counts, then exercise registration, verification, reset, 20-way quota
   concurrency, citation links, message feedback, problem reports, admin roles,
   publishing/rollback, and budget circuit breaking.
7. Run the 150-case evaluation: 102 full-text Top-5 retrieval cases, 18
   exact patent-metadata cases, and 30 safety-boundary cases. Human technical
   review remains visible and can be
   completed after initial activation; a rejected record must disappear from
   retrieval immediately.
8. Perform a new-host deployment, a forced migration failure, a forced health
   failure, and `restore-drill.sh`. Confirm both failures restart and health
   check the previous application image while `current-release` remains
   unchanged.
9. Trigger production with the same SHA only after the signed staging
   acceptance record. Production repeats the complete benchmark suite once as
   a smoke check and repeats CAD/OSS runtime verification before activation.

Migrations must remain backward-compatible with the previously deployed
application. Before every managed upgrade, `deploy.sh` requires a successful
logical backup from the active release; a running container without a
`current-release` record is treated as an unmanaged state and refused. On
migration, runtime-verification, container-start, or health failure,
`deploy.sh` explicitly restarts the previous web/worker and modeling release
set and requires its health checks to pass. It does not
automatically restore the database because doing so can discard live writes;
use the pre-release backup and an approved recovery procedure for a data
rollback.

Migration `0007_consultation_rollback_compat.sql` keeps `problem_report` as the
single source of truth while exposing a writable `security_invoker`
`consultation` compatibility view for the previously deployed application.
This is what allows an application-image rollback after the irreversible
`0002` table rename. The current Compose deployment uses the database owner as
its runtime role. If migration and runtime roles are separated later, grant the
runtime role access to both the view and base table explicitly and add a
split-role integration test. Rows whose historical `resolved`/`closed`
distinction was already collapsed by `0002` fall back to `closed`; that lost
historical distinction cannot be reconstructed from the current database.

Migration `0008_agent_v2_responses.sql` adds only Agent V2 tables, enums,
indexes, foreign keys, and nullable compatibility columns. Keep this migration
in place when the Agent V2 database switch is disabled; the previous Chat route
ignores the new schema while Answer V2 history remains readable. Follow the
same-SHA staging acceptance and atomic cutover procedure in
[`agent-v2-release.md`](agent-v2-release.md).

### Offline staging bootstrap

If the ECS host cannot reach Docker Hub, manually dispatch
`.github/workflows/offline-image.yml` from the exact release branch. The job
builds separate `linux/amd64` web and CAD-kernel archives and exports the pinned
`pgvector/pgvector:pg17` database image as a third archive. Each artifact has a
SHA-256 checksum and is retained for one day. Download and verify all three
locally, then stream each decompressed archive to `docker load` over the
approved SSH path. The workflow never receives ECS credentials and never
connects to the server.

## 6. Backup, private OSS, and restore drills

> Staging status as of 2026-08-01: private-OSS backup upload, the dedicated OSS
> RAM credential file, and the recurring backup timer are not yet configured.
> The commands below are required setup instructions, not evidence that those
> controls are active. Until configuration, a successful upload and an
> isolated restore drill are recorded, public launch remains blocked.

### Explicit deployment context

Every backup and restore command requires `production` or `staging`. The
scripts map that target to a fixed deploy directory, Compose project, host
`.env`, and the Compose file under the SHA recorded in `current-release`. Every
Docker invocation includes `--project-name`, `--env-file`, and `-f`; it never
depends on the caller's current directory or Compose's inferred project name.

The scripts reject symlinks for the deploy directory, `.env`, releases
directory, active release, Compose file, backup directory, archive, and
checksum. The host `.env` must be mode `0600`, the backup directory is mode
`0700`, archives are mode `0600`, and every archive has a SHA-256 sidecar.
Release activation and deployment also reject malformed or truncated image
digests; the accepted form is a GHCR repository followed by one exact,
lowercase 64-character SHA-256 digest.

Run a one-off production backup from the installed scripts with:

```bash
sudo /bin/bash /usr/local/libexec/openvac/backup.sh production
```

### Daily 02:30 backup and private upload

The systemd example runs production backup at 02:30 Asia/Shanghai every day,
uploads the archive and checksum with an explicit private object ACL, and only
then rotates local archives older than `BACKUP_RETENTION_DAYS=30`. A failed
upload leaves the local backup in place and prevents rotation.

Install a pinned `ossutil` release from Alibaba Cloud's official distribution
and verify its published checksum. Then install reviewed copies of the scripts
and units; do not use symlinks:

```bash
sudo install -d -m 0755 /usr/local/libexec/openvac
sudo install -m 0755 \
  deploy/backup.sh \
  deploy/backup-to-oss.sh \
  deploy/upload-backup-oss.sh \
  deploy/rotate-backups.sh \
  deploy/restore-drill.sh \
  /usr/local/libexec/openvac/
sudo install -d -m 0700 /etc/openvac
sudo install -m 0600 deploy/backup.env.example /etc/openvac/backup.env
sudo install -d -m 0700 /opt/openvac/backups
sudo install -m 0644 deploy/systemd/openvac-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/openvac-backup.timer /etc/systemd/system/
sudoedit /etc/openvac/backup.env
sudo systemctl daemon-reload
sudo systemctl start openvac-backup.service
sudo journalctl -u openvac-backup.service --since today
sudo systemctl enable --now openvac-backup.timer
systemctl list-timers openvac-backup.timer
```

Use a dedicated private OSS bucket and a dedicated RAM identity limited to
uploading objects beneath `openvac/backups/`. The service reads
`OSS_ACCESS_KEY_ID`, `OSS_ACCESS_KEY_SECRET`, and optional `OSS_SESSION_TOKEN`
only from the root-owned environment file; the upload script never passes keys
as command arguments or writes an ossutil credential file. Alibaba Cloud lists
these supported variables in the [ossutil credential
documentation](https://help.aliyun.com/en/oss/developer-reference/ossutil-overview/).
The upload requires `oss:PutObject`; grant lifecycle-administration permissions
to a separate setup identity, not to the daily service.

The checked-in lifecycle example expires only
`openvac/backups/production/` objects after 30 days. Applying a lifecycle file
can replace existing bucket rules: first export the bucket's current lifecycle,
merge and review every rule, then use a separately approved admin session to
apply `deploy/oss/lifecycle-30-days.xml`. Do not automate this one-time
destructive configuration in the daily timer. See Alibaba Cloud's [ossutil
lifecycle command](https://help.aliyun.com/en/oss/developer-reference/lifecycle).

### Restore drill

Copy the chosen archive and its `.sha256` sidecar into the matching target's
backup directory, then run:

```bash
sudo /bin/bash /usr/local/libexec/openvac/restore-drill.sh \
  production \
  /opt/openvac/backups/openvac-YYYYMMDDTHHMMSSZ-SUFFIX.sql.gz
```

`restore-drill.sh` verifies the path, symlink policy, checksum, gzip stream, and
that the restored public schema contains at least one table, then recreates
only the fixed `openvac_restore_drill` database. A failed drill drops the
partial drill database; a successful drill retains it for inspection. The
script has no parameter that can select or overwrite the production database.

## 7. Problem-report retention cleanup

Problem-report contact details expire 30 days after a report is closed, and the
report body expires after at most 180 days. Install the cleanup wrapper and the
templated systemd units so those database rules are enforced automatically:

```bash
sudo install -d -m 0755 /usr/local/libexec/openvac
sudo install -m 0755 \
  deploy/cleanup-problem-reports.sh \
  /usr/local/libexec/openvac/
sudo install -m 0644 \
  deploy/systemd/openvac-problem-report-cleanup@.service \
  deploy/systemd/openvac-problem-report-cleanup@.timer \
  /etc/systemd/system/
sudo systemd-analyze verify \
  /etc/systemd/system/openvac-problem-report-cleanup@.service \
  /etc/systemd/system/openvac-problem-report-cleanup@.timer
sudo systemctl daemon-reload
```

The timer runs daily at 05:00 Asia/Shanghai, after the 02:30 backup window.
Enable and test each environment separately; do not enable production merely
because staging succeeds:

```bash
sudo systemctl start openvac-problem-report-cleanup@staging.service
sudo journalctl \
  -u openvac-problem-report-cleanup@staging.service \
  --since today
sudo systemctl enable --now \
  openvac-problem-report-cleanup@staging.timer
systemctl list-timers \
  openvac-problem-report-cleanup@staging.timer

# Only after the production release and retention behavior are approved:
sudo systemctl start openvac-problem-report-cleanup@production.service
sudo systemctl enable --now \
  openvac-problem-report-cleanup@production.timer
```

The wrapper accepts only `production` or `staging`, maps each to its fixed
deployment directory and Compose project, and resolves the Compose file from
the validated 40-character SHA in `current-release`. It rejects symlinked
deployment state and requires the host `.env` to be a regular mode-`0600` file.
Every Compose call includes the explicit project, environment file, and active
release file. Cleanup runs inside the already-running managed `web` container;
the host does not source or print the environment file, and the systemd unit
does not load secrets into its own environment. Logs contain only the cleanup
counts emitted by `problem-reports:cleanup`.
