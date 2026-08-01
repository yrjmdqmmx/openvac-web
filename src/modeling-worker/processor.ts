import { createHash, randomUUID } from "node:crypto";

import {
  applyOperationBatch,
  engineBuildResultSchema,
  hashCanonicalSpec,
  modelDocumentSchema
} from "@/lib/modeling";
import type {
  CadBuildResponse,
  CadImportedStepSource
} from "@/server/modeling/cad-client";
import type {
  EngineBuildResult,
  Feature,
  ModelDocument,
  ModelOperation,
  ModelOperationBatch
} from "@/types/modeling";

import { ModelingWorkerError, StaleModelingLeaseError } from "./repository";
import type {
  LeasedModelingJob,
  ModelingCadClientPort,
  ModelingObjectStoragePort,
  ModelingPlannerPort,
  ModelingPlanStore,
  ModelingRevisionSnapshot,
  ModelingWorkerRepository,
  PendingModelingArtifact
} from "./types";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const ALLOWED_FORMATS = ["step", "stl", "glb"] as const;
const STEP_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
const STEP_CONTENT_TYPES = new Set([
  "model/step",
  "application/step",
  "application/octet-stream"
]);

type ArtifactFormat = (typeof ALLOWED_FORMATS)[number];

export interface ModelingJobProcessorOptions {
  repository: ModelingWorkerRepository;
  planStore: ModelingPlanStore;
  planner: ModelingPlannerPort;
  cadClient: ModelingCadClientPort;
  objectStorage: ModelingObjectStoragePort;
  now?: () => Date;
}

export class ModelingJobProcessor {
  private readonly repository: ModelingWorkerRepository;
  private readonly planner: ModelingPlannerPort;
  private readonly cadClient: ModelingCadClientPort;
  private readonly objectStorage: ModelingObjectStoragePort;
  private readonly now: () => Date;
  private readonly previewRetentionMs: number;
  private readonly exportRetentionMs: number;
  private readonly activeCadArtifactJobs = new Set<string>();
  private readonly activeUploadedObjects = new Map<string, Set<string>>();

  constructor(options: ModelingJobProcessorOptions) {
    this.repository = options.repository;
    this.planner = options.planner;
    this.cadClient = options.cadClient;
    this.objectStorage = options.objectStorage;
    this.now = options.now ?? (() => new Date());
    this.previewRetentionMs =
      positiveRetentionDays("MODELING_PREVIEW_RETENTION_DAYS", 30) *
      MILLISECONDS_PER_DAY;
    this.exportRetentionMs =
      positiveRetentionDays("MODELING_EXPORT_RETENTION_DAYS", 7) *
      MILLISECONDS_PER_DAY;
  }

  async process(job: LeasedModelingJob, signal: AbortSignal): Promise<void> {
    const executionId = modelingExecutionId(job);
    try {
      throwIfAborted(signal);
      switch (job.kind) {
        case "ai_plan":
          await this.processAiPlan(job, signal);
          break;
        case "import":
          await this.processStepImport(job, signal);
          break;
        case "build":
        case "preview":
        case "export":
          await this.processCadBuild(job, signal);
          break;
        case "conversion":
          throw new ModelingWorkerError(
            "UNSUPPORTED_JOB_KIND",
            `建模 worker 尚未启用 ${job.kind} 任务。`
          );
      }
      this.activeUploadedObjects.delete(executionId);
      return;
    } catch (cause) {
      const cleanupFailures: unknown[] = [];
      try {
        await this.cleanupUploadedObjects(job);
      } catch (cleanupCause) {
        cleanupFailures.push(cleanupCause);
      }
      if (
        !this.activeCadArtifactJobs.has(executionId) ||
        (cause instanceof ModelingWorkerError &&
          cause.code === "CAD_ARTIFACT_CLEANUP_FAILED")
      ) {
        if (cleanupFailures.length > 0) {
          throw new ModelingWorkerError(
            "OSS_ARTIFACT_CLEANUP_FAILED",
            "建模任务失败，且已上传的私有 OSS 制品清理失败；任务不会标记成功，数据库不会丢失已持久化的制品记录。",
            { cause: new AggregateError([cause, ...cleanupFailures]) }
          );
        }
        throw cause;
      }
      try {
        await this.cleanupCadArtifacts(job);
      } catch (cleanupCause) {
        cleanupFailures.push(cleanupCause);
        throw new ModelingWorkerError(
          "CAD_ARTIFACT_CLEANUP_FAILED",
          "建模任务失败，且 CAD 服务临时制品清理也失败；任务按失败终止且不会标记成功，必须重新提交或由运维处理残留目录。",
          { cause: new AggregateError([cause, ...cleanupFailures]) }
        );
      }
      if (cleanupFailures.length > 0) {
        throw new ModelingWorkerError(
          "OSS_ARTIFACT_CLEANUP_FAILED",
          "建模任务失败，且已上传的私有 OSS 制品清理失败；任务不会标记成功。",
          { cause: new AggregateError([cause, ...cleanupFailures]) }
        );
      }
      throw cause;
    }
  }

