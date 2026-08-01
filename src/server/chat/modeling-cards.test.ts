import { describe, expect, it, vi } from "vitest";

import type {
  ModelingArtifactRow,
  ProjectDetail
} from "@/server/modeling/repository";
import {
  extractModelingReferences,
  resolveAuthorizedModelingCards
} from "./modeling-cards";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";
const FOREIGN_ID = "33333333-3333-4333-8333-333333333333";

describe("chat modeling cards", () => {
  it("extracts only exact same-origin modeling paths and de-duplicates them", () => {
    expect(
      extractModelingReferences([
        `项目：[打开](/modeling?project=${PROJECT_ID})`,
        `制品 /api/modeling/artifacts/${ARTIFACT_ID}/download`,
        `重复 /modeling?project=${PROJECT_ID}`,
        `https://evil.example/modeling?project=${FOREIGN_ID}`,
        `/modeling?project=${FOREIGN_ID}&next=https://evil.example`
      ])
    ).toEqual([
      { kind: "project", id: PROJECT_ID },
      { kind: "artifact", id: ARTIFACT_ID }
    ]);
  });

  it("turns only owner-scoped, unexpired records into cards", async () => {
    const project = projectRow();
    const repository = {
      getProject: vi.fn(async (_ownerId: string, projectId: string) =>
        projectId === PROJECT_ID ? project : null
      ),
      getArtifact: vi.fn(async (_ownerId: string, artifactId: string) =>
        artifactId === ARTIFACT_ID ? artifactRow() : null
      )
    };

    await expect(
      resolveAuthorizedModelingCards({
        ownerId: "user-1",
        texts: [
          `/modeling?project=${PROJECT_ID} /api/modeling/artifacts/${ARTIFACT_ID}/download /modeling?project=${FOREIGN_ID}`
        ],
        repository,
        enabled: true,
        now: new Date("2026-08-01T00:00:00.000Z")
      })
    ).resolves.toEqual([
      {
        kind: "project",
        projectId: PROJECT_ID,
        title: "原创旋片泵",
        description: "内部参数化样例"
      },
      {
        kind: "artifact",
        artifactId: ARTIFACT_ID,
        projectId: PROJECT_ID,
        title: "pump.step",
        projectTitle: "原创旋片泵",
        format: "STEP",
        sizeBytes: 4096,
        expiresAt: "2026-08-02T00:00:00.000Z"
      }
    ]);
    expect(repository.getProject).toHaveBeenCalledWith("user-1", FOREIGN_ID);
  });

  it("does not query modeling storage while the feature is disabled", async () => {
    const repository = {
      getProject: vi.fn(),
      getArtifact: vi.fn()
    };

    await expect(
      resolveAuthorizedModelingCards({
        ownerId: "user-1",
        texts: [`/modeling?project=${PROJECT_ID}`],
        repository,
        enabled: false
      })
    ).resolves.toEqual([]);
    expect(repository.getProject).not.toHaveBeenCalled();
    expect(repository.getArtifact).not.toHaveBeenCalled();
  });

  it("drops expired artifacts without exposing their storage key", async () => {
    const repository = {
      getProject: vi.fn(async () => projectRow()),
      getArtifact: vi.fn(async () =>
        artifactRow({ expiresAt: new Date("2026-07-31T00:00:00.000Z") })
      )
    };

    await expect(
      resolveAuthorizedModelingCards({
        ownerId: "user-1",
        texts: [`/api/modeling/artifacts/${ARTIFACT_ID}/download`],
        repository,
        enabled: true,
        now: new Date("2026-08-01T00:00:00.000Z")
      })
    ).resolves.toEqual([]);
  });
});

function projectRow(): ProjectDetail {
  const now = new Date("2026-08-01T00:00:00.000Z");
  return {
    id: PROJECT_ID,
    ownerId: "user-1",
    createIdempotencyKey: "create-project-1",
    name: "原创旋片泵",
    description: "内部参数化样例",
    currentRevisionId: null,
    currentRevision: null,
    createdAt: now,
    updatedAt: now
  };
}

function artifactRow(
  overrides: Partial<ModelingArtifactRow> = {}
): ModelingArtifactRow {
  return {
    id: ARTIFACT_ID,
    projectId: PROJECT_ID,
    jobId: null,
    revisionId: null,
    kind: "model",
    filename: "pump.step",
    mimeType: "model/step",
    objectKey: "private/modeling/user-1/pump.step",
    checksumSha256: "a".repeat(64),
    sizeBytes: 4096,
    expiresAt: new Date("2026-08-02T00:00:00.000Z"),
    cleanupLeaseOwner: null,
    cleanupLeaseToken: null,
    cleanupLeaseExpiresAt: null,
    cleanupAttempts: 0,
    cleanupNextAttemptAt: null,
    cleanupLastError: null,
    metadata: {},
    createdByUserId: "user-1",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides
  };
}
