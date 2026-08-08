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
    expect(workflow).toContain("REQUEUE_PENDING");
    expect(workflow).toContain("secrets.ECS_SSH_KEY");
    expect(workflow).toContain("secrets.ECS_KNOWN_HOSTS");
    expect(workflow).toContain("secrets.ECS_HOST");
    expect(workflow).toContain("secrets.ECS_USER");
    expect(workflow).not.toContain("DATABASE_URL");
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
});
