import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("legacy modeling permanent purge operations", () => {
  const workflow = source(".github/workflows/modeling-permanent-purge.yml");
  const inventory = source("deploy/modeling-purge-inventory.sh");
  const purge = source("deploy/modeling-purge-execute.sh");
  const ossutilInstaller = source("deploy/install-pinned-ossutil.sh");
  const restore = source("deploy/verify-clean-restore.sh");

  it("exposes only an approved environment inventory or purge operation", () => {
    expect(workflow).toContain("target:");
    expect(workflow).toContain("- staging");
    expect(workflow).toContain("- production");
    expect(workflow).toContain("operation:");
    expect(workflow).toContain("- inventory");
    expect(workflow).toContain("- purge");
    expect(workflow).toContain("- prepare-ossutil");
    expect(workflow).toContain(
      "environment:\n      name: ${{ inputs.target }}"
    );
    expect(workflow).toContain("expected_inventory_sha256:");
    expect(workflow).toContain("inventory_phase:");
    expect(workflow).toContain("pre_migration_inventory_run_id:");
    expect(workflow).toContain("pre_migration_inventory_run_attempt:");
    expect(workflow).toContain("r1_commit_sha:");
    expect(workflow).toContain("r2_commit_sha:");
    expect(workflow).toContain("deployment_image_digest:");
    expect(workflow).not.toContain("workflow_run:");
  });

  it("bootstraps ossutil only through a pinned official checksum", () => {
    expect(ossutilInstaller).toContain("2.3.0");
    expect(ossutilInstaller).toContain(
      "3ae4d9fc85a7a6e9f5654d1599766f1a3a42a3692870887b5ae9338d582ef65a"
    );
    expect(ossutilInstaller).toContain(
      "f6c95ba0c2d2ef30290af686ce4d706c701f4734ce8090bee4288a77e3f1d764"
    );
    expect(ossutilInstaller).toContain(
      "https://gosspublic.alicdn.com/ossutil/v2/"
    );
    expect(ossutilInstaller).toContain('sha256sum --check "$checksum_file"');
    expect(ossutilInstaller).toContain(
      'install -m 0755 -- "$binary" /usr/local/bin/ossutil'
    );
    expect(ossutilInstaller).toContain('verified_binary_sha256="$(sha256sum');
    expect(ossutilInstaller).toContain('installed_binary_sha256="$(sha256sum');
    expect(ossutilInstaller).not.toContain('status":"already-present"');
    expect(ossutilInstaller).not.toContain("OSS_ACCESS_KEY");
    expect(workflow).toContain("deploy/install-pinned-ossutil.sh");
    expect(workflow).toContain('test "$R2_COMMIT_SHA" = "$GITHUB_SHA"');
    expect(workflow).toContain(
      'test "$GITHUB_REF" = "refs/heads/$DEFAULT_BRANCH"'
    );
  });

  it("preserves the intentionally empty pre-migration digest across SSH", () => {
    expect(workflow).toContain(
      'digest_argument="${DEPLOYMENT_IMAGE_DIGEST:--}"'
    );
    expect(workflow).toContain(
      '[ "$deployment_image_digest" != "-" ] || deployment_image_digest=""'
    );
  });

  it("uses one exact bucket and prefix without deleting the bucket", () => {
    for (const script of [inventory, purge]) {
      expect(script).toContain("openvac-modeling-hz-20260802");
      expect(script).toContain('modeling_prefix="modeling/"');
    }
    expect(purge).toContain('done <"$state_dir/oss-modeling.txt"');
    expect(purge).toContain('ossutil rm "$modeling_object" -f');
    expect(purge).not.toContain(
      'ossutil rm "oss://$oss_bucket/$modeling_prefix" -r -f'
    );
    expect(purge).not.toMatch(
      /ossutil\s+(?:rm|remove)\s+"?oss:\/\/\$oss_bucket"?\s/u
    );
    expect(purge).not.toContain("delete-bucket");
    expect(inventory).toContain("get-bucket-versioning");
    expect(inventory).toContain(
      "approved OSS bucket is versioned; all-version deletion requires a separate reviewed procedure"
    );
  });

  it("fails closed when the refreshed inventory differs", () => {
    expect(inventory).toContain("inventory_sha256");
    expect(inventory).not.toContain("MODELING_SERVICE_TOKEN=");
    expect(purge).toContain(
      'if [[ "$actual_inventory_sha256" != "$expected_inventory_sha256" ]]'
    );
    expect(purge).toContain("inventory changed after approval");
    expect(purge).toContain('[[ "$database_modeling_tables" == "0" ]]');
    expect(purge).toContain('[[ "$database_modeling_enums" == "0" ]]');
    expect(purge).toContain('[[ "$database_modeling_cards" == "0" ]]');
  });

  it("atomically removes only MODELING keys from the two exact env files", () => {
    expect(purge).toContain("/opt/openvac/.env");
    expect(purge).toContain("/opt/openvac-staging/.env");
    expect(purge).toContain("/^MODELING_[A-Z0-9_]*=/");
    expect(purge).toContain('cmp -s "$current_keys" "$current_keys.approved"');
    expect(purge).toContain('mv -- "$temporary_env" "$env_file"');
    expect(purge).not.toContain("source /opt/openvac/.env");
  });

  it("verifies a clean isolated restore before destroying old backups", () => {
    const restoreIndex = purge.indexOf("verify-clean-restore.sh");
    const oldBackupIndex = purge.indexOf("delete_old_backups");
    expect(restoreIndex).toBeGreaterThan(-1);
    expect(oldBackupIndex).toBeGreaterThan(restoreIndex);
    expect(restore).toContain("openvac_restore_drill");
    expect(restore).toContain("modeling_table_count");
    expect(restore).toContain("modeling_enum_count");
    expect(restore).toContain("modeling_card_count");
    expect(restore).toContain("core_table_count");
    expect(restore).toContain("dropdb");
    expect(restore).not.toMatch(/\bCASCADE\b/iu);
  });

  it("preserves the new clean backup and emits only aggregate deletion evidence", () => {
    expect(purge).toContain('preserved_archive="$clean_archive"');
    expect(purge).toContain('preserved_checksum="$clean_archive.sha256"');
    expect(purge).toContain('"target_categories"');
    expect(purge).toContain('"before_counts"');
    expect(purge).toContain('"after_counts"');
    expect(purge).toContain('"r1_sha"');
    expect(purge).toContain('"r2_sha"');
    expect(purge).toContain('"deployment_image_digest"');
    expect(purge).toContain('"pre_migration_inventory_sha256"');
    expect(purge).toContain('"pre_migration_artifact_sha256"');
    expect(purge).not.toContain('"deleted_objects"');
    expect(purge).not.toContain('"message_content"');
  });

  it("removes only inventoried legacy containers, images, and exact paths", () => {
    expect(inventory).toContain("com.docker.compose.service");
    expect(inventory).toContain("modeling-service");
    expect(inventory).toContain("modeling-worker");
    expect(purge).toContain('docker container rm --force -- "$container_id"');
    expect(purge).toContain('docker image rm --force -- "$image_id"');
    expect(purge).toContain("/opt/openvac-modeling");
    expect(purge).toContain("/opt/openvac-staging-modeling");
    expect(purge).not.toContain("docker system prune");
    expect(purge).not.toContain("docker volume rm");
  });

  it("parses every irreversible shell entrypoint and shares deployment activation locks", () => {
    for (const path of [
      "deploy/modeling-purge-inventory.sh",
      "deploy/modeling-purge-execute.sh",
      "deploy/verify-clean-restore.sh"
    ]) {
      expect(() => execFileSync("bash", ["-n", path])).not.toThrow();
    }
    expect(purge).toContain('activation_lock="$deploy_dir/.activation-lock"');
    expect(purge).toContain('owned_activation_locks+=("$activation_lock")');
  });

  it("binds pre-migration counts and rollback evidence to a successful workflow artifact", () => {
    expect(workflow).toContain(
      "Download the reviewed pre-migration inventory artifact"
    );
    expect(workflow).toContain("Validate pre-migration inventory provenance");
    expect(workflow).toContain(
      '.path == ".github/workflows/modeling-permanent-purge.yml"'
    );
    expect(workflow).toContain(
      '.release_evidence.rollback_rehearsal == "passed"'
    );
    expect(purge).toContain(
      'pre_migration_database_tables="$(pre_json_number modeling_tables)"'
    );
    expect(purge).toContain(
      'pre_migration_database_enums="$(pre_json_number modeling_enums)"'
    );
    expect(purge).toContain(
      'pre_migration_database_cards="$(pre_json_number modeling_cards)"'
    );
    expect(inventory).toContain(
      "production R1 deployment receipt does not prove the rollback rehearsal passed"
    );
  });

  it("keeps staging and production host inventories and receipts independent", () => {
    expect(workflow).toContain(
      "modeling-${{ inputs.target }}-inventory-pre-migration-"
    );
    expect(inventory).toContain("printf 'target=%s\\n' \"$target\"");
    expect(purge).toContain('[[ "$(pre_json_text target)" == "$target" ]]');
    expect(purge).toContain('bash "$script_dir/backup.sh" "$target"');
    expect(purge).toContain(
      'receipt="$deploy_dir/modeling-purge-receipt.json"'
    );
    expect(purge).not.toContain(
      "for release_target in /opt/openvac /opt/openvac-staging"
    );
    expect(inventory).toContain('host_scope="shared"');
    expect(inventory).toContain('host_scope="dedicated"');
    expect(inventory).toContain(
      'if [[ "$target" == production || "$host_scope" == dedicated ]]'
    );
    expect(inventory).toContain("printf 'host_scope=%s\\n'");
    expect(workflow).toContain(
      '(.host_scope == "shared" or .host_scope == "dedicated")'
    );
    expect(purge).toContain(
      'pre_migration_host_scope="$(pre_json_text host_scope)"'
    );
    expect(purge).toContain(
      '[[ "$current_host_scope" == "$pre_migration_host_scope" ]]'
    );
    expect(purge).toContain('"host_scope":"%s","image_scope":"%s"');
    expect(inventory).not.toContain(
      "target-specific purge requires a dedicated environment host"
    );
    expect(purge).not.toContain(
      "target-specific purge requires a dedicated environment host"
    );
  });

  it("does not overstate the shared OSS prefix in staging receipts", () => {
    expect(purge).toContain('oss_modeling_scope="not-applicable"');
    expect(purge).toContain("before_oss_modeling_json=null");
    expect(purge).toContain("after_oss_modeling_json=null");
    expect(purge).toContain(
      'target_categories_json=\'["database","containers","images","environment_keys","filesystem_paths","legacy_backups"]\''
    );
    expect(purge).toContain('"oss_modeling_scope":"%s"');
  });
});
