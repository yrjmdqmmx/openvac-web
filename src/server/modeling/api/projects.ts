import { createHash } from "node:crypto";

import {
  applyOperationBatch,
  hashCanonicalSpec,
  modelDocumentSchema,
  modelOperationBatchSchema,
  type ModelDocument
} from "@/lib/modeling/protocol";
import { authenticate } from "@/server/api/auth";
import {
  ApiError,
  jsonData,
  notFound,
  parseJson,
  parseSearchParams
} from "@/server/api/errors";
import {
  modelingRepository,
  type BeginValidationAttemptInput,
  type ModelingRepository
} from "@/server/modeling/repository";
import {
  getModelingServiceClient,
  ModelingServiceError,
  type CadBuildResponse,
  type CadImportedStepSource,
  type CadValidationRequest
} from "@/server/modeling/cad-client";
import { getObjectStorage } from "@/server/providers/oss";
import { ProviderError } from "@/server/providers/errors";
import type { ObjectStorage } from "@/server/providers/types";

import {
  createProjectSchema,
  modelingPageSchema,
  modelingUuidSchema,
  updateProjectSchema
} from "./schemas";
import {
  projectDto,
  requireIdempotencyKey,
  revisionDto,
  withModelingApiErrors
} from "./shared";

export const handleListModelingProjects = withModelingApiErrors(
  async (
    request: Request,
    repository: ModelingRepository = modelingRepository
  ) => {
    const user = await authenticate(request);
    const query = parseSearchParams(request, modelingPageSchema);
    const result = await repository.listProjects(
      user.id,
      query.page,
      query.pageSize
    );
    return jsonData({
      ...result,
      items: result.items.map(projectDto)
    });
  }
);

export const handleCreateModelingProject = withModelingApiErrors(
  async (
    request: Request,
    repository: ModelingRepository = modelingRepository,
    cadClient: {
      validate(request: CadValidationRequest): Promise<CadBuildResponse>;
    } = getModelingServiceClient()
  ) => {
    const user = await authenticate(request);
    const input = await parseJson(request, createProjectSchema);
    const idempotencyKey = requireIdempotencyKey(request, input.idempotencyKey);
    const validation = await validatePersistedDocument({
      repository,
      begin: {
        ownerId: user.id,
        kind: "project_create",
        idempotencyKey,
        requestHash: hashCanonicalSpec({
          kind: "project_create",
          name: input.name,
          description: input.description ?? null,
          document: input.document
        })
      },
      cadClient,
      jobId: input.document.revisionId,
      document: input.document,
      signal: request.signal
    });
    const result = await repository.createProject({
      ownerId: user.id,
      name: input.name,
      description: input.description,
      document: input.document,
      idempotencyKey
    });
    return jsonData(
      {
        project: projectDto(result.value),
        idempotentReplay: result.replayed
      },
      {
        status: result.replayed ? 200 : 201,
        headers: result.replayed
          ? { "idempotency-replayed": "true" }
          : validation.kernelVersion
            ? { "x-openvac-kernel-version": validation.kernelVersion }
            : {}
      }
    );
  }
);

export const handleGetModelingProject = withModelingApiErrors(
  async (
    request: Request,
    projectId: string,
    repository: ModelingRepository = modelingRepository
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(projectId);
    const project = await repository.getProject(user.id, id);
    if (!project) {
      throw notFound("建模项目");
    }
    return jsonData(projectDto(project));
  }
);

export const handleUpdateModelingProject = withModelingApiErrors(
  async (
    request: Request,
    projectId: string,
    repository: ModelingRepository = modelingRepository
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(projectId);
    const input = await parseJson(request, updateProjectSchema);
    const project = await repository.updateProject(user.id, id, input);
    if (!project) {
      throw notFound("建模项目");
    }
    return jsonData(projectDto(project));
  }
);

export const handleDeleteModelingProject = withModelingApiErrors(
  async (
    request: Request,
    projectId: string,
    repository: ModelingRepository = modelingRepository,
    storage: ObjectStorage = getObjectStorage()
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(projectId);
    const deletedObjectKeys = new Set<string>();
    for (let round = 0; round < 3; round += 1) {
      const objectKeys = await repository.listProjectArtifactKeys(user.id, id);
      if (!objectKeys) {
        // DELETE remains idempotent and does not reveal whether a different
        // owner holds the identifier.
        return new Response(null, { status: 204 });
      }
      for (const objectKey of objectKeys) {
        try {
          await storage.deletePrivate(objectKey);
          deletedObjectKeys.add(objectKey);
        } catch (error) {
          if (error instanceof ProviderError) {
            throw new ApiError(
              503,
              "OBJECT_STORAGE_UNAVAILABLE",
              "项目私有制品尚未全部删除，项目记录已保留，可安全重试。"
            );
          }
          throw error;
        }
      }
      const result = await repository.deleteProject(user.id, id, [
        ...deletedObjectKeys
      ]);
      if (result === "deleted" || result === "not_found") {
        return new Response(null, { status: 204 });
      }
      // A worker committed another artifact between listing and the guarded
      // project-row lock. Re-list and delete it before another guarded attempt.
    }
    throw new ApiError(
      503,
      "PROJECT_DELETE_RETRY_REQUIRED",
      "项目制品仍在变化，数据库记录未删除，请稍后安全重试。"
    );
  }
);

