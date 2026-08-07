import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("legacy modeling permanent purge operations", () => {
  const workflow = source(".github/workflows/modeling-permanent-purge.yml");
  const inventory = source("deploy/modeling-purge-inventory.sh");
  const purge = source("deploy/modeling-purge-execute.sh");
  const restore = source("deploy/verify-clean-restore.sh");

  it("exposes only an approved production inventory or purge operation", () => {
    expect(workflow).toContain("operation:");
    expect(workflow).toContain("- inventory");
    expect(workflow).toContain("- purge");
    expect(workflow).toContain("environment:\n      name: production");
    expect(workflow).toContain("expected_inventory_sha256:");
    expect(workflow).toContain("pre_migration_inventory_sha256:");
    expect(workflow).toContain("pre_migration_database_tables:");
    expect(workflow).toContain("pre_migration_database_enums:");
    expect(workflow).toContain("pre_migration_database_cards:");
    expect(workflow).toContain("r1_commit_sha:");
    expect(workflow).toContain("r2_commit_sha:");
    expect(workflow).toContain("deployment_image_digest:");
    expect(workflow).not.toContain("workflow_run:");
  });

  it("uses one exact bucket and prefix without deleting the bucket", () => {
    for (const script of [inventory, purge]) {
      expect(script).toContain("openvac-modeling-hz-20260802");
      expect(script).toContain('modeling_prefix="modeling/"');
    }
    expect(purge).toContain(
      'ossutil rm "oss://$oss_bucket/$modeling_prefix" -r -f'
    );
    expect(purge).not.toMatch(
      /ossutil\s+(?:rm|remove)\s+"?oss:\/\/\$oss_bucket"?\s/u
    );
    expect(purge).not.toContain("delete-bucket");
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
    expect(purge).toContain('preserved_archive="$clean_production_archive"');
    expect(purge).toContain(
      'preserved_checksum="$clean_production_archive.sha256"'
    );
    expect(purge).toContain('"target_categories"');
    expect(purge).toContain('"before_counts"');
    expect(purge).toContain('"after_counts"');
    expect(purge).toContain('"r1_sha"');
    expect(purge).toContain('"r2_sha"');
    expect(purge).toContain('"deployment_image_digest"');
    expect(purge).toContain('"pre_migration_inventory_sha256"');
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
});