  private async processStepImport(
    job: LeasedModelingJob,
    signal: AbortSignal
  ): Promise<void> {
    const revision = await this.repository.loadRevision(job);
    const input = parseStepImportInput(job);
    await this.repository.transition(
      job,
      "validating",
      10,
      "import_download_started",
      { objectKey: input.objectKey, sizeBytes: input.sizeBytes }
    );
    const bytes = await this.objectStorage.getPrivate(input.objectKey);
    throwIfAborted(signal);
    if (bytes.byteLength !== input.sizeBytes) {
      throw new ModelingWorkerError(
        "IMPORT_SIZE_MISMATCH",
        "私有 OSS 中的 STEP 文件大小与已确认上传不一致。"
      );
    }
    const sourceChecksum = sha256(bytes);
    if (sourceChecksum !== input.checksumSha256) {
      throw new ModelingWorkerError(
        "IMPORT_CHECKSUM_MISMATCH",
        "私有 OSS 中的 STEP 文件 SHA-256 与已确认上传不一致。"
      );
    }

    await this.repository.transition(
      job,
      "meshing",
      35,
      "import_kernel_started",
      {
        checksumSha256: sourceChecksum
      }
    );
    const executionId = modelingExecutionId(job);
    this.activeCadArtifactJobs.add(executionId);
    const result = await this.cadClient.importStep({
      jobId: executionId,
      bytes,
      filename: safeFilename(input.sourceName),
      contentType: input.contentType,
      signal
    });
    throwIfAborted(signal);
    if (
      result.source_sha256 !== sourceChecksum ||
      result.source_size_bytes !== bytes.byteLength
    ) {
      throw new ModelingWorkerError(
        "IMPORT_KERNEL_SOURCE_MISMATCH",
        "建模内核导入的 STEP 内容与私有源对象不一致。"
      );
    }
    assertValidBuild(result.valid, result.diagnostics);
    if (result.artifacts.length !== 1 || result.artifacts[0]?.kind !== "glb") {
      throw new ModelingWorkerError(
        "IMPORT_PREVIEW_MISSING",
        "STEP 导入未生成唯一的 GLB 预览制品。"
      );
    }

    const sourceArtifactId = randomUUID();
    const newRevisionId = randomUUID();
    const importedFeatureId = randomUUID();
    const semanticSuffix = `${sourceChecksum.slice(0, 12)}.${job.id.slice(0, 8)}`;
    const importedFeature: Feature = {
      id: importedFeatureId,
      semanticRef: `feature.imported-step.${semanticSuffix}`,
      name: `Imported STEP: ${input.sourceName}`.slice(0, 160),
      featureKind: "imported_step",
      artifactId: sourceArtifactId,
      artifactSha256: sourceChecksum,
      sourceName: input.sourceName,
      bodySemanticRefs: result.body_semantic_refs,
      suppressed: false
    };
    const replacementOperations = importedStepReplacementOperations(
      revision.document,
      importedFeature
    );
    const operationBatch: ModelOperationBatch = {
      version: "openvac.modeling.v1",
      id: newRevisionId,
      documentId: revision.document.id,
      baseRevisionId: revision.id,
      idempotencyKey: `import-operation:${job.id}`,
      operations: replacementOperations
    };
    const replacedDocument = applyOperationBatch(
      revision.document,
      operationBatch
    );
    const importedDocument = modelDocumentSchema.parse({
      ...replacedDocument,
      name: input.sourceName.replace(/\.(?:step|stp)$/iu, "").slice(0, 160),
      metadata: {
        description: `Opaque STEP base entity imported from ${input.sourceName}`,
        tags: ["source.imported-step"]
      }
    });

    await this.repository.transition(
      job,
      "exporting",
      75,
      "import_preview_upload_started",
      { bodyCount: result.body_semantic_refs.length }
    );
    const previewDescriptor = result.artifacts[0];
    const previewBytes = await this.cadClient.downloadArtifact(
      previewDescriptor,
      signal
    );
    const previewChecksum = sha256(previewBytes);
    if (previewChecksum !== previewDescriptor.sha256) {
      throw new ModelingWorkerError(
        "ARTIFACT_CHECKSUM_MISMATCH",
        "STEP 导入 GLB 预览的 SHA-256 校验失败。"
      );
    }
    const previewFilename = safeFilename(previewDescriptor.file_name);
    const previewObjectKey = [
      "modeling",
      job.projectId,
      newRevisionId,
      executionId,
      `${previewChecksum}-${previewFilename}`
    ].join("/");
    await this.putTrackedPrivate(job, {
      key: previewObjectKey,
      body: previewBytes,
      contentType: previewDescriptor.content_type,
      metadata: {
        projectId: job.projectId,
        revisionId: newRevisionId,
        jobId: job.id,
        executionId,
        sha256: previewChecksum,
        format: "glb"
      }
    });
    throwIfAborted(signal);

    const sourceArtifact: PendingModelingArtifact = {
      id: sourceArtifactId,
      kind: "source",
      filename: input.sourceName,
      mimeType: input.contentType,
      objectKey: input.objectKey,
      checksumSha256: sourceChecksum,
      sizeBytes: bytes.byteLength,
      expiresAt: null,
      metadata: {
        protocolVersion: result.version,
        bodySemanticRefs: result.body_semantic_refs
      }
    };
    const previewArtifact: PendingModelingArtifact = {
      id: randomUUID(),
      kind: "preview",
      filename: previewFilename,
      mimeType: previewDescriptor.content_type,
      objectKey: previewObjectKey,
      checksumSha256: previewChecksum,
      sizeBytes: previewBytes.byteLength,
      expiresAt: new Date(this.now().getTime() + this.previewRetentionMs),
      metadata: {
        protocolVersion: result.version,
        format: "glb",
        sourceSha256: sourceChecksum,
        kernelVersion: result.kernel_version
      }
    };
    await this.cleanupCadArtifacts(job);
    const completion = await this.repository.completeImport(job, {
      document: importedDocument,
      contentHash: hashCanonicalSpec(importedDocument),
      operations: operationBatch.operations,
      sourceArtifact,
      previewArtifacts: [previewArtifact],
      output: {
        valid: result.valid,
        sourceSha256: sourceChecksum,
        sourceSizeBytes: bytes.byteLength,
        sourceArtifactId,
        importedFeatureId,
        bodySemanticRefs: result.body_semantic_refs,
        kernelVersion: result.kernel_version,
        metrics: result.metrics,
        diagnostics: result.diagnostics,
        durationMs: result.duration_ms
      }
    });
    if (completion.status === "cancelled") {
      throw new ModelingCancellationAfterCompletionError(job.id);
    }
  }