export const handleListModelingRevisions = withModelingApiErrors(
  async (
    request: Request,
    projectId: string,
    repository: ModelingRepository = modelingRepository
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(projectId);
    const query = parseSearchParams(request, modelingPageSchema);
    const result = await repository.listRevisions(
      user.id,
      id,
      query.page,
      query.pageSize
    );
    if (!result) {
      throw notFound("建模项目");
    }
    return jsonData({
      ...result,
      items: result.items.map(revisionDto)
    });
  }
);

export const handleCommitModelingOperations = withModelingApiErrors(
  async (
    request: Request,
    projectId: string,
    repository: ModelingRepository = modelingRepository,
    cadClient: {
      validate(request: CadValidationRequest): Promise<CadBuildResponse>;
    } = getModelingServiceClient(),
    storage: ObjectStorage = getObjectStorage()
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(projectId);
    const raw = await parseJson(request, modelOperationBatchSchema);
    const batch = modelOperationBatchSchema.parse(raw);
    const baseRevision = await repository.getRevision(
      user.id,
      id,
      batch.baseRevisionId
    );
    if (!baseRevision) {
      throw notFound("建模项目或基础版本");
    }
    const baseDocument = modelDocumentSchema.parse(baseRevision.document);
    const document = applyOperationBatch(baseDocument, batch);
    const validation = await validatePersistedDocument({
      repository,
      begin: {
        ownerId: user.id,
        projectId: id,
        kind: "operation_batch",
        idempotencyKey: batch.idempotencyKey,
        requestHash: hashCanonicalSpec({
          kind: "operation_batch",
          projectId: id,
          batch,
          document
        })
      },
      cadClient,
      jobId: batch.id,
      document,
      signal: request.signal,
      invalidMessage: "确定性 CAD 内核拒绝了本次操作，上一版本保持不变。",
      resolveImportedStep: () =>
        resolveImportedStepForValidation(
          repository,
          storage,
          user.id,
          id,
          document
        )
    });
    const result = await repository.commitOperationBatch({
      ownerId: user.id,
      projectId: id,
      baseRevisionId: batch.baseRevisionId,
      idempotencyKey: batch.idempotencyKey,
      operations: batch.operations,
      document,
      contentHash: hashCanonicalSpec(document)
    });
    if (!result) {
      throw notFound("建模项目");
    }
    return jsonData(
      {
        revision: revisionDto(result.value),
        idempotentReplay: result.replayed
      },
      {
        status: result.replayed ? 200 : 201,
        headers: result.replayed
          ? { "idempotency-replayed": "true" }
          : validation.kernelVersion
            ? { "x-openvac-kernel-version": validation.kernelVersion }
            : {}
      }
    );
  }
);

type PersistedValidationOptions = {
  repository: ModelingRepository;
  begin: BeginValidationAttemptInput;
  cadClient: {
    validate(request: CadValidationRequest): Promise<CadBuildResponse>;
  };
  jobId: string;
  document: ModelDocument;
  signal: AbortSignal;
  invalidMessage?: string;
  resolveImportedStep?: () => Promise<CadImportedStepSource | undefined>;
};

