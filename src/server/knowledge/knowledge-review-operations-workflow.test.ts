import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const workflowPath = resolve(
  repositoryRoot,
  ".github/workflows/knowledge-review-operations.yml"
);
const operationScriptPath = resolve(
  repositoryRoot,
  "deploy/run-knowledge-review-operation.sh"
);

describe("knowledge review production operations", () => {
  it("keeps requeue behind production approval and the deployment concurrency lock", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("environment:\n      name: production");
    expect(workflow).toContain("group: deploy-production");
    expect(workflow).toContain("expected_release_sha:");
    expect(workflow).toContain("confirmation:");
    expect(workflow).toContain("diagnostic_request_id:");
    expect(workflow).toContain("diagnose-request");
    expect(workflow).toContain("retry-verify-evidence");
    expect(workflow).toContain("diagnose-review-pair");
    expect(workflow).toContain("RETRY_VERIFY_EVIDENCE");
    expect(workflow).toContain("retry_document_id:");
    expect(workflow).toContain("retry_version_id:");
    expect(workflow).toContain("retry_run_id:");
    expect(workflow).toContain("retry_content_hash:");
    expect(workflow).toContain(
      'diagnostic_argument="${DIAGNOSTIC_REQUEST_ID:-_}"'
    );
    expect(workflow).toContain('retry_run_argument="${RETRY_RUN_ID:-_}"');
    expect(workflow).toContain(
      '"$RETRY_DOCUMENT_ID" "$RETRY_VERSION_ID" "$retry_run_argument" "$RETRY_CONTENT_HASH"'
    );
    expect(workflow).toContain("REQUEUE_PENDING");
    expect(workflow).toContain("secrets.ECS_SSH_KEY");
    expect(workflow).toContain("secrets.ECS_KNOWN_HOSTS");
    expect(workflow).toContain("secrets.ECS_HOST");
    expect(workflow).toContain("secrets.ECS_USER");
    expect(workflow).not.toContain("DATABASE_URL");
  });

  it("only preserves an empty retry-run argument for embedding-job retries", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain(
      `retry_run_argument="$RETRY_RUN_ID"
          if [ "$MODE" = retry-embedding-job ]; then
            retry_run_argument="${"${RETRY_RUN_ID:-_}"}"
          fi`
    );
    expect(workflow).not.toContain(
      `diagnostic_argument="${"${DIAGNOSTIC_REQUEST_ID:-_}"}"
          retry_run_argument="${"${RETRY_RUN_ID:-_}"}"
          ssh`
    );
  });

  it("binds execution to the current immutable release and defaults to preview", () => {
    const script = readFileSync(operationScriptPath, "utf8");

    execFileSync("sh", ["-n", operationScriptPath]);
    expect(script).toContain("current-release");
    expect(script).toContain("deployment-transaction");
    expect(script).toContain('mode="${3:-preview}"');
    expect(script).toContain("knowledge:requeue-pending");
    expect(script).toContain('operation_args="--apply"');
    expect(script).toContain("diagnose-request");
    expect(script).toContain("retry-verify-evidence");
    expect(script).toContain("diagnose-review-pair");
    expect(script).toContain('[ "$diagnostic_request_id" = _ ]');
    expect(script).toContain('[ "$retry_run_id" = _ ]');
    expect(script).toContain("AUTOMATION_REVIEW_NUMERIC_EVIDENCE_MISSING");
    expect(script).toContain("AUTOMATION_REVIEW_PAIR_MISSING_OR_MISMATCHED");
    expect(script).toContain(
      "knowledge.automation_review.retry_verify_evidence"
    );
    expect(script).toContain("FOR UPDATE OF r, kd, kv");
    expect(script).toContain("status = 'queued'");
    expect(script).toContain("structured_report = '{}'::jsonb");
    expect(script).toContain("retryEligibility");
    expect(script).toContain("metadataReasonMatches");
    expect(script).toContain("reasonCodes");
    expect(script).toContain("initialRunMatches");
    expect(script).toContain("previousReasons");
    expect(script).toContain("pairSchemaParse");
    expect(script).toContain("knowledgeAutomationReviewRunSchema.safeParse");
    expect(script).toContain("publicationState");
    expect(script).toContain("documentStatus");
    expect(script).toContain("versionStatus");
    expect(script).toContain("embeddingStatus");
    expect(script).toContain("embeddedChunks");
    expect(script).toContain("pendingWorkerJobs");
    expect(script).toContain("failedWorkerJobs");
    expect(script).toContain("workerJobs");
    expect(script).toContain("readyNow");
    expect(script).toContain("hasLastError");
    expect(script).toContain("lastErrorClass");
    expect(script).toContain("lastErrorSignals");
    expect(script).toContain("providerTimeout");
    expect(script).toContain("authentication");
    expect(script).toContain("rateLimited");
    expect(script).toContain("configuration");
    expect(script).toContain("database");
    expect(script).toContain("vectorShape");
    expect(script).toContain("leaseStale");
    expect(script).toContain("lockedAgeSeconds");
    expect(script).toContain("workerRuntime");
    expect(script).toContain("restartCount");
    expect(script).toContain("workerRecentErrors");
    expect(script).toContain("tail -n 9");
    expect(script).toContain("[URL_REDACTED]");
    expect(script).toContain("[TOKEN_REDACTED]");
    expect(script).toContain("[DETAIL_REDACTED]");
    expect(script).toContain("normalizeDatabaseTimestamp");
    expect(script).toContain("PostgresError");
    expect(script).toContain("[DETAIL_REDACTED]");
    expect(script).toContain("--no-deps");
    expect(script).not.toMatch(/ossutil|r2|delete-object|rm\s+-rf/);
  });

  it("guards exact embedding-job retry inputs in the production workflow", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("- retry-embedding-job");
    expect(workflow).toContain("RETRY_EMBEDDING_JOB");
    expect(workflow).toContain(
      "retry-embedding-job requires the exact confirmation RETRY_EMBEDDING_JOB"
    );
    expect(workflow).toContain('test -z "$DIAGNOSTIC_REQUEST_ID"');
    expect(workflow).toContain('test -z "$RETRY_RUN_ID"');
    expect(workflow).toContain(
      'for retry_uuid in "$RETRY_DOCUMENT_ID" "$RETRY_VERSION_ID"; do'
    );
    expect(workflow).toContain(
      "grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'"
    );
    expect(workflow).toContain(
      `printf '%s\\n' "$RETRY_CONTENT_HASH" | grep -Eq '^[0-9a-f]{64}$'`
    );
    expect(workflow).toContain("environment:\n      name: production");
    expect(workflow).toContain("group: deploy-production");
    expect(workflow).not.toContain("DATABASE_URL");
  });

  it("only requeues the one exact eligible embedding task and audits without error text", () => {
    const script = readFileSync(operationScriptPath, "utf8");
    const retryStart = script.lastIndexOf(
      'if [ "$mode" = retry-embedding-job ]; then'
    );
    const retryEnd = script.indexOf(
      'if [ "$mode" = retry-verify-evidence ] ||',
      retryStart
    );
    expect(retryStart).toBeGreaterThan(-1);
    expect(retryEnd).toBeGreaterThan(retryStart);
    const retryBlock = script.slice(retryStart, retryEnd);

    execFileSync("sh", ["-n", operationScriptPath]);
    expect(script).toContain("retry-embedding-job");
    expect(script).toContain('elif [ "$mode" = retry-embedding-job ]; then');
    expect(script).toContain('[ -z "$diagnostic_request_id" ]');
    expect(script).toContain('[ -z "$retry_run_id" ]');
    expect(script).toContain(
      'for retry_uuid in "$retry_document_id" "$retry_version_id"; do'
    );
    expect(retryBlock).toContain("BEGIN;");
    expect(retryBlock).toContain("SET LOCAL lock_timeout = '5s';");
    expect(retryBlock).toContain("pg_advisory_xact_lock");
    expect(retryBlock).toContain("FOR UPDATE OF bt, kd, kv, ks");
    expect(retryBlock).toContain("knowledge_ingestion");
    expect(retryBlock).toContain(
      "knowledge-embedding:' || kv.id::text || ':' || kv.content_hash || ':codex_automation_v1'"
    );
    expect(retryBlock).toContain("bt.status = 'failed'");
    expect(retryBlock).toContain("bt.status = 'running'");
    expect(retryBlock).toContain("INTERVAL '15 minutes'");
    expect(retryBlock).toContain(
      "bt.payload ->> 'stage' = 'embedding_pending'"
    );
    expect(retryBlock).toContain("bt.payload ->> 'documentId' = kd.id::text");
    expect(retryBlock).toContain("bt.payload ->> 'versionId' = kv.id::text");
    expect(retryBlock).toContain(
      "bt.payload #>> '{review,status}' = 'approved'"
    );
    expect(retryBlock).toContain(
      "bt.payload #>> '{review,contentHash}' = kv.content_hash"
    );
    expect(retryBlock).toContain(
      "bt.payload #>> '{review,policyVersion}' = 'codex_automation_v1'"
    );
    expect(retryBlock).toContain("bt.payload #>> '{review,risk}' = 'low'");
    expect(retryBlock).toContain(
      "bt.payload #>> '{review,initialRunId}' = kv.metadata #>> '{review,initialRunId}'"
    );
    expect(retryBlock).toContain(
      "bt.payload #>> '{review,verifyRunId}' = kv.metadata #>> '{review,verifyRunId}'"
    );
    expect(retryBlock).toContain("kd.current_version_id = kv.id");
    expect(retryBlock).toContain("kd.status = 'review'");
    expect(retryBlock).toContain("kv.status = 'review'");
    expect(retryBlock).toContain("kv.published_at IS NULL");
    expect(retryBlock).toContain("kv.content_hash = :'retry_content_hash'");
    expect(retryBlock).toContain("kv.metadata ->> 'reviewStatus' = 'approved'");
    expect(retryBlock).toContain(
      "kv.metadata ->> 'embeddingStatus' = 'queued'"
    );
    expect(retryBlock).toContain(
      "kv.metadata #>> '{review,status}' = 'approved'"
    );
    expect(retryBlock).toContain(
      "kv.metadata #>> '{review,contentHash}' = kv.content_hash"
    );
    expect(retryBlock).toContain(
      "kv.metadata #>> '{review,policyVersion}' = 'codex_automation_v1'"
    );
    expect(retryBlock).toContain("kv.metadata #>> '{review,risk}' = 'low'");
    expect(retryBlock).toContain("ks.enabled = TRUE");
    expect(retryBlock).toContain("ks.deleted_at IS NULL");
    expect(retryBlock).toContain("FROM knowledge_chunk kc");
    expect(retryBlock).toContain("sibling.status IN ('queued', 'running')");
    expect(retryBlock).toContain(
      "initial.id = (kv.metadata #>> '{review,initialRunId}')::uuid"
    );
    expect(retryBlock).toContain(
      "verify.id = (kv.metadata #>> '{review,verifyRunId}')::uuid"
    );
    expect(retryBlock).toContain("initial.id <> verify.id");
    expect(retryBlock).toContain("initial.phase = 'initial'");
    expect(retryBlock).toContain("verify.phase = 'verify'");
    expect(retryBlock).toContain("initial.status = 'completed'");
    expect(retryBlock).toContain("verify.status = 'completed'");
    expect(retryBlock).toContain("initial.decision = 'approved'");
    expect(retryBlock).toContain("verify.decision = 'approved'");
    expect(retryBlock).toContain("initial.risk = 'low'");
    expect(retryBlock).toContain("verify.risk = 'low'");
    expect(retryBlock).toContain(
      "initial.prompt_version = 'codex_automation_v1'"
    );
    expect(retryBlock).toContain(
      "verify.prompt_version = 'codex_automation_v1'"
    );
    expect(retryBlock).toContain("verify.input_version_id = kv.id");
    expect(retryBlock).toContain("verify.input_content_hash = kv.content_hash");
    expect(retryBlock).toContain(
      "(initial.input_version_id = kv.id AND initial.input_content_hash = kv.content_hash)"
    );
    expect(retryBlock).toContain("OR initial.revised_version_id = kv.id");
    expect(retryBlock).toContain(
      "initial.structured_report ->> 'outputContentHash' = kv.content_hash"
    );
    expect(retryBlock).toContain(
      "verify.structured_report ->> 'outputContentHash' = kv.content_hash"
    );
    expect(retryBlock).toContain(
      "initial.structured_report #>> '{automation,outputVersionId}' = kv.id::text"
    );
    expect(retryBlock).toContain(
      "verify.structured_report #>> '{automation,outputVersionId}' = kv.id::text"
    );
    expect(retryBlock).toContain("status = 'queued'");
    expect(retryBlock).toContain("run_at = NOW()");
    expect(retryBlock).toContain(
      "max_attempts = GREATEST(bt.max_attempts, bt.attempts + 1)"
    );
    expect(retryBlock).toContain("locked_at = NULL");
    expect(retryBlock).toContain("locked_by = NULL");
    expect(retryBlock).toContain("lease_token = NULL");
    expect(retryBlock).toContain("completed_at = NULL");
    expect(retryBlock).toContain("last_error = NULL");
    expect(retryBlock).not.toMatch(/\battempts\s*=/);
    expect(retryBlock).toContain("knowledge.embedding.retry_job");
    expect(retryBlock).toContain("SELECT NULL, 'system'");
    expect(retryBlock).toContain("'background_task'");
    expect(retryBlock).toContain("'previousStatus'");
    expect(retryBlock).toContain("'previousAttempts'");
    expect(retryBlock).toContain("'previousMaxAttempts'");
    expect(retryBlock).toContain("'hadLastError'");
    expect(retryBlock).toContain("'taskId'");
    expect(retryBlock).toContain("'attemptsPreserved'");
    expect(retryBlock).toContain("'maxAttempts'");
    expect(retryBlock).toContain("'audited'");
    expect(retryBlock).toContain("'taskExists'");
    expect(retryBlock).toContain("'taskStateEligible'");
    expect(retryBlock).toContain("'taskPayloadMatches'");
    expect(retryBlock).toContain("'currentTarget'");
    expect(retryBlock).toContain("'reviewPair'");
    expect(retryBlock).toContain("'chunksAbsent'");
    expect(retryBlock).toContain("'siblingAbsent'");
    expect(retryBlock).toContain("WITH requested AS (");
    expect(retryBlock).toContain(
      "'knowledge-embedding:' || :'retry_version_id' || ':' || :'retry_content_hash' || ':codex_automation_v1'"
    );
    expect(retryBlock).toContain("printf '%s\\n' \"$retry_diagnostics\" >&2");
    expect(retryBlock).toContain("exit 1");
    expect(retryBlock).not.toMatch(/INSERT\s+INTO\s+background_task/i);
    expect(retryBlock).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+knowledge_chunk/i
    );
    expect(retryBlock).not.toMatch(/(?:kd|kv)\.status\s*=\s*'published'/i);
    expect(retryBlock).not.toMatch(/'lastError'\s*,/);
  });
});