  private async processAiPlan(
    job: LeasedModelingJob,
    signal: AbortSignal
  ): Promise<void> {
    const revision = await this.repository.loadRevision(job);
    const input = parseAiPlanInput(job);
    if (
      input.baseRevisionId !== revision.id ||
      input.baseRevisionHash !== revision.contentHash
    ) {
      throw new ModelingWorkerError(
        "STALE_PLAN_BASE",
        "AI 计划任务的基础版本已变化。"
      );
    }

    const existingPlan = await this.repository.loadExistingAiPlan(job);
    if (
      existingPlan &&
      (existingPlan.baseRevisionId !== revision.id ||
        existingPlan.baseRevisionHash !== revision.contentHash ||
        existingPlan.prompt !== input.prompt)
    ) {
      throw new ModelingWorkerError(
        "AI_PLAN_REPLAY_CONFLICT",
        "恢复的 AI 计划与当前任务输入不一致。"
      );
    }
    await this.repository.transition(job, "running", 10, "planning", {
      baseRevisionId: revision.id,
      recoveredPlan: Boolean(existingPlan)
    });
    const draft =
      existingPlan?.draft ??
      (await this.planner({
        document: revision.document,
        baseRevisionId: revision.id,
        prompt: input.prompt,
        idempotencyKey: job.idempotencyKey,
        selectedSemanticRefs: input.selectedSemanticRefs,
        signal
      }));
    throwIfAborted(signal);

    let dryRun: Record<string, unknown> | null = null;
    const dryRunArtifacts: PendingModelingArtifact[] = [];
    if (draft.status === "validated") {
      if (!draft.operationBatch) {
        throw new ModelingWorkerError(
          "INVALID_PLAN",
          "已验证的 AI 计划缺少操作批次。"
        );
      }
      await this.repository.transition(
        job,
        "validating",
        45,
        "dry_run_started",
        { planHash: draft.planHash }
      );
      const previewDocument = applyOperationBatch(
        revision.document,
        draft.operationBatch
      );
      const hasActiveSolidFeatures = previewDocument.features.some(
        (feature) => !feature.suppressed
      );
      const importedFeature = importedStepFeature(previewDocument);
      const importedStep = importedFeature
        ? await this.resolveImportedStepSource(job, importedFeature, signal)
        : undefined;
      const executionId = modelingExecutionId(job);
      const validationRequest = {
        jobId: executionId,
        document: previewDocument,
        validatePump: booleanInput(job.input.validatePump, false),
        importedStep,
        signal
      };
      this.activeCadArtifactJobs.add(executionId);
      const result = hasActiveSolidFeatures
        ? await this.cadClient.build({
            ...validationRequest,
            formats: ["glb"]
          })
        : await this.cadClient.validate(validationRequest);
      throwIfAborted(signal);
      assertValidBuild(result.valid, result.diagnostics);
      if (!hasActiveSolidFeatures && result.artifacts.length > 0) {
        throw new ModelingWorkerError(
          "PLAN_VALIDATION_ARTIFACT_UNEXPECTED",
          "纯草图 AI 计划校验不应生成几何制品。"
        );
      }
      if (
        hasActiveSolidFeatures &&
        (result.artifacts.length !== 1 || result.artifacts[0]?.kind !== "glb")
      ) {
        throw new ModelingWorkerError(
          "PLAN_PREVIEW_MISSING",
          "AI 计划干跑未生成唯一的 GLB 预览。"
        );
      }
      const previewDescriptor = result.artifacts[0];
      if (hasActiveSolidFeatures && previewDescriptor) {
        const previewBytes = await this.cadClient.downloadArtifact(
          previewDescriptor,
          signal
        );
        const previewChecksum = sha256(previewBytes);
        if (previewChecksum !== previewDescriptor.sha256) {
          throw new ModelingWorkerError(
            "ARTIFACT_CHECKSUM_MISMATCH",
            "AI 计划 GLB 预览的 SHA-256 校验失败。"
          );
        }
        const previewFilename = safeFilename(previewDescriptor.file_name);
        const previewObjectKey = [
          "modeling",
          job.projectId,
          revision.id,
          executionId,
          `plan-${previewChecksum}-${previewFilename}`
        ].join("/");
        await this.putTrackedPrivate(job, {
          key: previewObjectKey,
          body: previewBytes,
          contentType: previewDescriptor.content_type,
          metadata: {
            projectId: job.projectId,
            baseRevisionId: revision.id,
            jobId: job.id,
            executionId,
            planHash: draft.planHash,
            sha256: previewChecksum,
            format: "glb"
          }
        });
        throwIfAborted(signal);
        dryRunArtifacts.push({
          id: randomUUID(),
          kind: "preview",
          filename: previewFilename,
          mimeType: previewDescriptor.content_type,
          objectKey: previewObjectKey,
          checksumSha256: previewChecksum,
          sizeBytes: previewBytes.byteLength,
          expiresAt: new Date(this.now().getTime() + this.previewRetentionMs),
          metadata: {
            protocolVersion: result.version,
            planHash: draft.planHash,
            modelHash: result.model_hash,
            kernelVersion: result.kernel_version
          }
        });
      }
      dryRun = {
        valid: result.valid,
        modelHash: result.model_hash,
        kernelVersion: result.kernel_version,
        solverVersion: result.solver_version,
        metrics: result.metrics,
        diagnostics: result.diagnostics,
        durationMs: result.duration_ms
      };
      await this.cleanupCadArtifacts(job);
    }

    await this.repository.transition(job, "running", 85, "plan_storing", {
      planHash: draft.planHash,
      status: draft.status
    });
    const completion = await this.repository.completeAiPlan(job, {
      baseRevisionHash: revision.contentHash,
      prompt: input.prompt,
      draft,
      dryRun,
      artifacts: dryRunArtifacts
    });
    if (completion.status === "cancelled") {
      throw new ModelingCancellationAfterCompletionError(job.id);
    }
  }

