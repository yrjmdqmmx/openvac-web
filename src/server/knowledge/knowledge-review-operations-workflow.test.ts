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
    expect(script).toContain("--no-deps");
    expect(script).not.toMatch(/ossutil|r2|delete-object|rm\s+-rf/);
  });
});
