import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const script = "deploy/configure-dashscope-workspace-id.sh";
const workspaceId = "workspace_test_01";

describe("DashScope workspace deployment", () => {
  it("atomically adds or replaces only the protected workspace identifier", () => {
    const root = mkdtempSync(join(tmpdir(), "openvac-workspace-"));
    const deployDir = join(root, "openvac-staging");
    mkdirSync(deployDir, { recursive: true });
    const envFile = join(deployDir, ".env");
    writeFileSync(envFile, "APP_URL=https://staging.example\n", {
      mode: 0o600
    });

    execFileSync("sh", [script, "staging"], {
      cwd: process.cwd(),
      env: { ...process.env, OPENVAC_CONFIG_ROOT: root },
      input: `${workspaceId}\n`,
      stdio: ["pipe", "pipe", "pipe"]
    });
    expect(readFileSync(envFile, "utf8")).toBe(
      `APP_URL=https://staging.example\nDASHSCOPE_WORKSPACE_ID=${workspaceId}\n`
    );

    execFileSync("sh", [script, "staging"], {
      cwd: process.cwd(),
      env: { ...process.env, OPENVAC_CONFIG_ROOT: root },
      input: "workspace_test_02\n",
      stdio: ["pipe", "pipe", "pipe"]
    });
    expect(
      readFileSync(envFile, "utf8").match(/^DASHSCOPE_WORKSPACE_ID=/gmu)
    ).toHaveLength(1);
    expect(readFileSync(envFile, "utf8")).not.toContain(workspaceId);
  });

  it("fails closed without echoing invalid or duplicate identifiers", () => {
    const root = mkdtempSync(join(tmpdir(), "openvac-workspace-"));
    const deployDir = join(root, "openvac");
    mkdirSync(deployDir, { recursive: true });
    const envFile = join(deployDir, ".env");
    writeFileSync(
      envFile,
      `DASHSCOPE_WORKSPACE_ID=${workspaceId}\nDASHSCOPE_WORKSPACE_ID=${workspaceId}\n`,
      { mode: 0o600 }
    );

    const duplicate = spawnSync("sh", [script, "production"], {
      cwd: process.cwd(),
      env: { ...process.env, OPENVAC_CONFIG_ROOT: root },
      input: `${workspaceId}\n`,
      encoding: "utf8"
    });
    expect(duplicate.status).not.toBe(0);
    expect(`${duplicate.stdout}${duplicate.stderr}`).not.toContain(workspaceId);

    chmodSync(envFile, 0o644);
    const unsafe = spawnSync("sh", [script, "production"], {
      cwd: process.cwd(),
      env: { ...process.env, OPENVAC_CONFIG_ROOT: root },
      input: `${workspaceId}\n`,
      encoding: "utf8"
    });
    expect(unsafe.status).not.toBe(0);

    const invalid = spawnSync("sh", [script, "production"], {
      cwd: process.cwd(),
      env: { ...process.env, OPENVAC_CONFIG_ROOT: root },
      input: "workspace id with spaces\n",
      encoding: "utf8"
    });
    expect(invalid.status).not.toBe(0);
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain(
      "workspace id with spaces"
    );
  });

  it("uses an environment-scoped secret and private staging file", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    expect(workflow).toContain(
      "DASHSCOPE_WORKSPACE_ID: ${{ secrets.DASHSCOPE_WORKSPACE_ID }}"
    );
    expect(workflow).toContain("openvac-dashscope-workspace-id");
    expect(workflow).toContain("dashscope-workspace-id");
    expect(workflow).not.toContain("secrets.DASHSCOPE_API_KEY");
    expect(workflow).not.toContain("secrets.QWEN_VL_API_KEY");
  });

  it("updates and rolls back the workspace identifier inside activation", () => {
    const deploy = readFileSync("deploy/deploy.sh", "utf8");
    const journal = deploy.indexOf("if ! begin_transaction_journal");
    const apply = deploy.indexOf("if ! apply_runtime_env", journal);
    const migration = deploy.indexOf('echo "Running database migration"');
    expect(apply).toBeGreaterThan(journal);
    expect(migration).toBeGreaterThan(apply);
    expect(deploy).toContain("configure-dashscope-workspace-id.sh");

    const rollback = deploy.slice(
      deploy.indexOf("rollback() {"),
      deploy.indexOf("runtime_mutated=false")
    );
    expect(rollback.indexOf("restore_runtime_env")).toBeGreaterThan(-1);
    expect(rollback.indexOf("restore_runtime_env")).toBeLessThan(
      rollback.indexOf("run_legacy_compose")
    );
  });

  it("injects the workspace only into the preflight environment before persistence", () => {
    const deploy = readFileSync("deploy/deploy.sh", "utf8");
    const qwenSmoke = deploy.indexOf("pnpm smoke:qwen-vl");
    const journal = deploy.indexOf("if ! begin_transaction_journal", qwenSmoke);
    const apply = deploy.indexOf("if ! apply_runtime_env", journal);
    expect(qwenSmoke).toBeGreaterThan(-1);
    expect(journal).toBeGreaterThan(qwenSmoke);
    expect(apply).toBeGreaterThan(journal);

    const preflight = deploy.slice(
      deploy.lastIndexOf('echo "Verifying the configured Qwen-VL contract"'),
      journal
    );
    expect(preflight).toContain(
      'DASHSCOPE_WORKSPACE_ID="$desired_dashscope_workspace_id"'
    );
    expect(preflight).toContain(
      "release_compose run --rm --no-deps -e DASHSCOPE_WORKSPACE_ID"
    );
    expect(preflight).not.toContain(
      '-e DASHSCOPE_WORKSPACE_ID="$desired_dashscope_workspace_id"'
    );
  });
});
