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

## 3. Secrets

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

Staging and production are separate protected GitHub environments. Production
requires manual approval.

### Alibaba Cloud DirectMail

Use the verified transactional sender `no-reply@mail.openvac.cn` in the
`cn-hangzhou` region. The application calls the DirectMail OpenAPI endpoint
`dm.aliyuncs.com`; it does not use SMTP, so no SMTP password is required.

Create these DirectMail tags before sending authentication mail:

- `auth-verify-email`
- `auth-reset-password`
- `auth-delete-account`

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
ALIBABA_DIRECTMAIL_ACCOUNT_NAME=no-reply@mail.openvac.cn
ALIBABA_DIRECTMAIL_REGION=cn-hangzhou
ALIBABA_DIRECTMAIL_ENDPOINT=dm.aliyuncs.com
```

## 4. First release

1. Verify DNS and ICP state.
2. Install the new Nginx file under a new filename.
3. Obtain the dedicated TLS certificate.
4. Run `nginx -t`, then reload Nginx.
5. Trigger the workflow with target `staging`.
6. Exercise registration, verification, reset, 20-way quota concurrency,
   citation links, feedback, consultation, admin roles, publishing/rollback,
   and budget circuit breaking.
7. Run the 120-question retrieval evaluation and 30-case expert review.
8. Perform a new-host deployment, upgrade rollback, and `restore-drill.sh`.
9. Trigger production only after the signed acceptance record.

## Backup

`deploy/backup.sh` requires an explicit OpenVac backup directory, refuses
symlink targets and group/world-accessible directories, applies a restrictive
umask, and writes a compressed logical database backup. Production should
upload the resulting archive to a private OSS prefix and delete local rotations
only under a separately reviewed retention policy.

`deploy/restore-drill.sh` restores into the isolated
`openvac_restore_drill` database and retains it for inspection. It never
overwrites the production database.