  private async processCadBuild(
    job: LeasedModelingJob,
    signal: AbortSignal
  ): Promise<void> {
    const revision = await this.repository.loadRevision(job);
    const formats = formatsForJob(job);
    const importedFeature = importedStepFeature(revision.document);
    if (importedFeature && isOpaqueImportOnly(revision.document)) {
      await this.processImportedCadBuild(
        job,
        revision,
        importedFeature,
        formats,
        signal
      );
      return;
    }
    const importedStep = importedFeature
      ? await this.resolveImportedStepSource(job, importedFeature, signal)
      : undefined;
    await this.repository.transition(
      job,
      "validating",
      10,
      "validation_started",
      {
        revisionId: revision.id,
        formats
      }
    );
    await this.repository.transition(job, "meshing", 25, "kernel_started", {
      revisionId: revision.id
    });
    const executionId = modelingExecutionId(job);
    this.activeCadArtifactJobs.add(executionId);
    const result = await this.cadClient.build({
      jobId: executionId,
      document: revision.document,
      formats,
      validatePump: booleanInput(job.input.validatePump, false),
      importedStep,
      signal
    });
    throwIfAborted(signal);
    assertValidBuild(result.valid, result.diagnostics);
    assertRequestedArtifacts(
      formats,
      result.artifacts.map((item) => item.kind)
    );

    await this.repository.transition(
      job,
      "exporting",
      70,
      "artifact_upload_started",
      {
        artifactCount: result.artifacts.length
      }
    );
    const artifacts: PendingModelingArtifact[] = [];
    for (const descriptor of result.artifacts) {
      throwIfAborted(signal);
      const bytes = await this.cadClient.downloadArtifact(descriptor, signal);
      const checksum = sha256(bytes);
      if (checksum !== descriptor.sha256) {
        throw new ModelingWorkerError(
          "ARTIFACT_CHECKSUM_MISMATCH",
          `建模制品 ${descriptor.file_name} 的 SHA-256 校验失败。`
        );
      }
      const filename = safeFilename(descriptor.file_name);
      const objectKey = [
        "modeling",
        job.projectId,
        revision.id,
        executionId,
        `${descriptor.sha256}-${filename}`
      ].join("/");
      await this.putTrackedPrivate(job, {
        key: objectKey,
        body: bytes,
        contentType: descriptor.content_type,
        metadata: {
          projectId: job.projectId,
          revisionId: revision.id,
          jobId: job.id,
          executionId,
          sha256: descriptor.sha256,
          format: descriptor.kind
        }
      });
      throwIfAborted(signal);
      artifacts.push({
        id: randomUUID(),
        kind: artifactKind(job.kind, descriptor.kind),
        filename,
        mimeType: descriptor.content_type,
        objectKey,
        checksumSha256: descriptor.sha256,
        sizeBytes: bytes.byteLength,
        expiresAt: artifactExpiry(
          job.kind,
          descriptor.kind,
          this.now(),
          this.previewRetentionMs,
          this.exportRetentionMs
        ),
        metadata: {
          protocolVersion: result.version,
          format: descriptor.kind,
          modelHash: result.model_hash,
          kernelVersion: result.kernel_version,
          solverVersion: result.solver_version
        }
      });
    }

    await this.cleanupCadArtifacts(job);
    const completion = await this.repository.complete(
      job,
      {
        valid: result.valid,
        modelHash: result.model_hash,
        kernelVersion: result.kernel_version,
        solverVersion: result.solver_version,
        metrics: result.metrics,
        diagnostics: result.diagnostics,
        durationMs: result.duration_ms,
        formats,
        engineResult: successfulEngineBuildResult(
          job,
          revision,
          {
            kernelVersion: result.kernel_version,
            metrics: result.metrics,
            diagnostics: result.diagnostics,
            durationMs: result.duration_ms
          },
          artifacts
        )
      },
      artifacts
    );
    if (completion.status === "cancelled") {
      throw new ModelingCancellationAfterCompletionError(job.id);
    }
  }