async function validatePersistedDocument(
  options: PersistedValidationOptions
): Promise<{ kernelVersion: string | null; replayed: boolean }> {
  const attempt = await options.repository.beginValidationAttempt(
    options.begin
  );
  if (!attempt) {
    throw notFound("建模项目");
  }
  if (attempt.state === "succeeded") {
    return {
      kernelVersion: attempt.kernelVersion,
      replayed: true
    };
  }
  if (attempt.state === "failed") {
    throw new ApiError(
      attempt.failure.status,
      attempt.failure.code,
      attempt.failure.message,
      attempt.failure.details
    );
  }

  let validation: CadBuildResponse | undefined;
  let failure: ApiError | undefined;
  let kernelStartedAt: number | undefined;
  try {
    const importedStep = await options.resolveImportedStep?.();
    kernelStartedAt = performance.now();
    validation = await requestDocumentValidation(
      options.cadClient,
      options.jobId,
      options.document,
      options.signal,
      importedStep
    );
    if (!validation.valid) {
      throw new ApiError(
        422,
        "CAD_VALIDATION_FAILED",
        options.invalidMessage ?? "确定性 CAD 内核拒绝了初始模型，项目未创建。",
        { diagnostics: validation.diagnostics }
      );
    }
  } catch (error) {
    failure = persistedValidationError(error);
  } finally {
    const failureDetails = errorDetails(failure?.details);
    const actualDurationMs = validation
      ? validation.duration_ms
      : kernelStartedAt === undefined
        ? 0
        : performance.now() - kernelStartedAt;
    await options.repository.completeValidationAttempt({
      ownerId: options.begin.ownerId,
      attemptId: attempt.attemptId,
      leaseToken: attempt.leaseToken,
      actualDurationMs,
      outcome: failure
        ? {
            status: "failed",
            kernelVersion: validation?.kernel_version,
            errorStatus: failure.status,
            errorCode: failure.code,
            errorMessage: failure.message,
            ...(failureDetails ? { errorDetails: failureDetails } : {})
          }
        : {
            status: "succeeded",
            kernelVersion: validation?.kernel_version ?? "unknown"
          }
    });
  }
  if (failure) {
    throw failure;
  }
  return {
    kernelVersion: validation?.kernel_version ?? null,
    replayed: false
  };
}

async function requestDocumentValidation(
  cadClient: {
    validate(request: CadValidationRequest): Promise<CadBuildResponse>;
  },
  jobId: string,
  document: ModelDocument,
  signal: AbortSignal,
  importedStep?: CadImportedStepSource
): Promise<CadBuildResponse> {
  try {
    return await cadClient.validate({
      jobId,
      document,
      validatePump: Boolean(document.metadata?.template?.templateId),
      importedStep,
      signal
    });
  } catch (error) {
    if (error instanceof ModelingServiceError) {
      throw new ApiError(
        error.status === 422 ? 422 : error.status === 504 ? 504 : 503,
        error.status === 422
          ? "CAD_VALIDATION_FAILED"
          : "CAD_KERNEL_UNAVAILABLE",
        error.message
      );
    }
    throw error;
  }
}

function persistedValidationError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ApiError(
      409,
      "CAD_VALIDATION_CANCELLED",
      "确定性 CAD 校验已取消，未写入模型版本。"
    );
  }
  return new ApiError(
    503,
    "CAD_KERNEL_UNAVAILABLE",
    "确定性 CAD 内核校验未完成，请稍后重试。"
  );
}

function errorDetails(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function resolveImportedStepForValidation(
  repository: ModelingRepository,
  storage: ObjectStorage,
  ownerId: string,
  projectId: string,
  document: ModelDocument
): Promise<CadImportedStepSource | undefined> {
  const imported = document.features.filter(
    (feature) => feature.featureKind === "imported_step"
  );
  if (imported.length === 0) {
    return undefined;
  }
  if (imported.length !== 1 || imported[0]?.suppressed) {
    throw new ApiError(
      422,
      "UNSUPPORTED_IMPORTED_HISTORY",
      "V1 每个版本必须且只能包含一个未抑制的 STEP 基础实体。"
    );
  }
  const feature = imported[0];
  const artifact = await repository.getArtifact(ownerId, feature.artifactId);
  const expectedPrefix = `modeling/${encodeURIComponent(ownerId)}/${projectId}/imports/`;
  if (
    !artifact ||
    artifact.projectId !== projectId ||
    artifact.kind !== "source" ||
    artifact.checksumSha256 !== feature.artifactSha256 ||
    artifact.filename.normalize("NFKC") !==
      feature.sourceName.normalize("NFKC") ||
    artifact.sizeBytes < 1 ||
    artifact.sizeBytes > 50 * 1024 * 1024 ||
    !artifact.objectKey.startsWith(expectedPrefix) ||
    !/^[a-f0-9]{40}\.step$/u.test(
      artifact.objectKey.slice(expectedPrefix.length)
    ) ||
    !["model/step", "application/step", "application/octet-stream"].includes(
      artifact.mimeType.toLowerCase()
    )
  ) {
    throw new ApiError(
      422,
      "INVALID_IMPORT_SOURCE",
      "STEP 基础实体与当前用户、项目或不可变制品不一致。"
    );
  }
  const bytes = await storage.getPrivate(artifact.objectKey);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.byteLength !== artifact.sizeBytes ||
    checksum !== artifact.checksumSha256
  ) {
    throw new ApiError(
      422,
      "IMPORT_SOURCE_CHANGED",
      "私有 STEP 源制品与创建基础实体时的内容不一致。"
    );
  }
  return {
    artifactId: artifact.id,
    artifactSha256: artifact.checksumSha256,
    bytes,
    filename: artifact.filename,
    contentType:
      artifact.mimeType.toLowerCase() as CadImportedStepSource["contentType"]
  };
}
