import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  modelingArtifact,
  modelingImportIntent,
  modelingJob,
  modelingJobEvent,
  modelingJobKind,
  modelingJobStatus,
  modelingPlan,
  modelingPlanStatus,
  modelingProject,
  modelingRevision,
  modelingValidationAttempt,
  modelingValidationKind,
  modelingValidationStatus
} from "./modeling";

function checkNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).checks.map((check) => check.name);
}

describe("modeling schema invariants", () => {
  it("keeps project ownership cascading and protects current revisions", () => {
    const config = getTableConfig(modelingProject);
    const ownerForeignKey = config.foreignKeys.find((foreignKey) =>
      foreignKey.getName().includes("owner_id")
    );
    const currentForeignKey = config.foreignKeys.find((foreignKey) =>
      foreignKey.getName().includes("current_revision_id")
    );

    expect(ownerForeignKey?.onDelete).toBe("cascade");
    expect(currentForeignKey?.onDelete).toBe("no action");
    expect(modelingProject.currentRevisionId.notNull).toBe(false);
  });

  it("makes revisions append-only in shape and protects the parent chain", () => {
    const config = getTableConfig(modelingRevision);
    const parentForeignKey = config.foreignKeys.find((foreignKey) =>
      foreignKey.getName().includes("parent_revision_id")
    );

    expect(parentForeignKey?.onDelete).toBe("no action");
    expect("updatedAt" in modelingRevision).toBe(false);
    expect(config.indexes.map((item) => item.config.name)).toEqual(
      expect.arrayContaining([
        "modeling_revision_project_number_unique",
        "modeling_revision_project_idempotency_unique"
      ])
    );
    expect(checkNames(modelingRevision)).toEqual(
      expect.arrayContaining([
        "modeling_revision_hash_valid",
        "modeling_revision_initial_parent_valid"
      ])
    );
  });

  it("represents the full plan and job lifecycles", () => {
    expect(modelingPlanStatus.enumValues).toEqual([
      "needs_input",
      "validated",
      "confirmed",
      "rejected",
      "stale"
    ]);
    expect(modelingPlan.status.hasDefault).toBe(false);
    expect(modelingJobKind.enumValues).toEqual(
      expect.arrayContaining(["ai_plan", "build", "preview", "export"])
    );
    expect(modelingJobStatus.enumValues).toEqual(
      expect.arrayContaining([
        "queued",
        "validating",
        "meshing",
        "exporting",
        "succeeded",
        "failed",
        "cancelled"
      ])
    );
    expect(checkNames(modelingPlan)).toContain(
      "modeling_plan_missing_inputs_shape_valid"
    );
    expect(checkNames(modelingJob)).toEqual(
      expect.arrayContaining([
        "modeling_job_progress_valid",
        "modeling_job_lease_shape_valid",
        "modeling_job_completion_shape_valid",
        "modeling_job_terminal_lease_cleared"
      ])
    );
  });

  it("guards monotonic events and private artifact metadata", () => {
    const eventConfig = getTableConfig(modelingJobEvent);
    const artifactConfig = getTableConfig(modelingArtifact);

    expect(eventConfig.indexes.map((item) => item.config.name)).toContain(
      "modeling_job_event_job_sequence_unique"
    );
    expect(checkNames(modelingJobEvent)).toContain(
      "modeling_job_event_sequence_positive"
    );
    expect(artifactConfig.indexes.map((item) => item.config.name)).toContain(
      "modeling_artifact_object_key_unique"
    );
    expect(artifactConfig.indexes.map((item) => item.config.name)).toContain(
      "modeling_artifact_cleanup_claim_idx"
    );
    expect(checkNames(modelingArtifact)).toEqual(
      expect.arrayContaining([
        "modeling_artifact_checksum_valid",
        "modeling_artifact_key_private_valid",
        "modeling_artifact_retention_shape_valid",
        "modeling_artifact_cleanup_attempts_valid",
        "modeling_artifact_cleanup_lease_shape_valid"
      ])
    );
    expect(modelingArtifact.expiresAt.notNull).toBe(false);
    expect(modelingArtifact.cleanupLeaseToken.notNull).toBe(false);
    expect(modelingArtifact.cleanupAttempts.notNull).toBe(true);
  });

  it("persists synchronous validation reservations and terminal usage", () => {
    const config = getTableConfig(modelingValidationAttempt);
    const ownerForeignKey = config.foreignKeys.find((foreignKey) =>
      foreignKey.getName().includes("owner_id")
    );
    const projectForeignKey = config.foreignKeys.find((foreignKey) =>
      foreignKey.getName().includes("project_id")
    );

    expect(modelingValidationKind.enumValues).toEqual([
      "project_create",
      "operation_batch"
    ]);
    expect(modelingValidationStatus.enumValues).toEqual([
      "reserved",
      "succeeded",
      "failed"
    ]);
    expect(ownerForeignKey?.onDelete).toBe("cascade");
    expect(projectForeignKey?.onDelete).toBe("set null");
    expect(modelingValidationAttempt.projectId.notNull).toBe(false);
    expect(config.indexes.map((item) => item.config.name)).toEqual(
      expect.arrayContaining([
        "modeling_validation_attempt_scope_idempotency_unique",
        "modeling_validation_attempt_owner_created_idx"
      ])
    );
    expect(checkNames(modelingValidationAttempt)).toEqual(
      expect.arrayContaining([
        "modeling_validation_attempt_scope_valid",
        "modeling_validation_attempt_request_hash_valid",
        "modeling_validation_attempt_lease_token_not_blank",
        "modeling_validation_attempt_reserved_compute_positive",
        "modeling_validation_attempt_consumed_compute_valid",
        "modeling_validation_attempt_actual_duration_valid",
        "modeling_validation_attempt_completion_shape_valid"
      ])
    );
    expect(modelingValidationAttempt.reservationExpiresAt.notNull).toBe(false);
    expect(modelingValidationAttempt.leaseToken.notNull).toBe(true);
  });

  it("persists an owner-scoped STEP intent before signing and fences completion", () => {
    const config = getTableConfig(modelingImportIntent);
    const ownerForeignKey = config.foreignKeys.find((foreignKey) =>
      foreignKey.getName().includes("owner_id")
    );
    const projectForeignKey = config.foreignKeys.find((foreignKey) =>
      foreignKey.getName().includes("project_id")
    );
    const jobForeignKey = config.foreignKeys.find((foreignKey) =>
      foreignKey.getName().includes("import_job_id")
    );

    expect(ownerForeignKey?.onDelete).toBe("cascade");
    expect(projectForeignKey?.onDelete).toBe("cascade");
    expect(jobForeignKey?.onDelete).toBe("no action");
    expect(config.indexes.map((item) => item.config.name)).toEqual(
      expect.arrayContaining([
        "modeling_import_intent_owner_project_idempotency_unique",
        "modeling_import_intent_object_key_unique",
        "modeling_import_intent_import_job_unique"
      ])
    );
    expect(checkNames(modelingImportIntent)).toEqual(
      expect.arrayContaining([
        "modeling_import_intent_request_hash_valid",
        "modeling_import_intent_checksum_valid",
        "modeling_import_intent_size_valid",
        "modeling_import_intent_object_key_private_valid",
        "modeling_import_intent_completion_shape_valid"
      ])
    );
    expect(modelingImportIntent.expiresAt.notNull).toBe(true);
    expect(modelingImportIntent.completedAt.notNull).toBe(false);
    expect(modelingImportIntent.importJobId.notNull).toBe(false);
  });
});