  private async processImportedCadBuild(
    job: LeasedModelingJob,
    revision: ModelingRevisionSnapshot,
    feature: Extract<Feature, { featureKind: "imported_step" }>,
    formats: ArtifactFormat[],
    signal: AbortSignal
  ): Promise<void> {
    await this.repository.transition(
      job,
      "validating",
      10,
      "import_source_validation_started",
      { revisionId: revision.id, artifactId: feature.artifactId, formats }
    );
    const source = await this.repository.loadSourceArtifact(
      job,
      feature.artifactId
    );
    const expectedPrefix = `modeling/${encodeURIComponent(job.ownerId)}/${job.projectId}/imports/`;
    if (
      source.projectId !== job.projectId ||
      source.checksumSha256 !== feature.artifactSha256 ||
      source.filename.normalize("NFKC") !==
        feature.sourceName.normalize("NFKC") ||
      source.sizeBytes < 1 ||
      source.sizeBytes > STEP_IMPORT_MAX_BYTES ||
      !source.objectKey.startsWith(expectedPrefix) ||
      !/^[a-f0-9]{40}\.step$/u.test(
        source.objectKey.slice(expectedPrefix.length)
      ) ||
      !STEP_CONTENT_TYPES.has(source.mimeType.toLowerCase())
    ) {
      throw new ModelingWorkerError(
        "INVALID_IMPORT_SOURCE",
        "导入特征与当前用户的私有 STEP 源制品不一致。"
      );
    }
    const sourceBytes = await this.objectStorage.getPrivate(source.objectKey);
    throwIfAborted(signal);
    if (
      sourceBytes.byteLength !== source.sizeBytes ||
      sha256(sourceBytes) !== source.checksumSha256
    ) {
      throw new ModelingWorkerError(
        "IMPORT_SOURCE_CHANGED",
        "私有 STEP 源制品在版本创建后发生变化。"
      );
    }

    const convertedFormats = formats.filter(
      (format): format is "stl" | "glb" => format !== "step"
    );
    const kernelFormats: Array<"stl" | "glb"> =
      convertedFormats.length > 0 ? convertedFormats : ["glb"];
    await this.repository.transition(
      job,
      "meshing",
      30,
      "import_source_kernel_started",
      { formats: kernelFormats }
    );
    const executionId = modelingExecutionId(job);
    this.activeCadArtifactJobs.add(executionId);
    const result = await this.cadClient.importStep({
      jobId: executionId,
      bytes: sourceBytes,
      filename: safeFilename(source.filename),
      contentType: source.mimeType.toLowerCase() as
        "model/step" | "application/step" | "application/octet-stream",
      formats: kernelFormats,
      signal
    });
    throwIfAborted(signal);
    if (
      result.source_sha256 !== source.checksumSha256 ||
      result.source_size_bytes !== source.sizeBytes ||
      !sameStrings(result.body_semantic_refs, feature.bodySemanticRefs)
    ) {
      throw new ModelingWorkerError(
        "IMPORT_REBUILD_MISMATCH",
        "STEP 源重建结果与不可变导入特征不一致。"
      );
    }
    assertValidBuild(result.valid, result.diagnostics);
    assertRequestedArtifacts(
      convertedFormats,
      result.artifacts.map((artifact) => artifact.kind)
    );

    await this.repository.transition(
      job,
      "exporting",
      70,
      "artifact_upload_started",
      { artifactCount: formats.length, importedStep: true }
    );
    const artifacts: PendingModelingArtifact[] = [];
    for (const format of formats) {
      throwIfAborted(signal);
      let bytes: Uint8Array;
      let checksum: string;
      let filename: string;
      let mimeType: string;
      if (format === "step") {
        bytes = sourceBytes;
        checksum = source.checksumSha256;
        filename = safeFilename(source.filename);
        mimeType = "model/step";
      } else {
        const descriptor = result.artifacts.find(
          (artifact) => artifact.kind === format
        );
        if (!descriptor) {
          throw new ModelingWorkerError(
            "ARTIFACT_MISSING",
            `STEP 转换未返回 ${format.toUpperCase()} 制品。`
          );
        }
        bytes = await this.cadClient.downloadArtifact(descriptor, signal);
        checksum = sha256(bytes);
        if (checksum !== descriptor.sha256) {
          throw new ModelingWorkerError(
            "ARTIFACT_CHECKSUM_MISMATCH",
            `STEP 转换制品 ${descriptor.file_name} 的 SHA-256 校验失败。`
          );
        }
        filename = safeFilename(descriptor.file_name);
        mimeType = descriptor.content_type;
      }
      const objectKey = [
        "modeling",
        job.projectId,
        revision.id,
        executionId,
        `${checksum}-${filename}`
      ].join("/");
      await this.putTrackedPrivate(job, {
        key: objectKey,
        body: bytes,
        contentType: mimeType,
        metadata: {
          projectId: job.projectId,
          revisionId: revision.id,
          jobId: job.id,
          executionId,
          sourceArtifactId: source.id,
          sha256: checksum,
          format
        }
      });
      artifacts.push({
        id: randomUUID(),
        kind: artifactKind(job.kind, format),
        filename,
        mimeType,
        objectKey,
        checksumSha256: checksum,
        sizeBytes: bytes.byteLength,
        expiresAt: artifactExpiry(
          job.kind,
          format,
          this.now(),
          this.previewRetentionMs,
          this.exportRetentionMs
        ),
        metadata: {
          protocolVersion: result.version,
          format,
          importedStep: true,
          sourceArtifactId: source.id,
          sourceSha256: source.checksumSha256,
          kernelVersion: result.kernel_version
        }
      });
    }

    await this.cleanupCadArtifacts(job);
    const completion = await this.repository.complete(
      job,
      {
        valid: result.valid,
        importedStep: true,
        sourceArtifactId: source.id,
        sourceSha256: source.checksumSha256,
        kernelVersion: result.kernel_version,
        metrics: result.metrics,
        diagnostics: result.diagnostics,
        durationMs: result.duration_ms,
        formats,
        engineResult: successfulEngineBuildResult(
          job,
          revision,
          {
            kernelVersion: result.kernel_version,
            metrics: result.metrics,
            diagnostics: result.diagnostics,
            durationMs: result.duration_ms
          },
          artifacts
        )
      },
      artifacts
    );
    if (completion.status === "cancelled") {
      throw new ModelingCancellationAfterCompletionError(job.id);
    }
  }

