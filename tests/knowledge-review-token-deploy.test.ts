import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const script = "deploy/configure-knowledge-review-token-hash.sh";
const hash = "a".repeat(64);

describe("knowledge review token hash deployment", () => {
  it("atomically adds or replaces only the server-side hash", () => {
    const root = mkdtempSync(join(tmpdir(), "openvac-token-hash-"));
    const deployDir = join(root, "openvac-staging");
    mkdirSync(deployDir, { recursive: true });
    const envFile = join(deployDir, ".env");
    writeFileSync(envFile, "APP_URL=https://staging.example\n", {
      mode: 0o600
    });

    execFileSync("sh", [script, "staging"], {
      cwd: process.cwd(),
      env: { ...process.env, OPENVAC_CONFIG_ROOT: root },
      input: `${hash}\n`,
      stdio: ["pipe", "pipe", "pipe"]
    });
    expect(readFileSync(envFile, "utf8")).toBe(
      `APP_URL=https://staging.example\nKNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256=${hash}\n`
    );

    execFileSync("sh", [script, "staging"], {
      cwd: process.cwd(),
      env: { ...process.env, OPENVAC_CONFIG_ROOT: root },
      input: `${"b".repeat(64)}\n`,
      stdio: ["pipe", "pipe", "pipe"]
    });
    expect(
      readFileSync(envFile, "utf8").match(
        /^KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256=/gmu
      )
    ).toHaveLength(1);
    expect(readFileSync(envFile, "utf8")).not.toContain(hash);
  });

  it("fails closed for invalid hashes, unsafe files, or duplicate entries", () => {
    const root = mkdtempSync(join(tmpdir(), "openvac-token-hash-"));
    const deployDir = join(root, "openvac");
    mkdirSync(deployDir, { recursive: true });
    const envFile = join(deployDir, ".env");
    writeFileSync(
      envFile,
      `KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256=${hash}\nKNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256=${hash}\n`,
      { mode: 0o600 }
    );

    const duplicate = spawnSync("sh", [script, "production"], {
      cwd: process.cwd(),
      env: { ...process.env, OPENVAC_CONFIG_ROOT: root },
      input: `${hash}\n`,
      encoding: "utf8"
    });
    expect(duplicate.status).not.toBe(0);
    expect(`${duplicate.stdout}${duplicate.stderr}`).not.toContain(hash);

    chmodSync(envFile, 0o644);
    const unsafeMode = spawnSync("sh", [script, "production"], {
      cwd: process.cwd(),
      env: { ...process.env, OPENVAC_CONFIG_ROOT: root },
      input: `${hash}\n`,
      encoding: "utf8"
    });
    expect(unsafeMode.status).not.toBe(0);

    const invalid = spawnSync("sh", [script, "production"], {
      cwd: process.cwd(),
      env: { ...process.env, OPENVAC_CONFIG_ROOT: root },
      input: "not-a-hash\n",
      encoding: "utf8"
    });
    expect(invalid.status).not.toBe(0);
  });

  it("wires the environment-scoped hash through a private random stage", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    expect(workflow).toContain(
      "KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256: ${{ secrets.KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256 }}"
    );
    expect(workflow).toContain("cp -R deploy");
    expect(workflow).toContain("mktemp -d /tmp/openvac-deploy.XXXXXX");
    expect(workflow).toContain("knowledge-review-token-hash");
    expect(workflow).not.toContain(
      'remote_stage="/tmp/openvac-deploy-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"'
    );
  });

  it("updates the hash inside the activation transaction and restores it before rollback", () => {
    const deploy = readFileSync("deploy/deploy.sh", "utf8");
    const journal = deploy.indexOf("if ! begin_transaction_journal");
    const apply = deploy.indexOf("if ! apply_runtime_env", journal);
    const migration = deploy.indexOf('echo "Running database migration"');
    expect(journal).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(journal);
    expect(migration).toBeGreaterThan(apply);

    const rollback = deploy.slice(
      deploy.indexOf("rollback() {"),
      deploy.indexOf("runtime_mutated=false")
    );
    expect(rollback.indexOf("restore_runtime_env")).toBeGreaterThan(-1);
    expect(rollback.indexOf("restore_runtime_env")).toBeLessThan(
      rollback.indexOf("run_legacy_compose")
    );
    expect(deploy).toContain("commit_runtime_env");
    expect(deploy).toContain('[ -n "$env_backup_file" ]');

    const rehearsalFailure = deploy.slice(
      deploy.indexOf("if ! apply_runtime_env; then", migration),
      deploy.indexOf('if ! start_new_release "post-rehearsal reactivation"')
    );
    expect(rehearsalFailure).toContain("restore_runtime_env");
    expect(rehearsalFailure).toContain("clear_transaction_journal");
    expect(deploy).not.toContain(
      "restore_runtime_env || true\n  clear_transaction_journal"
    );
    expect(
      deploy.match(
        /if restore_runtime_env; then\n\s+clear_transaction_journal/gu
      )
    ).toHaveLength(2);

    const committedCleanup = deploy.slice(
      deploy.lastIndexOf("commit_runtime_env"),
      deploy.indexOf('echo "Release healthy')
    );
    expect(committedCleanup).toContain("warning:");
    expect(committedCleanup).not.toContain("exit 1");
  });
});
