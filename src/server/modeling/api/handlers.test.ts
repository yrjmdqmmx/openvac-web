import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  hashCanonicalSpec,
  hashModelingPlanDraft,
  MODELING_PROTOCOL_VERSION,
  type ModelDocument,
  type ModelingPlanDraft,
  type ModelOperationBatch
} from "@/lib/modeling/protocol";
import type { CadBuildResponse } from "@/server/modeling/cad-client";
import {
  ModelingLimitError,
  StalePlanError,
  type ModelingJobRow,
  type ModelingPlanRow,
  type ProjectDetail,
  type ModelingRepository,
  type ModelingRevisionRow
} from "@/server/modeling/repository";
import { ProviderResponseError } from "@/server/providers/errors";
import type { ObjectStorage } from "@/server/providers/types";

const authMocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: authMocks.getSession } }
}));

import {
  handleCancelModelingJob,
  handleCreateModelingJob,
  handleModelingJobEvents
} from "./jobs";
import { handleConfirmAiPlan } from "./plans";
import {
  handleCreateModelingProject,
  handleCommitModelingOperations,
  handleDeleteModelingProject,
  handleGetModelingProject,
  handleListModelingProjects
} from "./projects";

const USER_ID = "user-1";
const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "10000000-0000-4000-8000-000000000002";
const BASE_REVISION_ID = "10000000-0000-4000-8000-000000000003";
const NEXT_REVISION_ID = "10000000-0000-4000-8000-000000000004";
const OPERATION_ID = "10000000-0000-4000-8000-000000000005";
const PARAMETER_ID = "10000000-0000-4000-8000-000000000006";
const PLAN_ID = "10000000-0000-4000-8000-000000000007";
const JOB_ID = "10000000-0000-4000-8000-000000000008";
const VALIDATION_ATTEMPT_ID = "10000000-0000-4000-8000-000000000009";
const VALIDATION_LEASE_TOKEN = "10000000-0000-4000-8000-000000000010";