  private async cleanupCadArtifacts(job: LeasedModelingJob): Promise<void> {
    const executionId = modelingExecutionId(job);
    const failures: unknown[] = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        // Deliberately do not pass the user cancellation signal. Once kernel
        // output exists, tmpfs hygiene must finish even if the job is cancelled.
        await this.cadClient.cleanupArtifacts(executionId);
        this.activeCadArtifactJobs.delete(executionId);
        return;
      } catch (cause) {
        failures.push(cause);
      }
    }
    throw new ModelingWorkerError(
      "CAD_ARTIFACT_CLEANUP_FAILED",
      "CAD 服务临时制品连续两次清理失败；任务按失败终止且不会标记成功，必须重新提交并检查残留目录。",
      { cause: new AggregateError(failures) }
    );
  }

  private async putTrackedPrivate(
    job: LeasedModelingJob,
    request: Parameters<ModelingObjectStoragePort["putPrivate"]>[0]
  ): Promise<void> {
    const executionId = modelingExecutionId(job);
    const keys =
      this.activeUploadedObjects.get(executionId) ?? new Set<string>();
    keys.add(request.key);
    this.activeUploadedObjects.set(executionId, keys);
    await this.objectStorage.putPrivate(request);
  }

  private async cleanupUploadedObjects(job: LeasedModelingJob): Promise<void> {
    const executionId = modelingExecutionId(job);
    const keys = this.activeUploadedObjects.get(executionId);
    if (!keys || keys.size === 0) return;
    const failures: unknown[] = [];
    for (const key of keys) {
      try {
        await this.objectStorage.deletePrivate(key);
        keys.delete(key);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (keys.size === 0) this.activeUploadedObjects.delete(executionId);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Unable to remove uncommitted private OSS artifacts"
      );
    }
  }

  private async resolveImportedStepSource(
    job: LeasedModelingJob,
    feature: Extract<Feature, { featureKind: "imported_step" }>,
    signal: AbortSignal
  ): Promise<CadImportedStepSource> {
    const source = await this.repository.loadSourceArtifact(
      job,
      feature.artifactId
    );
    const expectedPrefix = `modeling/${encodeURIComponent(job.ownerId)}/${job.projectId}/imports/`;
    if (
      source.projectId !== job.projectId ||
      source.checksumSha256 !== feature.artifactSha256 ||
      source.filename.normalize("NFKC") !==
        feature.sourceName.normalize("NFKC") ||
      source.sizeBytes < 1 ||
      source.sizeBytes > STEP_IMPORT_MAX_BYTES ||
      !source.objectKey.startsWith(expectedPrefix) ||
      !/^[a-f0-9]{40}\.step$/u.test(
        source.objectKey.slice(expectedPrefix.length)
      ) ||
      !STEP_CONTENT_TYPES.has(source.mimeType.toLowerCase())
    ) {
      throw new ModelingWorkerError(
        "INVALID_IMPORT_SOURCE",
        "导入特征与当前用户的私有 STEP 源制品不一致。"
      );
    }
    const bytes = await this.objectStorage.getPrivate(source.objectKey);
    throwIfAborted(signal);
    if (
      bytes.byteLength !== source.sizeBytes ||
      sha256(bytes) !== source.checksumSha256
    ) {
      throw new ModelingWorkerError(
        "IMPORT_SOURCE_CHANGED",
        "私有 STEP 源制品在版本创建后发生变化。"
      );
    }
    return {
      artifactId: source.id,
      artifactSha256: source.checksumSha256,
      bytes,
      filename: safeFilename(source.filename),
      contentType:
        source.mimeType.toLowerCase() as CadImportedStepSource["contentType"]
    };
  }
}

/** Complete() can atomically observe a late cancellation after all work ended. */
export class ModelingCancellationAfterCompletionError extends Error {
  constructor(jobId: string) {
    super(`Modeling job ${jobId} was cancelled before completion committed.`);
    this.name = "ModelingCancellationAfterCompletionError";
  }
}

function parseAiPlanInput(job: LeasedModelingJob): {
  baseRevisionId: string;
  baseRevisionHash: string;
  prompt: string;
  selectedSemanticRefs: string[];
} {
  const baseRevisionId = stringInput(
    job.input.baseRevisionId,
    "baseRevisionId"
  );
  const baseRevisionHash = stringInput(
    job.input.baseRevisionHash,
    "baseRevisionHash"
  );
  if (!/^[a-f0-9]{64}$/u.test(baseRevisionHash)) {
    throw new ModelingWorkerError(
      "INVALID_JOB_INPUT",
      "AI 计划基础版本哈希无效。"
    );
  }
  const prompt = stringInput(job.input.prompt, "prompt").trim();
  if (prompt.length < 2 || prompt.length > 4_000) {
    throw new ModelingWorkerError(
      "INVALID_JOB_INPUT",
      "AI 建模指令必须为 2–4000 个字符。"
    );
  }
  const selected = job.input.selectedSemanticRefs;
  if (
    selected !== undefined &&
    (!Array.isArray(selected) ||
      selected.length > 100 ||
      selected.some((item) => typeof item !== "string" || !item.trim()))
  ) {
    throw new ModelingWorkerError(
      "INVALID_JOB_INPUT",
      "AI 计划选择对象列表无效。"
    );
  }
  return {
    baseRevisionId,
    baseRevisionHash,
    prompt,
    selectedSemanticRefs: (selected as string[] | undefined) ?? []
  };
}