function repository(
  overrides: Partial<ModelingRepository>
): ModelingRepository {
  return {
    beginValidationAttempt: vi.fn().mockResolvedValue({
      state: "reserved",
      attemptId: VALIDATION_ATTEMPT_ID,
      leaseToken: VALIDATION_LEASE_TOKEN,
      reservedComputeMs: 30_000
    }),
    completeValidationAttempt: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as ModelingRepository;
}

function request(
  path: string,
  options: { method?: string; body?: unknown; headers?: HeadersInit } = {}
): Request {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(`https://openvac.test${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
}

function baseDocument(): ModelDocument {
  return {
    version: MODELING_PROTOCOL_VERSION,
    id: DOCUMENT_ID,
    revision: 0,
    revisionId: BASE_REVISION_ID,
    name: "测试真空泵",
    unitSystem: "mm-deg",
    parameters: [],
    sketches: [],
    features: [],
    components: [],
    assemblyConstraints: []
  };
}

function operationBatch(): ModelOperationBatch {
  return {
    version: MODELING_PROTOCOL_VERSION,
    id: NEXT_REVISION_ID,
    documentId: DOCUMENT_ID,
    baseRevisionId: BASE_REVISION_ID,
    idempotencyKey: "manual-batch-0001",
    operations: [
      {
        operationId: OPERATION_ID,
        kind: "add",
        collection: "parameters",
        item: {
          id: PARAMETER_ID,
          semanticRef: "parameters.inlet_diameter",
          name: "inlet_diameter",
          label: "入口直径",
          parameterType: "length",
          unit: "mm",
          value: 40,
          minimum: 1,
          maximum: 500,
          source: "user",
          editable: true
        }
      }
    ]
  };
}

function revisionRow(
  overrides: Partial<ModelingRevisionRow> = {}
): ModelingRevisionRow {
  return {
    id: BASE_REVISION_ID,
    projectId: PROJECT_ID,
    parentRevisionId: null,
    revisionNumber: 1,
    source: "initial",
    idempotencyKey: "project:create-0001",
    document: baseDocument(),
    operations: [],
    contentHash: hashCanonicalSpec(baseDocument()),
    createdByUserId: USER_ID,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides
  };
}

function projectDetail(document = baseDocument()): ProjectDetail {
  const currentRevision = revisionRow({ document });
  return {
    id: PROJECT_ID,
    ownerId: USER_ID,
    createIdempotencyKey: "project-create-0001",
    name: document.name,
    description: null,
    currentRevisionId: currentRevision.id,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    currentRevision
  };
}

function sketchOnlyDocument(): ModelDocument {
  return {
    ...baseDocument(),
    name: "纯草图项目",
    sketches: [
      {
        id: "20000000-0000-4000-8000-000000000001",
        semanticRef: "sketch.initial-profile",
        name: "初始草图",
        plane: "xy",
        entities: [
          {
            id: "20000000-0000-4000-8000-000000000002",
            semanticRef: "sketch.initial-profile.origin",
            entityKind: "point",
            construction: false,
            x: 0,
            y: 0
          }
        ],
        constraints: [],
        solveStatus: "under_constrained",
        suppressed: false
      }
    ]
  };
}

function importedBaseDocument(checksumSha256: string): ModelDocument {
  return {
    ...baseDocument(),
    name: "Imported housing",
    features: [
      {
        id: "30000000-0000-4000-8000-000000000001",
        semanticRef: "feature.imported-base",
        name: "Imported STEP base",
        featureKind: "imported_step",
        artifactId: "30000000-0000-4000-8000-000000000002",
        artifactSha256: checksumSha256,
        sourceName: "housing.step",
        bodySemanticRefs: [
          `import.body.${checksumSha256.slice(0, 12)}.0123456789ab.1`
        ],
        suppressed: false
      }
    ],
    metadata: {
      description: "Opaque STEP base",
      tags: ["source.imported-step"]
    }
  };
}

function validationResult(
  document: ModelDocument,
  valid = true
): CadBuildResponse {
  return {
    version: MODELING_PROTOCOL_VERSION,
    job_id: document.revisionId,
    model_hash: hashCanonicalSpec(document),
    kernel_version: "2.8.0",
    solver_version: "slvs-3.2",
    valid,
    diagnostics: valid
      ? []
      : [
          {
            code: "SKETCH_CONFLICT",
            severity: "error",
            message: "草图约束冲突"
          }
        ],
    metrics: null,
    artifacts: [],
    duration_ms: 12
  };
}

function validatedDraft(): ModelingPlanDraft {
  const incomplete: ModelingPlanDraft = {
    version: MODELING_PROTOCOL_VERSION,
    id: PLAN_ID,
    documentId: DOCUMENT_ID,
    baseRevisionId: BASE_REVISION_ID,
    title: "增加入口尺寸参数",
    summary: "为模型增加可编辑的入口直径。",
    status: "validated",
    assumptions: ["单位使用毫米"],
    warnings: [],
    missingInputs: [],
    expectedChecks: ["参数范围校验"],
    planHash: "0".repeat(64),
    operationBatch: {
      ...operationBatch(),
      idempotencyKey: "ai-plan-batch-0001"
    }
  };
  return { ...incomplete, planHash: hashModelingPlanDraft(incomplete) };
}

function planRow(draft = validatedDraft()): ModelingPlanRow {
  return {
    id: PLAN_ID,
    projectId: PROJECT_ID,
    baseRevisionId: BASE_REVISION_ID,
    baseRevisionHash: hashCanonicalSpec(baseDocument()),
    planHash: draft.planHash,
    prompt: "增加入口直径",
    draft,
    operations: draft.operationBatch?.operations ?? [],
    missingInputs: [],
    status: "validated",
    idempotencyKey: "plan-generation-0001",
    confirmedRevisionId: null,
    createdByUserId: USER_ID,
    decidedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z")
  };
}

function jobRow(status: ModelingJobRow["status"]): ModelingJobRow {
  const terminal = ["succeeded", "failed", "cancelled"].includes(status);
  return {
    id: JOB_ID,
    projectId: PROJECT_ID,
    planId: null,
    revisionId: BASE_REVISION_ID,
    kind: "ai_plan",
    status,
    progress: status === "succeeded" ? 100 : 10,
    idempotencyKey: "planning-job-0001",
    input: { prompt: "test" },
    output: {},
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    cancelRequestedAt: null,
    errorCode: null,
    errorMessage: null,
    createdByUserId: USER_ID,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    startedAt: null,
    completedAt: terminal ? new Date("2026-08-01T00:01:00.000Z") : null,
    updatedAt: new Date("2026-08-01T00:01:00.000Z")
  };
}

describe("modeling API handlers", () => {
  beforeEach(() => {
    authMocks.getSession.mockReset();
    authMocks.getSession.mockResolvedValue({
      user: {
        id: USER_ID,
        name: "测试用户",
        email: "user@example.com",
        banned: false
      }
    });
  });

  it("returns 401 before querying modeling data", async () => {
    authMocks.getSession.mockResolvedValue(null);
    const listProjects = vi.fn();
    const response = await handleListModelingProjects(
      request("/api/modeling/projects"),
      repository({ listProjects })
    );

    expect(response.status).toBe(401);
    expect(listProjects).not.toHaveBeenCalled();
  });

  it.each([
    ["空白", baseDocument()],
    ["纯草图", sketchOnlyDocument()]
  ])(
    "validates a %s initial document before creating the project",
    async (_, document) => {
      const beginValidationAttempt = vi.fn().mockResolvedValue({
        state: "reserved",
        attemptId: VALIDATION_ATTEMPT_ID,
        leaseToken: VALIDATION_LEASE_TOKEN,
        reservedComputeMs: 30_000
      });
      const completeValidationAttempt = vi.fn().mockResolvedValue(undefined);
      const createProject = vi.fn().mockResolvedValue({
        value: projectDetail(document),
        replayed: false
      });
      const validate = vi.fn().mockResolvedValue(validationResult(document));
      const response = await handleCreateModelingProject(
        request("/api/modeling/projects", {
          method: "POST",
          body: {
            name: document.name,
            document,
            idempotencyKey: "project-create-0001"
          }
        }),
        repository({
          beginValidationAttempt,
          completeValidationAttempt,
          createProject
        }),
        { validate }
      );

      expect(response.status).toBe(201);
      expect(response.headers.get("x-openvac-kernel-version")).toBe("2.8.0");
      expect(validate).toHaveBeenCalledWith({
        jobId: document.revisionId,
        document,
        validatePump: false,
        signal: expect.any(AbortSignal)
      });
      expect(createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: USER_ID,
          document,
          idempotencyKey: "project-create-0001"
        })
      );
      expect(beginValidationAttempt).toHaveBeenCalledWith({
        ownerId: USER_ID,
        kind: "project_create",
        idempotencyKey: "project-create-0001",
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u)
      });
      expect(completeValidationAttempt).toHaveBeenCalledWith({
        ownerId: USER_ID,
        attemptId: VALIDATION_ATTEMPT_ID,
        leaseToken: VALIDATION_LEASE_TOKEN,
        actualDurationMs: 12,
        outcome: {
          status: "succeeded",
          kernelVersion: "2.8.0"
        }
      });
      expect(beginValidationAttempt.mock.invocationCallOrder[0]!).toBeLessThan(
        validate.mock.invocationCallOrder[0]!
      );
      expect(validate.mock.invocationCallOrder[0]!).toBeLessThan(
        completeValidationAttempt.mock.invocationCallOrder[0]!
      );
      expect(
        completeValidationAttempt.mock.invocationCallOrder[0]!
      ).toBeLessThan(createProject.mock.invocationCallOrder[0]!);
    }
  );

  it("replays a successful project validation without calling CAD twice", async () => {
    const document = baseDocument();
    const validate = vi.fn();
    const completeValidationAttempt = vi.fn();
    const createProject = vi.fn().mockResolvedValue({
      value: projectDetail(document),
      replayed: false
    });
    const response = await handleCreateModelingProject(
      request("/api/modeling/projects", {
        method: "POST",
        body: {
          name: document.name,
          document,
          idempotencyKey: "project-create-0001"
        }
      }),
      repository({
        beginValidationAttempt: vi.fn().mockResolvedValue({
          state: "succeeded",
          attemptId: VALIDATION_ATTEMPT_ID,
          kernelVersion: "2.8.0"
        }),
        completeValidationAttempt,
        createProject
      }),
      { validate }
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("x-openvac-kernel-version")).toBe("2.8.0");
    expect(validate).not.toHaveBeenCalled();
    expect(completeValidationAttempt).not.toHaveBeenCalled();
    expect(createProject).toHaveBeenCalledOnce();
  });

  it("replays a failed project validation without calling CAD twice", async () => {
    const document = sketchOnlyDocument();
    const validate = vi.fn();
    const createProject = vi.fn();
    const response = await handleCreateModelingProject(
      request("/api/modeling/projects", {
        method: "POST",
        body: {
          name: document.name,
          document,
          idempotencyKey: "project-create-0001"
        }
      }),
      repository({
        beginValidationAttempt: vi.fn().mockResolvedValue({
          state: "failed",
          attemptId: VALIDATION_ATTEMPT_ID,
          failure: {
            status: 422,
            code: "CAD_VALIDATION_FAILED",
            message: "确定性 CAD 内核拒绝了初始模型，项目未创建。",
            details: { diagnostics: [{ code: "SKETCH_CONFLICT" }] }
          }
        }),
        createProject
      }),
      { validate }
    );
    const body = (await response.json()) as {
      error: { code: string; details?: unknown };
    };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("CAD_VALIDATION_FAILED");
    expect(body.error.details).toEqual({
      diagnostics: [{ code: "SKETCH_CONFLICT" }]
    });
    expect(validate).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("returns the persisted rate-limit decision before calling CAD", async () => {
    const document = baseDocument();
    const validate = vi.fn();
    const createProject = vi.fn();
    const response = await handleCreateModelingProject(
      request("/api/modeling/projects", {
        method: "POST",
        body: {
          name: document.name,
          document,
          idempotencyKey: "project-create-0001"
        }
      }),
      repository({
        beginValidationAttempt: vi
          .fn()
          .mockRejectedValue(
            new ModelingLimitError(
              "MODELING_OPERATION_RATE_LIMIT",
              "手工建模操作过于频繁，请稍后继续。",
              { limitPerMinute: 30 }
            )
          ),
        createProject
      }),
      { validate }
    );
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(429);
    expect(body.error.code).toBe("MODELING_OPERATION_RATE_LIMIT");
    expect(validate).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("completes a rejected initial validation as failed before returning", async () => {
    const document = sketchOnlyDocument();
    const completeValidationAttempt = vi.fn().mockResolvedValue(undefined);
    const createProject = vi.fn();
    const response = await handleCreateModelingProject(
      request("/api/modeling/projects", {
        method: "POST",
        body: {
          name: document.name,
          document,
          idempotencyKey: "project-create-0001"
        }
      }),
      repository({ completeValidationAttempt, createProject }),
      { validate: vi.fn().mockResolvedValue(validationResult(document, false)) }
    );

    expect(response.status).toBe(422);
    expect(completeValidationAttempt).toHaveBeenCalledWith({
      ownerId: USER_ID,
      attemptId: VALIDATION_ATTEMPT_ID,
      leaseToken: VALIDATION_LEASE_TOKEN,
      actualDurationMs: 12,
      outcome: {
        status: "failed",
        kernelVersion: "2.8.0",
        errorStatus: 422,
        errorCode: "CAD_VALIDATION_FAILED",
        errorMessage: "确定性 CAD 内核拒绝了初始模型，项目未创建。",
        errorDetails: {
          diagnostics: validationResult(document, false).diagnostics
        }
      }
    });
    expect(createProject).not.toHaveBeenCalled();
  });

  it("does not create a project when deterministic initial validation fails", async () => {
    const document = sketchOnlyDocument();
    const createProject = vi.fn();
    const response = await handleCreateModelingProject(
      request("/api/modeling/projects", {
        method: "POST",
        body: {
          name: document.name,
          document,
          idempotencyKey: "project-create-0001"
        }
      }),
      repository({ createProject }),
      { validate: vi.fn().mockResolvedValue(validationResult(document, false)) }
    );
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("CAD_VALIDATION_FAILED");
    expect(createProject).not.toHaveBeenCalled();
  });

  it("uses an ownership-safe 404 for another user's project", async () => {
    const getProject = vi.fn().mockResolvedValue(null);
    const response = await handleGetModelingProject(
      request(`/api/modeling/projects/${PROJECT_ID}`),
      PROJECT_ID,
      repository({ getProject })
    );
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(getProject).toHaveBeenCalledWith(USER_ID, PROJECT_ID);
  });

  it("does not enumerate or delete OSS keys for an unowned project", async () => {
    const deleteProject = vi.fn();
    const deletePrivate = vi.fn();
    const response = await handleDeleteModelingProject(
      request(`/api/modeling/projects/${PROJECT_ID}`, { method: "DELETE" }),
      PROJECT_ID,
      repository({
        listProjectArtifactKeys: vi.fn().mockResolvedValue(null),
        deleteProject
      }),
      { deletePrivate } as unknown as ObjectStorage
    );

    expect(response.status).toBe(204);
    expect(deletePrivate).not.toHaveBeenCalled();
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("deletes all private objects before the owner-scoped project row", async () => {
    const sourceKey = `modeling/${USER_ID}/${PROJECT_ID}/imports/source.step`;
    const previewKey = `modeling/${PROJECT_ID}/${BASE_REVISION_ID}/${JOB_ID}/preview.glb`;
    const calls: string[] = [];
    const deletePrivate = vi.fn(async (key: string) => {
      calls.push(`oss:${key}`);
    });
    const deleteProject = vi.fn(async () => {
      calls.push("db:project");
      return "deleted" as const;
    });

    const response = await handleDeleteModelingProject(
      request(`/api/modeling/projects/${PROJECT_ID}`, { method: "DELETE" }),
      PROJECT_ID,
      repository({
        listProjectArtifactKeys: vi
          .fn()
          .mockResolvedValue([sourceKey, previewKey]),
        deleteProject
      }),
      { deletePrivate } as unknown as ObjectStorage
    );

    expect(response.status).toBe(204);
    expect(calls).toEqual([
      `oss:${sourceKey}`,
      `oss:${previewKey}`,
      "db:project"
    ]);
    expect(deleteProject).toHaveBeenCalledWith(USER_ID, PROJECT_ID, [
      sourceKey,
      previewKey
    ]);
  });

  it("keeps the database project after a partial OSS failure and retries safely", async () => {
    const sourceKey = `modeling/${USER_ID}/${PROJECT_ID}/imports/source.step`;
    const previewKey = `modeling/${PROJECT_ID}/${BASE_REVISION_ID}/${JOB_ID}/preview.glb`;
    let failedOnce = false;
    const deletePrivate = vi.fn(async (key: string) => {
      if (key === previewKey && !failedOnce) {
        failedOnce = true;
        throw new ProviderResponseError("alibaba-oss", "unavailable", {
          status: 503,
          retryable: true
        });
      }
    });
    const deleteProject = vi.fn().mockResolvedValue("deleted");
    const projectRepository = repository({
      listProjectArtifactKeys: vi
        .fn()
        .mockResolvedValue([sourceKey, previewKey]),
      deleteProject
    });
    const storage = { deletePrivate } as unknown as ObjectStorage;

    const failed = await handleDeleteModelingProject(
      request(`/api/modeling/projects/${PROJECT_ID}`, { method: "DELETE" }),
      PROJECT_ID,
      projectRepository,
      storage
    );
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toMatchObject({
      error: { code: "OBJECT_STORAGE_UNAVAILABLE" }
    });
    expect(deleteProject).not.toHaveBeenCalled();

    const retried = await handleDeleteModelingProject(
      request(`/api/modeling/projects/${PROJECT_ID}`, { method: "DELETE" }),
      PROJECT_ID,
      projectRepository,
      storage
    );
    expect(retried.status).toBe(204);
    expect(deletePrivate).toHaveBeenCalledTimes(4);
    expect(deleteProject).toHaveBeenCalledOnce();
  });

  it("re-lists and deletes an artifact committed during project deletion", async () => {
    const firstKey = `modeling/${PROJECT_ID}/revision/job/first.glb`;
    const lateKey = `modeling/${PROJECT_ID}/revision/job/late.step`;
    const listProjectArtifactKeys = vi
      .fn()
      .mockResolvedValueOnce([firstKey])
      .mockResolvedValueOnce([firstKey, lateKey]);
    const deleteProject = vi
      .fn()
      .mockResolvedValueOnce("artifacts_changed")
      .mockResolvedValueOnce("deleted");
    const deletePrivate = vi.fn(async (key: string) => {
      void key;
    });

    const response = await handleDeleteModelingProject(
      request(`/api/modeling/projects/${PROJECT_ID}`, { method: "DELETE" }),
      PROJECT_ID,
      repository({ listProjectArtifactKeys, deleteProject }),
      { deletePrivate } as unknown as ObjectStorage
    );

    expect(response.status).toBe(204);
    expect(deletePrivate.mock.calls.map(([key]) => key)).toEqual([
      firstKey,
      firstKey,
      lateKey
    ]);
    expect(deleteProject).toHaveBeenNthCalledWith(1, USER_ID, PROJECT_ID, [
      firstKey
    ]);
    expect(deleteProject).toHaveBeenNthCalledWith(2, USER_ID, PROJECT_ID, [
      firstKey,
      lateKey
    ]);
  });

  it("returns a committed operation batch as an idempotent replay", async () => {
    const batch = operationBatch();
    const next = revisionRow({
      id: NEXT_REVISION_ID,
      parentRevisionId: BASE_REVISION_ID,
      revisionNumber: 2,
      source: "manual",
      idempotencyKey: batch.idempotencyKey
    });
    const commitOperationBatch = vi.fn().mockResolvedValue({
      value: next,
      replayed: true
    });
    const validate = vi.fn();
    const completeValidationAttempt = vi.fn();
    const response = await handleCommitModelingOperations(
      request(`/api/modeling/projects/${PROJECT_ID}/operation-batches`, {
        method: "POST",
        body: batch
      }),
      PROJECT_ID,
      repository({
        getRevision: vi.fn().mockResolvedValue(revisionRow()),
        beginValidationAttempt: vi.fn().mockResolvedValue({
          state: "succeeded",
          attemptId: VALIDATION_ATTEMPT_ID,
          kernelVersion: "2.8.0"
        }),
        completeValidationAttempt,
        commitOperationBatch
      }),
      { validate }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("idempotency-replayed")).toBe("true");
    expect(validate).not.toHaveBeenCalled();
    expect(completeValidationAttempt).not.toHaveBeenCalled();
    expect(commitOperationBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: USER_ID,
        projectId: PROJECT_ID,
        baseRevisionId: BASE_REVISION_ID,
        idempotencyKey: batch.idempotencyKey
      })
    );
  });

  it("keeps the previous revision when the deterministic kernel rejects a manual batch", async () => {
    const batch = operationBatch();
    const commitOperationBatch = vi.fn();
    const completeValidationAttempt = vi.fn().mockResolvedValue(undefined);
    const response = await handleCommitModelingOperations(
      request(`/api/modeling/projects/${PROJECT_ID}/operation-batches`, {
        method: "POST",
        body: batch
      }),
      PROJECT_ID,
      repository({
        getRevision: vi.fn().mockResolvedValue(revisionRow()),
        completeValidationAttempt,
        commitOperationBatch
      }),
      {
        validate: vi.fn().mockResolvedValue({
          version: "openvac.modeling.v1",
          job_id: batch.id,
          model_hash: "d".repeat(64),
          kernel_version: "2.8.0",
          solver_version: "slvs-3.2",
          valid: false,
          diagnostics: [
            {
              code: "BREP_INVALID",
              severity: "error",
              message: "零厚度实体"
            }
          ],
          metrics: null,
          artifacts: [],
          duration_ms: 15
        })
      }
    );

    expect(response.status).toBe(422);
    expect(completeValidationAttempt).toHaveBeenCalledWith({
      ownerId: USER_ID,
      attemptId: VALIDATION_ATTEMPT_ID,
      leaseToken: VALIDATION_LEASE_TOKEN,
      actualDurationMs: 15,
      outcome: {
        status: "failed",
        kernelVersion: "2.8.0",
        errorStatus: 422,
        errorCode: "CAD_VALIDATION_FAILED",
        errorMessage: "确定性 CAD 内核拒绝了本次操作，上一版本保持不变。",
        errorDetails: {
          diagnostics: [
            {
              code: "BREP_INVALID",
              severity: "error",
              message: "零厚度实体"
            }
          ]
        }
      }
    });
    expect(commitOperationBatch).not.toHaveBeenCalled();
  });

  it("rechecks operation ownership in the reservation transaction before CAD", async () => {
    const batch = operationBatch();
    const validate = vi.fn();
    const commitOperationBatch = vi.fn();
    const response = await handleCommitModelingOperations(
      request(`/api/modeling/projects/${PROJECT_ID}/operation-batches`, {
        method: "POST",
        body: batch
      }),
      PROJECT_ID,
      repository({
        getRevision: vi.fn().mockResolvedValue(revisionRow()),
        beginValidationAttempt: vi.fn().mockResolvedValue(null),
        commitOperationBatch
      }),
      { validate }
    );

    expect(response.status).toBe(404);
    expect(validate).not.toHaveBeenCalled();
    expect(commitOperationBatch).not.toHaveBeenCalled();
  });

  it("hydrates an owned private STEP base before validating downstream manual history", async () => {
    const sourceBytes = new TextEncoder().encode(
      "ISO-10303-21;OWNED-SOURCE;ENDSEC;"
    );
    const checksum = createHash("sha256").update(sourceBytes).digest("hex");
    const document = importedBaseDocument(checksum);
    const importedFeature = document.features[0]!;
    if (importedFeature.featureKind !== "imported_step") {
      throw new Error("fixture must begin with imported_step");
    }
    const diameterId = "30000000-0000-4000-8000-000000000003";
    const holeId = "30000000-0000-4000-8000-000000000004";
    const batch: ModelOperationBatch = {
      version: MODELING_PROTOCOL_VERSION,
      id: NEXT_REVISION_ID,
      documentId: DOCUMENT_ID,
      baseRevisionId: BASE_REVISION_ID,
      idempotencyKey: "imported-hole-batch-0001",
      operations: [
        {
          operationId: "30000000-0000-4000-8000-000000000005",
          kind: "add",
          collection: "parameters",
          item: {
            id: diameterId,
            semanticRef: "parameter.hole-diameter",
            name: "hole_diameter",
            label: "Hole diameter",
            parameterType: "length",
            unit: "mm",
            value: 4,
            minimum: 0.1,
            source: "user",
            editable: true
          }
        },
        {
          operationId: "30000000-0000-4000-8000-000000000006",
          kind: "add",
          collection: "features",
          item: {
            id: holeId,
            semanticRef: "feature.imported-hole",
            name: "Imported base hole",
            featureKind: "hole",
            placement: {
              placementKind: "semantic_face",
              sourceFeatureRef: {
                id: importedFeature.id,
                semanticRef: importedFeature.semanticRef
              },
              faceSelector: "top"
            },
            diameterParameterRef: {
              id: diameterId,
              semanticRef: "parameter.hole-diameter"
            },
            termination: "through_all",
            operation: "cut",
            suppressed: false
          }
        }
      ]
    };
    const validate = vi
      .fn()
      .mockImplementation(async ({ document: next }) => validationResult(next));
    const beginValidationAttempt = vi.fn().mockResolvedValue({
      state: "reserved",
      attemptId: VALIDATION_ATTEMPT_ID,
      leaseToken: VALIDATION_LEASE_TOKEN,
      reservedComputeMs: 30_000
    });
    const completeValidationAttempt = vi.fn().mockResolvedValue(undefined);
    const commitOperationBatch = vi.fn().mockResolvedValue({
      value: revisionRow({
        id: NEXT_REVISION_ID,
        revisionNumber: 2,
        source: "manual"
      }),
      replayed: false
    });
    const getPrivate = vi.fn().mockResolvedValue(sourceBytes);
    const storage = {
      id: "test-storage",
      getPrivate,
      putPrivate: vi.fn(),
      createPrivateDownloadUrl: vi.fn()
    } as unknown as ObjectStorage;
    const objectKey = `modeling/${USER_ID}/${PROJECT_ID}/imports/${"a".repeat(40)}.step`;

    const response = await handleCommitModelingOperations(
      request(`/api/modeling/projects/${PROJECT_ID}/operation-batches`, {
        method: "POST",
        body: batch
      }),
      PROJECT_ID,
      repository({
        getRevision: vi
          .fn()
          .mockResolvedValue(
            revisionRow({ document, contentHash: hashCanonicalSpec(document) })
          ),
        beginValidationAttempt,
        completeValidationAttempt,
        getArtifact: vi.fn().mockResolvedValue({
          id: importedFeature.artifactId,
          projectId: PROJECT_ID,
          jobId: JOB_ID,
          revisionId: BASE_REVISION_ID,
          kind: "source",
          filename: "housing.step",
          mimeType: "model/step",
          objectKey,
          checksumSha256: checksum,
          sizeBytes: sourceBytes.byteLength,
          expiresAt: null,
          metadata: {},
          createdByUserId: USER_ID,
          createdAt: new Date("2026-08-01T00:00:00.000Z")
        }),
        commitOperationBatch
      }),
      { validate },
      storage
    );

    expect(response.status).toBe(201);
    expect(beginValidationAttempt).toHaveBeenCalledWith({
      ownerId: USER_ID,
      projectId: PROJECT_ID,
      kind: "operation_batch",
      idempotencyKey: batch.idempotencyKey,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(getPrivate).toHaveBeenCalledWith(objectKey);
    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({
        importedStep: expect.objectContaining({
          artifactId: importedFeature.artifactId,
          artifactSha256: checksum,
          bytes: sourceBytes
        })
      })
    );
    expect(completeValidationAttempt).toHaveBeenCalledWith({
      ownerId: USER_ID,
      attemptId: VALIDATION_ATTEMPT_ID,
      leaseToken: VALIDATION_LEASE_TOKEN,
      actualDurationMs: 12,
      outcome: { status: "succeeded", kernelVersion: "2.8.0" }
    });
    expect(beginValidationAttempt.mock.invocationCallOrder[0]!).toBeLessThan(
      getPrivate.mock.invocationCallOrder[0]!
    );
    expect(getPrivate.mock.invocationCallOrder[0]!).toBeLessThan(
      validate.mock.invocationCallOrder[0]!
    );
    expect(validate.mock.invocationCallOrder[0]!).toBeLessThan(
      completeValidationAttempt.mock.invocationCallOrder[0]!
    );
    expect(completeValidationAttempt.mock.invocationCallOrder[0]!).toBeLessThan(
      commitOperationBatch.mock.invocationCallOrder[0]!
    );
    expect(commitOperationBatch).toHaveBeenCalledOnce();
  });

  it("returns an explicit stale-plan conflict without overwriting a revision", async () => {
    const draft = validatedDraft();
    const confirmPlan = vi.fn().mockRejectedValue(
      new StalePlanError({
        planId: PLAN_ID,
        baseRevisionId: BASE_REVISION_ID,
        currentRevisionId: NEXT_REVISION_ID
      })
    );
    const response = await handleConfirmAiPlan(
      request(`/api/modeling/ai-plans/${PLAN_ID}/confirm`, {
        method: "POST",
        body: {
          baseRevisionId: BASE_REVISION_ID,
          planHash: draft.planHash,
          idempotencyKey: "confirm-plan-0001"
        }
      }),
      PLAN_ID,
      repository({
        getPlan: vi.fn().mockResolvedValue(planRow(draft)),
        getRevision: vi.fn().mockResolvedValue(revisionRow()),
        confirmPlan
      })
    );
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("STALE_PLAN");
    expect(confirmPlan).toHaveBeenCalledTimes(1);
  });

  it("queues an owner-scoped GLB preview job", async () => {
    const createJob = vi.fn().mockResolvedValue({
      value: { ...jobRow("queued"), kind: "preview" as const },
      replayed: false
    });
    const response = await handleCreateModelingJob(
      request(`/api/modeling/projects/${PROJECT_ID}/jobs`, {
        method: "POST",
        body: {
          revisionId: BASE_REVISION_ID,
          kind: "preview",
          formats: ["glb"],
          idempotencyKey: "preview-job-0001"
        }
      }),
      PROJECT_ID,
      repository({ createJob })
    );

    expect(response.status).toBe(202);
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: USER_ID,
        projectId: PROJECT_ID,
        revisionId: BASE_REVISION_ID,
        kind: "preview",
        input: { formats: ["glb"] }
      })
    );
  });

  it("resumes SSE strictly after Last-Event-ID", async () => {
    const listJobEvents = vi.fn().mockResolvedValue([
      {
        id: "10000000-0000-4000-8000-000000000009",
        jobId: JOB_ID,
        sequence: 5,
        type: "progress",
        data: { progress: 50 },
        createdAt: new Date("2026-08-01T00:00:05.000Z")
      }
    ]);
    const response = await handleModelingJobEvents(
      request(`/api/modeling/jobs/${JOB_ID}/events?waitMs=0`, {
        headers: { "last-event-id": "4" }
      }),
      JOB_ID,
      repository({ listJobEvents })
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(listJobEvents).toHaveBeenCalledWith(USER_ID, JOB_ID, 4, 100);
    expect(text).toContain("id: 5");
    expect(text).not.toContain("id: 4\n");
    expect(text).toContain('"version":"openvac.modeling.v1"');
    expect(text).toContain(`"jobId":"${JOB_ID}"`);
    expect(text).toContain('"sequence":5');
    expect(text).toContain('"data":{"progress":50}');
  });

  it("keeps an SSE request open long enough to deliver a later terminal event", async () => {
    const listJobEvents = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "10000000-0000-4000-8000-000000000010",
          jobId: JOB_ID,
          sequence: 6,
          type: "succeeded",
          data: { progress: 100 },
          createdAt: new Date("2026-08-01T00:00:06.000Z")
        }
      ]);
    const response = await handleModelingJobEvents(
      request(`/api/modeling/jobs/${JOB_ID}/events?waitMs=5`),
      JOB_ID,
      repository({ listJobEvents })
    );
    const text = await response.text();

    expect(listJobEvents).toHaveBeenNthCalledWith(1, USER_ID, JOB_ID, 0, 100);
    expect(listJobEvents).toHaveBeenNthCalledWith(2, USER_ID, JOB_ID, 0, 100);
    expect(text).toContain(": keep-alive");
    expect(text).toContain("event: succeeded");
    expect(text).toContain("id: 6");
  });

  it("does not mutate a terminal job when cancellation is replayed", async () => {
    const terminal = jobRow("succeeded");
    const cancelJob = vi.fn().mockResolvedValue({
      job: terminal,
      replayed: true,
      cancellationRequested: false
    });
    const response = await handleCancelModelingJob(
      request(`/api/modeling/jobs/${JOB_ID}/cancel`, {
        method: "POST",
        headers: { "idempotency-key": "cancel-job-0001" }
      }),
      JOB_ID,
      repository({ cancelJob })
    );
    const body = (await response.json()) as {
      data: { job: { status: string }; cancellationRequested: boolean };
    };

    expect(response.status).toBe(200);
    expect(body.data.job.status).toBe("succeeded");
    expect(body.data.cancellationRequested).toBe(false);
    expect(response.headers.get("idempotency-replayed")).toBe("true");
  });
});
import { createHash } from "node:crypto";