function parseStepImportInput(job: LeasedModelingJob): {
  objectKey: string;
  sourceName: string;
  sizeBytes: number;
  checksumSha256: string;
  contentType: "model/step" | "application/step" | "application/octet-stream";
} {
  const objectKey = stringInput(job.input.objectKey, "objectKey");
  const expectedPrefix = `modeling/${encodeURIComponent(job.ownerId)}/${job.projectId}/imports/`;
  if (
    !objectKey.startsWith(expectedPrefix) ||
    !/^[a-f0-9]{40}\.step$/u.test(objectKey.slice(expectedPrefix.length))
  ) {
    throw new ModelingWorkerError(
      "INVALID_IMPORT_OBJECT_KEY",
      "STEP 私有对象不属于任务用户和项目。"
    );
  }
  const sourceName = stringInput(job.input.sourceName, "sourceName")
    .normalize("NFKC")
    .trim();
  if (
    sourceName.length > 255 ||
    sourceName.includes("\0") ||
    sourceName.includes("/") ||
    sourceName.includes("\\") ||
    !/\.(?:step|stp)$/iu.test(sourceName)
  ) {
    throw new ModelingWorkerError(
      "INVALID_IMPORT_SOURCE_NAME",
      "STEP 源文件名无效。"
    );
  }
  const sizeBytes = job.input.sizeBytes;
  if (
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > STEP_IMPORT_MAX_BYTES
  ) {
    throw new ModelingWorkerError(
      "INVALID_IMPORT_SIZE",
      "STEP 文件必须大于 0 且不超过 50 MB。"
    );
  }
  const checksumSha256 = stringInput(
    job.input.checksumSha256,
    "checksumSha256"
  );
  if (!/^[a-f0-9]{64}$/u.test(checksumSha256)) {
    throw new ModelingWorkerError(
      "INVALID_IMPORT_CHECKSUM",
      "STEP 文件 SHA-256 无效。"
    );
  }
  const contentType = stringInput(
    job.input.contentType,
    "contentType"
  ).toLowerCase();
  if (!STEP_CONTENT_TYPES.has(contentType)) {
    throw new ModelingWorkerError(
      "INVALID_IMPORT_CONTENT_TYPE",
      "STEP 文件 Content-Type 不受支持。"
    );
  }
  return {
    objectKey,
    sourceName,
    sizeBytes,
    checksumSha256,
    contentType: contentType as
      "model/step" | "application/step" | "application/octet-stream"
  };
}

function importedStepReplacementOperations(
  document: ModelDocument,
  importedFeature: Feature
): ModelOperation[] {
  const remove = <
    T extends { id: string; semanticRef: string },
    C extends
      | "parameters"
      | "sketches"
      | "features"
      | "components"
      | "assemblyConstraints"
  >(
    collection: C,
    values: readonly T[]
  ): ModelOperation[] =>
    values.map((value) => ({
      operationId: randomUUID(),
      kind: "delete" as const,
      collection,
      target: { id: value.id, semanticRef: value.semanticRef }
    })) as ModelOperation[];

  // Delete dependants before their referenced definitions. The operation log
  // therefore describes a true document replacement instead of pretending an
  // imported solid was appended to a parametric pump history.
  const operations: ModelOperation[] = [
    ...remove("assemblyConstraints", document.assemblyConstraints),
    ...remove("components", document.components),
    ...remove("features", document.features),
    ...remove("sketches", document.sketches),
    ...remove("parameters", document.parameters),
    {
      operationId: randomUUID(),
      kind: "add",
      collection: "features",
      item: importedFeature
    }
  ];
  if (operations.length > 500) {
    throw new ModelingWorkerError(
      "IMPORT_REPLACEMENT_TOO_LARGE",
      "当前项目历史过大，无法在单个受限操作批次中替换为 STEP 基础实体。"
    );
  }
  return operations;
}

function importedStepFeature(
  document: ModelDocument
): Extract<Feature, { featureKind: "imported_step" }> | null {
  const imported = document.features.filter(
    (feature): feature is Extract<Feature, { featureKind: "imported_step" }> =>
      feature.featureKind === "imported_step"
  );
  if (imported.length === 0) {
    return null;
  }
  if (imported.length !== 1 || imported[0]?.suppressed) {
    throw new ModelingWorkerError(
      "UNSUPPORTED_IMPORTED_HISTORY",
      "V1 每个版本必须且只能包含一个未抑制的 STEP 基础实体。"
    );
  }
  return imported[0] ?? null;
}

function isOpaqueImportOnly(document: ModelDocument): boolean {
  return (
    document.features.length === 1 &&
    document.parameters.length === 0 &&
    document.sketches.length === 0 &&
    document.components.length === 0 &&
    document.assemblyConstraints.length === 0 &&
    document.metadata?.template === undefined
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function formatsForJob(job: LeasedModelingJob): ArtifactFormat[] {
  if (job.kind === "preview") {
    return ["glb"];
  }
  const fallback: ArtifactFormat[] = job.kind === "build" ? ["glb"] : ["step"];
  const value = job.input.formats;
  if (value === undefined) {
    return fallback;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new ModelingWorkerError(
      "INVALID_JOB_INPUT",
      "建模导出格式列表无效。"
    );
  }
  const unique = [...new Set(value)];
  if (
    unique.some(
      (format) =>
        typeof format !== "string" ||
        !ALLOWED_FORMATS.includes(format as ArtifactFormat)
    )
  ) {
    throw new ModelingWorkerError(
      "INVALID_JOB_INPUT",
      "建模任务包含不支持的导出格式。"
    );
  }
  return unique as ArtifactFormat[];
}

function artifactKind(
  jobKind: LeasedModelingJob["kind"],
  format: ArtifactFormat
): PendingModelingArtifact["kind"] {
  if (jobKind === "export") {
    return "export";
  }
  if (jobKind === "preview" || format === "glb") {
    return "preview";
  }
  return "model";
}

function artifactExpiry(
  jobKind: LeasedModelingJob["kind"],
  format: ArtifactFormat,
  now: Date,
  previewRetentionMs: number,
  exportRetentionMs: number
): Date | null {
  if (jobKind === "export") {
    return new Date(now.getTime() + exportRetentionMs);
  }
  if (jobKind === "preview" || format === "glb") {
    return new Date(now.getTime() + previewRetentionMs);
  }
  return null;
}

function positiveRetentionDays(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function modelingExecutionId(job: LeasedModelingJob): string {
  const executionId = `${job.id}_${job.leaseToken}`;
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(executionId)) {
    throw new ModelingWorkerError(
      "INVALID_EXECUTION_ID",
      "建模任务租约无法生成安全的内核执行标识。"
    );
  }
  return executionId;
}

type SuccessfulCadSummary = {
  kernelVersion: string;
  metrics: CadBuildResponse["metrics"];
  diagnostics: CadBuildResponse["diagnostics"];
  durationMs: number;
};

function successfulEngineBuildResult(
  job: LeasedModelingJob,
  revision: ModelingRevisionSnapshot,
  result: SuccessfulCadSummary,
  artifacts: PendingModelingArtifact[]
): EngineBuildResult {
  if (!result.metrics) {
    throw new ModelingWorkerError(
      "CAD_METRICS_MISSING",
      "成功的实体构建没有返回质量、体积与包络指标。"
    );
  }
  const metrics = result.metrics;
  const identities = [
    ...revision.document.parameters,
    ...revision.document.sketches,
    ...revision.document.sketches.flatMap((sketch) => [
      ...sketch.entities,
      ...sketch.constraints
    ]),
    ...revision.document.features,
    ...revision.document.components,
    ...revision.document.assemblyConstraints
  ];
  return engineBuildResultSchema.parse({
    version: revision.document.version,
    status: "succeeded",
    jobId: job.id,
    documentId: revision.document.id,
    revisionId: revision.id,
    specHash: revision.contentHash,
    engine: {
      name: "CadQuery/OCP/OCCT",
      version: result.kernelVersion
    },
    diagnostics: result.diagnostics.map((diagnostic) => ({
      level: diagnostic.severity,
      diagnosticId: diagnosticSemanticRef(diagnostic.code),
      message: diagnostic.message,
      references: String(diagnostic.target_id ?? "")
        .split("|")
        .map((target) =>
          identities.find(
            (identity) =>
              identity.id === target || identity.semanticRef === target
          )
        )
        .filter((identity) => identity !== undefined)
        .map(({ id, semanticRef }) => ({ id, semanticRef }))
    })),
    artifacts: artifacts.map((artifact) => {
      const kind = artifact.metadata.format;
      if (!ALLOWED_FORMATS.includes(kind as ArtifactFormat)) {
        throw new ModelingWorkerError(
          "INVALID_ARTIFACT_FORMAT",
          "建模制品缺少可验证的协议格式。"
        );
      }
      return {
        artifactId: artifact.id,
        kind,
        mediaType: artifact.mimeType,
        byteLength: artifact.sizeBytes,
        sha256: artifact.checksumSha256
      };
    }),
    metrics: {
      bodyCount: metrics.solid_count,
      volumeMm3: metrics.volume_mm3,
      surfaceAreaMm2: metrics.surface_area_mm2,
      boundingBoxMm: metrics.bounding_box_mm,
      centerOfMassMm: metrics.center_of_mass_mm,
      massKg: metrics.mass_kg,
      massStatus: metrics.mass_status
    },
    durationMs: Math.round(result.durationMs)
  });
}

function diagnosticSemanticRef(code: string) {
  const suffix =
    code
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, ".")
      .replace(/^\.+|\.+$/gu, "") || "unknown";
  return `diagnostic.${suffix}`;
}

function assertValidBuild(
  valid: boolean,
  diagnostics: Array<{ severity: string; code: string; message: string }>
): void {
  if (valid) {
    return;
  }
  const error = diagnostics.find((item) => item.severity === "error");
  throw new ModelingWorkerError(
    "CAD_BUILD_INVALID",
    error
      ? `确定性 CAD 内核拒绝了模型：${error.code} ${error.message}`
      : "确定性 CAD 内核返回了无效实体。"
  );
}

function assertRequestedArtifacts(
  requested: ArtifactFormat[],
  received: ArtifactFormat[]
): void {
  const receivedSet = new Set(received);
  const missing = requested.filter((format) => !receivedSet.has(format));
  if (missing.length > 0) {
    throw new ModelingWorkerError(
      "ARTIFACT_MISSING",
      `确定性 CAD 内核未返回请求的制品：${missing.join(", ")}。`
    );
  }
}

function stringInput(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ModelingWorkerError(
      "INVALID_JOB_INPUT",
      `建模任务缺少 ${field}。`
    );
  }
  return value;
}

function booleanInput(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ModelingWorkerError(
      "INVALID_JOB_INPUT",
      "validatePump 必须是布尔值。"
    );
  }
  return value;
}

function safeFilename(value: string): string {
  const filename = value
    .normalize("NFKC")
    .replaceAll("\\", "-")
    .replaceAll("/", "-")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^\.+/u, "")
    .slice(0, 160);
  if (!filename || filename === "." || filename === "..") {
    throw new ModelingWorkerError(
      "INVALID_ARTIFACT_NAME",
      "建模内核返回了无效制品文件名。"
    );
  }
  return filename;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  throw new StaleModelingLeaseError("unknown");
}
