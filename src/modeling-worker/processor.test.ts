import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CadBuildResponse,
  CadStepImportResponse
} from "@/server/modeling/cad-client";
import type { ModelingPlanRow } from "@/server/modeling/repository";
import type { ModelDocument, ModelingPlanDraft } from "@/types/modeling";

import { ModelingJobProcessor } from "./processor";
import { StaleModelingLeaseError } from "./repository";
import type {
  LeasedModelingJob,
  ModelingCadClientPort,
  ModelingObjectStoragePort,
  ModelingPlanStore,
  ModelingWorkerRepository
} from "./types";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const SOURCE_ARTIFACT_ID = "55555555-5555-4555-8555-555555555555";
const LEASE_TOKEN = "55555555-5555-4555-8555-555555555555";
const EXECUTION_ID = `${JOB_ID}_${LEASE_TOKEN}`;
const HASH = "a".repeat(64);

describe("ModelingJobProcessor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores a needs-input AI plan without executing geometry", async () => {
    const repository = fakeRepository();
    const draft = needsInputDraft();
    const planStore = fakePlanStore(draft);
    const cadClient = fakeCadClient();
    const planner = vi.fn(async () => draft);
    const processor = new ModelingJobProcessor({
      repository,
      planStore,
      planner,
      cadClient,
      objectStorage: fakeStorage()
    });

    await processor.process(aiJob(), new AbortController().signal);

    expect(planner).toHaveBeenCalledOnce();
    expect(planStore.storeGeneratedPlan).not.toHaveBeenCalled();
    expect(cadClient.build).not.toHaveBeenCalled();
    expect(cadClient.cleanupArtifacts).not.toHaveBeenCalled();
    expect(repository.completeAiPlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: JOB_ID }),
      expect.objectContaining({
        baseRevisionHash: HASH,
        draft,
        dryRun: null,
        artifacts: []
      })
    );
  });

  it("recovers a previously stored AI plan without generating new random IDs", async () => {
    const repository = fakeRepository();
    const draft = needsInputDraft();
    vi.mocked(repository.loadExistingAiPlan).mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      projectId: PROJECT_ID,
      baseRevisionId: REVISION_ID,
      baseRevisionHash: HASH,
      planHash: draft.planHash,
      prompt: "把转子直径改为 42 mm",
      draft,
      status: "needs_input",
      missingInputs: draft.missingInputs
    });
    const planner = vi.fn(async () => validatedDraft());
    const processor = new ModelingJobProcessor({
      repository,
      planStore: fakePlanStore(draft),
      planner,
      cadClient: fakeCadClient(),
      objectStorage: fakeStorage()
    });

    await processor.process(aiJob(), new AbortController().signal);

    expect(planner).not.toHaveBeenCalled();
    expect(repository.transition).toHaveBeenCalledWith(
      expect.anything(),
      "running",
      10,
      "planning",
      expect.objectContaining({ recoveredPlan: true })
    );
    expect(repository.completeAiPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ draft })
    );
  });

  it("dry-runs a validated AI plan before storing it", async () => {
    const repository = fakeRepository();
    const sourceBytes = new TextEncoder().encode(
      "ISO-10303-21;AI-PLAN-SOURCE;ENDSEC;"
    );
    const sourceChecksum = createHash("sha256")
      .update(sourceBytes)
      .digest("hex");
    vi.mocked(repository.loadRevision).mockResolvedValue({
      id: REVISION_ID,
      projectId: PROJECT_ID,
      contentHash: HASH,
      document: importedDocument(sourceChecksum, [
        `import.body.${sourceChecksum.slice(0, 12)}.0123456789ab.1`
      ])
    });
    vi.mocked(repository.loadSourceArtifact).mockResolvedValue({
      id: SOURCE_ARTIFACT_ID,
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
      filename: "housing.step",
      mimeType: "model/step",
      objectKey: `modeling/user-1/${PROJECT_ID}/imports/${"e".repeat(40)}.step`,
      checksumSha256: sourceChecksum,
      sizeBytes: sourceBytes.byteLength
    });
    const draft = validatedDraft();
    const planStore = fakePlanStore(draft);
    const previewBytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
    const previewChecksum = createHash("sha256")
      .update(previewBytes)
      .digest("hex");
    const cadClient = fakeCadClient(
      validBuild([
        {
          kind: "glb",
          file_name: "model.glb",
          content_type: "model/gltf-binary",
          size_bytes: previewBytes.byteLength,
          sha256: previewChecksum,
          download_path: `/v1/artifacts/${JOB_ID}/model.glb`
        }
      ]),
      previewBytes
    );
    const storage = fakeStorage(sourceBytes);
    const processor = new ModelingJobProcessor({
      repository,
      planStore,
      planner: vi.fn(async () => draft),
      cadClient,
      objectStorage: storage,
      now: () => new Date("2026-08-01T00:00:00.000Z")
    });

    await processor.process(aiJob(), new AbortController().signal);

    expect(cadClient.build).toHaveBeenCalledWith(
      expect.objectContaining({
        formats: ["glb"],
        validatePump: false,
        importedStep: expect.objectContaining({
          artifactId: SOURCE_ARTIFACT_ID,
          artifactSha256: sourceChecksum,
          bytes: sourceBytes
        })
      })
    );
    expect(planStore.storeGeneratedPlan).not.toHaveBeenCalled();
    expect(repository.completeAiPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        draft,
        dryRun: expect.objectContaining({ valid: true }),
        artifacts: [
          expect.objectContaining({
            kind: "preview",
            checksumSha256: previewChecksum,
            expiresAt: new Date("2026-08-31T00:00:00.000Z")
          })
        ]
      })
    );
    expect(storage.putPrivate).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "model/gltf-binary",
        body: previewBytes
      })
    );
    expect(cadClient.cleanupArtifacts).toHaveBeenCalledWith(EXECUTION_ID);
    expect(
      vi.mocked(storage.putPrivate).mock.invocationCallOrder.at(-1)!
    ).toBeLessThan(
      vi.mocked(cadClient.cleanupArtifacts).mock.invocationCallOrder[0]!
    );
    expect(
      vi.mocked(cadClient.cleanupArtifacts).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(repository.completeAiPlan).mock.invocationCallOrder[0]!
    );
  });

  it("validates a sketch-only AI plan without requiring a GLB preview", async () => {
    const repository = fakeRepository();
    vi.mocked(repository.loadRevision).mockResolvedValue({
      id: REVISION_ID,
      projectId: PROJECT_ID,
      contentHash: HASH,
      document: sketchOnlyDocument()
    });
    const draft = validatedDraft();
    const validation = validValidation();
    const cadClient = fakeCadClient(
      validBuild([]),
      new Uint8Array(),
      validation
    );
    const storage = fakeStorage();
    const processor = new ModelingJobProcessor({
      repository,
      planStore: fakePlanStore(draft),
      planner: vi.fn(async () => draft),
      cadClient,
      objectStorage: storage
    });

    await processor.process(aiJob(), new AbortController().signal);

    expect(cadClient.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: EXECUTION_ID,
        document: expect.objectContaining({ features: [] })
      })
    );
    expect(cadClient.build).not.toHaveBeenCalled();
    expect(cadClient.downloadArtifact).not.toHaveBeenCalled();
    expect(cadClient.cleanupArtifacts).toHaveBeenCalledWith(EXECUTION_ID);
    expect(storage.putPrivate).not.toHaveBeenCalled();
    expect(repository.completeAiPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        dryRun: expect.objectContaining({
          valid: true,
          metrics: null,
          diagnostics: []
        }),
        artifacts: []
      })
    );
  });

  it("verifies, privately uploads, and registers CAD artifacts", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const response = validBuild([
      {
        kind: "glb",
        file_name: "pump preview.glb",
        content_type: "model/gltf-binary",
        size_bytes: bytes.byteLength,
        sha256: checksum,
        download_path: `/v1/artifacts/${JOB_ID}/pump.glb`
      }
    ]);
    const repository = fakeRepository();
    const storage = fakeStorage();
    const cadClient = fakeCadClient(response, bytes);
    const processor = new ModelingJobProcessor({
      repository,
      planStore: fakePlanStore(needsInputDraft()),
      planner: vi.fn(async () => needsInputDraft()),
      cadClient,
      objectStorage: storage,
      now: () => new Date("2026-08-01T00:00:00.000Z")
    });

    await processor.process(buildJob("build"), new AbortController().signal);

    expect(storage.putPrivate).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringMatching(
          new RegExp(`^modeling/${PROJECT_ID}/${REVISION_ID}/${EXECUTION_ID}/`)
        ),
        contentType: "model/gltf-binary",
        body: bytes
      })
    );
    const artifacts = vi.mocked(repository.complete).mock.calls[0]?.[2];
    expect(artifacts).toHaveLength(1);
    expect(artifacts?.[0]).toMatchObject({
      kind: "preview",
      filename: "pump-preview.glb",
      checksumSha256: checksum,
      sizeBytes: 4,
      expiresAt: new Date("2026-08-31T00:00:00.000Z")
    });
    const output = vi.mocked(repository.complete).mock.calls[0]?.[1];
    expect(output?.engineResult).toMatchObject({
      version: "openvac.modeling.v1",
      status: "succeeded",
      jobId: JOB_ID,
      documentId: DOCUMENT_ID,
      revisionId: REVISION_ID,
      specHash: HASH,
      engine: { name: "CadQuery/OCP/OCCT", version: "2.8.0" },
      metrics: {
        bodyCount: 1,
        volumeMm3: 1_000,
        surfaceAreaMm2: 600,
        boundingBoxMm: [10, 10, 10],
        centerOfMassMm: [0, 0, 0]
      }
    });
    expect(cadClient.cleanupArtifacts).toHaveBeenCalledWith(EXECUTION_ID);
    expect(
      vi.mocked(storage.putPrivate).mock.invocationCallOrder.at(-1)!
    ).toBeLessThan(
      vi.mocked(cadClient.cleanupArtifacts).mock.invocationCallOrder[0]!
    );
    expect(
      vi.mocked(cadClient.cleanupArtifacts).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(repository.complete).mock.invocationCallOrder[0]!);
  });

  it("cleans a successful normal STEP export before completing the job", async () => {
    const bytes = new TextEncoder().encode("ISO-10303-21;EXPORT;ENDSEC;");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const cadClient = fakeCadClient(
      validBuild([
        {
          kind: "step",
          file_name: "model.step",
          content_type: "model/step",
          size_bytes: bytes.byteLength,
          sha256: checksum,
          download_path: `/v1/artifacts/${JOB_ID}/model.step`
        }
      ]),
      bytes
    );
    const repository = fakeRepository();
    const storage = fakeStorage();
    const processor = new ModelingJobProcessor({
      repository,
      planStore: fakePlanStore(needsInputDraft()),
      planner: vi.fn(async () => needsInputDraft()),
      cadClient,
      objectStorage: storage
    });

    await processor.process(buildJob("export"), new AbortController().signal);

    expect(cadClient.cleanupArtifacts).toHaveBeenCalledWith(EXECUTION_ID);
    expect(
      vi.mocked(storage.putPrivate).mock.invocationCallOrder.at(-1)!
    ).toBeLessThan(
      vi.mocked(cadClient.cleanupArtifacts).mock.invocationCallOrder[0]!
    );
    expect(
      vi.mocked(cadClient.cleanupArtifacts).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(repository.complete).mock.invocationCallOrder[0]!);
    expect(
      vi.mocked(repository.complete).mock.calls[0]?.[2]?.[0]
    ).toMatchObject({ kind: "export", checksumSha256: checksum });
  });

  it("applies positive retention env values while preserving native models", async () => {
    vi.stubEnv("MODELING_PREVIEW_RETENTION_DAYS", "2");
    vi.stubEnv("MODELING_EXPORT_RETENTION_DAYS", "3");
    const now = () => new Date("2026-08-01T00:00:00.000Z");
    const previewBytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
    const modelBytes = new TextEncoder().encode("ISO-10303-21;MODEL;ENDSEC;");
    const exportBytes = new TextEncoder().encode("ISO-10303-21;EXPORT;ENDSEC;");

    const buildRepository = fakeRepository();
    const buildCad = fakeCadClient(
      validBuild([
        buildArtifactDescriptor("step", "model.step", "model/step", modelBytes),
        artifactDescriptor(
          "glb",
          "preview.glb",
          "model/gltf-binary",
          previewBytes
        )
      ])
    );
    vi.mocked(buildCad.downloadArtifact).mockImplementation(
      async (descriptor) =>
        descriptor.kind === "step" ? modelBytes : previewBytes
    );
    const buildProcessor = new ModelingJobProcessor({
      repository: buildRepository,
      planStore: fakePlanStore(needsInputDraft()),
      planner: vi.fn(async () => needsInputDraft()),
      cadClient: buildCad,
      objectStorage: fakeStorage(),
      now
    });
    await buildProcessor.process(
      { ...buildJob("build"), input: { formats: ["step", "glb"] } },
      new AbortController().signal
    );

    const builtArtifacts = vi.mocked(buildRepository.complete).mock
      .calls[0]?.[2];
    expect(
      builtArtifacts?.map((artifact) => [artifact.kind, artifact.expiresAt])
    ).toEqual([
      ["model", null],
      ["preview", new Date("2026-08-03T00:00:00.000Z")]
    ]);

    const exportRepository = fakeRepository();
    const exportCad = fakeCadClient(
      validBuild([
        buildArtifactDescriptor("step", "model.step", "model/step", exportBytes)
      ]),
      exportBytes
    );
    const exportProcessor = new ModelingJobProcessor({
      repository: exportRepository,
      planStore: fakePlanStore(needsInputDraft()),
      planner: vi.fn(async () => needsInputDraft()),
      cadClient: exportCad,
      objectStorage: fakeStorage(),
      now
    });
    await exportProcessor.process(
      buildJob("export"),
      new AbortController().signal
    );
    expect(
      vi.mocked(exportRepository.complete).mock.calls[0]?.[2]?.[0]
    ).toMatchObject({
      kind: "export",
      expiresAt: new Date("2026-08-04T00:00:00.000Z")
    });
  });

  it("removes uploaded OSS objects when database completion fails", async () => {
    const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1]);
    const repository = fakeRepository();
    vi.mocked(repository.complete).mockRejectedValue(
      new Error("database unavailable")
    );
    const storage = fakeStorage();
    const processor = new ModelingJobProcessor({
      repository,
      planStore: fakePlanStore(needsInputDraft()),
      planner: vi.fn(async () => needsInputDraft()),
      cadClient: fakeCadClient(
        validBuild([
          artifactDescriptor("glb", "preview.glb", "model/gltf-binary", bytes)
        ]),
        bytes
      ),
      objectStorage: storage
    });

    await expect(
      processor.process(buildJob("preview"), new AbortController().signal)
    ).rejects.toThrow("database unavailable");
    const uploadedKey = vi.mocked(storage.putPrivate).mock.calls[0]?.[0].key;
    expect(storage.deletePrivate).toHaveBeenCalledWith(uploadedKey);
    expect(
      vi.mocked(repository.complete).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(storage.deletePrivate).mock.invocationCallOrder[0]!
    );
  });

  it("fences late cleanup from an old lease away from the new execution", async () => {
    const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2]);
    const oldLease = "60000000-0000-4000-8000-000000000001";
    const newLease = "60000000-0000-4000-8000-000000000002";
    const oldExecution = `${JOB_ID}_${oldLease}`;
    const newExecution = `${JOB_ID}_${newLease}`;
    let announceOldCleanup!: () => void;
    let releaseOldCleanup!: () => void;
    const oldCleanupStarted = new Promise<void>((resolve) => {
      announceOldCleanup = resolve;
    });
    const oldCleanupGate = new Promise<void>((resolve) => {
      releaseOldCleanup = resolve;
    });
    const cadClient = fakeCadClient(
      validBuild([
        artifactDescriptor("glb", "preview.glb", "model/gltf-binary", bytes)
      ]),
      bytes
    );
    vi.mocked(cadClient.cleanupArtifacts).mockImplementation(
      async (executionId) => {
        if (executionId === oldExecution) {
          announceOldCleanup();
          await oldCleanupGate;
        }
      }
    );
    const repository = fakeRepository();
    vi.mocked(repository.complete).mockImplementation(async (job) => {
      if (job.leaseToken === oldLease) {
        throw new StaleModelingLeaseError(job.id);
      }
      return { status: "succeeded", artifactIds: [] };
    });
    const storage = fakeStorage();
    const processor = new ModelingJobProcessor({
      repository,
      planStore: fakePlanStore(needsInputDraft()),
      planner: vi.fn(async () => needsInputDraft()),
      cadClient,
      objectStorage: storage
    });
    const oldJob = { ...buildJob("preview"), leaseToken: oldLease };
    const newJob = { ...buildJob("preview"), leaseToken: newLease };

    const oldRun = processor.process(oldJob, new AbortController().signal);
    await oldCleanupStarted;
    await expect(
      processor.process(newJob, new AbortController().signal)
    ).resolves.toBeUndefined();
    releaseOldCleanup();
    await expect(oldRun).rejects.toBeInstanceOf(StaleModelingLeaseError);

    expect(cadClient.build).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: oldExecution })
    );
    expect(cadClient.build).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: newExecution })
    );
    const uploadedKeys = vi
      .mocked(storage.putPrivate)
      .mock.calls.map(([upload]) => upload.key);
    const oldKey = uploadedKeys.find((key) => key.includes(oldLease));
    const newKey = uploadedKeys.find((key) => key.includes(newLease));
    expect(oldKey).toBeDefined();
    expect(newKey).toBeDefined();
    expect(storage.deletePrivate).toHaveBeenCalledWith(oldKey);
    expect(storage.deletePrivate).not.toHaveBeenCalledWith(newKey);
    expect(cadClient.cleanupArtifacts).toHaveBeenCalledWith(oldExecution);
    expect(cadClient.cleanupArtifacts).toHaveBeenCalledWith(newExecution);
  });

  it("rejects a corrupted artifact before OSS upload", async () => {
    const response = validBuild([
      {
        kind: "step",
        file_name: "pump.step",
        content_type: "model/step",
        size_bytes: 3,
        sha256: "f".repeat(64),
        download_path: `/v1/artifacts/${JOB_ID}/pump.step`
      }
    ]);
    const repository = fakeRepository();
    const storage = fakeStorage();
    const cadClient = fakeCadClient(response, new Uint8Array([1, 2, 3]));
    const processor = new ModelingJobProcessor({
      repository,
      planStore: fakePlanStore(needsInputDraft()),
      planner: vi.fn(async () => needsInputDraft()),
      cadClient,
      objectStorage: storage
    });

    await expect(
      processor.process(buildJob("export"), new AbortController().signal)
    ).rejects.toThrow("SHA-256");
    expect(storage.putPrivate).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
    expect(cadClient.cleanupArtifacts).toHaveBeenCalledWith(EXECUTION_ID);
  });

  it("fails explicitly and never completes when CAD artifact cleanup fails", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const cadClient = fakeCadClient(
      validBuild([
        {
          kind: "glb",
          file_name: "model.glb",
          content_type: "model/gltf-binary",
          size_bytes: bytes.byteLength,
          sha256: checksum,
          download_path: `/v1/artifacts/${JOB_ID}/model.glb`
        }
      ]),
      bytes
    );
    vi.mocked(cadClient.cleanupArtifacts).mockRejectedValue(
      new Error("tmpfs busy")
    );
    const repository = fakeRepository();
    const processor = new ModelingJobProcessor({
      repository,
      planStore: fakePlanStore(needsInputDraft()),
      planner: vi.fn(async () => needsInputDraft()),
      cadClient,
      objectStorage: fakeStorage()
    });

    await expect(
      processor.process(buildJob("preview"), new AbortController().signal)
    ).rejects.toMatchObject({
      code: "CAD_ARTIFACT_CLEANUP_FAILED",
      message: expect.stringContaining("连续两次清理")
    });
    expect(cadClient.cleanupArtifacts).toHaveBeenCalledTimes(2);
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("recovers from one transient cleanup failure with an idempotent retry", async () => {
    const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
    const cadClient = fakeCadClient(
      validBuild([
        artifactDescriptor("glb", "model.glb", "model/gltf-binary", bytes)
      ]),
      bytes
    );
    vi.mocked(cadClient.cleanupArtifacts)
      .mockRejectedValueOnce(new Error("temporary network error"))
      .mockResolvedValueOnce(undefined);
    const repository = fakeRepository();
    const processor = new ModelingJobProcessor({
      repository,
      planStore: fakePlanStore(needsInputDraft()),
      planner: vi.fn(async () => needsInputDraft()),
      cadClient,
      objectStorage: fakeStorage()
    });

    await expect(
      processor.process(buildJob("build"), new AbortController().signal)
    ).resolves.toBeUndefined();
    expect(cadClient.cleanupArtifacts).toHaveBeenCalledTimes(2);
    expect(repository.complete).toHaveBeenCalledOnce();
  });

  it("imports a verified private STEP as one opaque base feature", async () => {
    const sourceBytes = new TextEncoder().encode("ISO-10303-21;TEST;ENDSEC;");
    const sourceChecksum = createHash("sha256")
      .update(sourceBytes)
      .digest("hex");
    const previewBytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3]);
    const previewChecksum = createHash("sha256")
      .update(previewBytes)
      .digest("hex");
    const importResponse: CadStepImportResponse = {
      version: "openvac.modeling.v1",
      job_id: JOB_ID,
      source_sha256: sourceChecksum,
      source_size_bytes: sourceBytes.byteLength,
      kernel_version: "2.8.0",
      valid: true,
      diagnostics: [],
      metrics: {
        solid_count: 1,
        volume_mm3: 1_000,
        surface_area_mm2: 600,
        bounding_box_mm: [10, 10, 10],
        center_of_mass_mm: [0, 0, 0],
        mass_kg: null,
        mass_status: "unavailable_density_required"
      },
      body_semantic_refs: [
        `import.body.${sourceChecksum.slice(0, 12)}.0123456789ab.1`
      ],
      artifacts: [
        {
          kind: "glb",
          file_name: "model.glb",
          content_type: "model/gltf-binary",
          size_bytes: previewBytes.byteLength,
          sha256: previewChecksum,
          download_path: `/v1/artifacts/${JOB_ID}/model.glb`
        }
      ],
      duration_ms: 42
    };
    const repository = fakeRepository();
    vi.mocked(repository.loadRevision).mockResolvedValue({
      id: REVISION_ID,
      projectId: PROJECT_ID,
      contentHash: HASH,
      document: {
        ...document(),
        parameters: [
          {
            id: "abababab-abab-4bab-8bab-abababababab",
            semanticRef: "parameter.template-width",
            name: "template_width",
            label: "模板宽度",
            parameterType: "length",
            unit: "mm",
            value: 90,
            source: "template",
            editable: true
          }
        ],
        metadata: {
          template: {
            templateId: "template.rotary-vane-pump",
            templateVersion: "1.0.0"
          }
        }
      }
    });
    const storage = fakeStorage(sourceBytes);
    const cadClient: ModelingCadClientPort = {
      build: vi.fn(async () => validBuild([])),
      validate: vi.fn(async () => validValidation()),
      importStep: vi.fn(async () => importResponse),
      cleanupArtifacts: vi.fn(async () => undefined),
      downloadArtifact: vi.fn(async () => previewBytes)
    };
    const processor = new ModelingJobProcessor({
      repository,
      planStore: fakePlanStore(needsInputDraft()),
      planner: vi.fn(async () => needsInputDraft()),
      cadClient,
      objectStorage: storage,
      now: () => new Date("2026-08-01T00:00:00.000Z")
    });

    await processor.process(
      importJob(sourceBytes.byteLength, sourceChecksum),
      new AbortController().signal
    );

    expect(storage.getPrivate).toHaveBeenCalledWith(
      `modeling/user-1/${PROJECT_ID}/imports/${"e".repeat(40)}.step`
    );
    expect(cadClient.importStep).toHaveBeenCalledWith(
      expect.objectContaining({
        bytes: sourceBytes,
        contentType: "model/step",
        filename: "housing.step"
      })
    );
    const completion = vi.mocked(repository.completeImport).mock.calls[0]?.[1];
    expect(completion?.document.features).toHaveLength(1);
    expect(completion?.document.parameters).toEqual([]);
    expect(completion?.document.sketches).toEqual([]);
    expect(completion?.document.components).toEqual([]);
    expect(completion?.document.assemblyConstraints).toEqual([]);
    expect(completion?.document.metadata).toEqual({
      description: "Opaque STEP base entity imported from housing.step",
      tags: ["source.imported-step"]
    });
    expect(completion?.document.features[0]).toMatchObject({
      featureKind: "imported_step",
      artifactSha256: sourceChecksum,
      sourceName: "housing.step",
      bodySemanticRefs: importResponse.body_semantic_refs,
      suppressed: false
    });
    expect(completion?.sourceArtifact).toMatchObject({
      kind: "source",
      objectKey: `modeling/user-1/${PROJECT_ID}/imports/${"e".repeat(40)}.step`,
      checksumSha256: sourceChecksum,
      expiresAt: null
    });
    expect(completion?.previewArtifacts[0]).toMatchObject({
      kind: "preview",
      checksumSha256: previewChecksum,
      expiresAt: new Date("2026-08-31T00:00:00.000Z")
    });
    expect(completion?.operations.map((operation) => operation.kind)).toEqual([
      "delete",
      "add"
    ]);
    expect(cadClient.cleanupArtifacts).toHaveBeenCalledWith(EXECUTION_ID);
    expect(
      vi.mocked(storage.putPrivate).mock.invocationCallOrder.at(-1)!
    ).toBeLessThan(
      vi.mocked(cadClient.cleanupArtifacts).mock.invocationCallOrder[0]!
    );
    expect(
      vi.mocked(cadClient.cleanupArtifacts).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(repository.completeImport).mock.invocationCallOrder[0]!
    );
  });

  it("fails closed when the private STEP bytes do not match confirmation", async () => {
    const sourceBytes = new Uint8Array([1, 2, 3]);
    const repository = fakeRepository();
    const cadClient = fakeCadClient();
    const processor = new ModelingJobProcessor({
      repository,
      planStore: fakePlanStore(needsInputDraft()),
      planner: vi.fn(async () => needsInputDraft()),
      cadClient,
      objectStorage: fakeStorage(sourceBytes)
    });

    await expect(
      processor.process(
        importJob(sourceBytes.byteLength, "f".repeat(64)),
        new AbortController().signal
      )
    ).rejects.toThrow("SHA-256");
    expect(cadClient.importStep).not.toHaveBeenCalled();
    expect(repository.completeImport).not.toHaveBeenCalled();
  });

  it("rebuilds an imported base from its private source and resends STEP byte-for-byte", async () => {
    const sourceBytes = new TextEncoder().encode("ISO-10303-21;SOURCE;ENDSEC;");
    const sourceChecksum = createHash("sha256")
      .update(sourceBytes)
      .digest("hex");
    const stlBytes = new Uint8Array(84).fill(7);
    const glbBytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
    const bodySemanticRefs = [
      `import.body.${sourceChecksum.slice(0, 12)}.0123456789ab.1`
    ];
    const importResponse: CadStepImportResponse = {
      version: "openvac.modeling.v1",
      job_id: JOB_ID,
      source_sha256: sourceChecksum,
      source_size_bytes: sourceBytes.byteLength,
      kernel_version: "2.8.0",
      valid: true,
      diagnostics: [],
      metrics: {
        solid_count: 1,
        volume_mm3: 384,
        surface_area_mm2: 352,
        bounding_box_mm: [12, 8, 4],
        center_of_mass_mm: [0, 0, 0],
        mass_kg: null,
        mass_status: "unavailable_density_required"
      },
      body_semantic_refs: bodySemanticRefs,
      artifacts: [
        artifactDescriptor("stl", "model.stl", "model/stl", stlBytes),
        artifactDescriptor("glb", "model.glb", "model/gltf-binary", glbBytes)
      ],
      duration_ms: 31
    };
    const repository = fakeRepository();
    vi.mocked(repository.loadRevision).mockResolvedValue({
      id: REVISION_ID,
      projectId: PROJECT_ID,
      contentHash: HASH,
      document: importedDocument(sourceChecksum, bodySemanticRefs)
    });
    vi.mocked(repository.loadSourceArtifact).mockResolvedValue({
      id: SOURCE_ARTIFACT_ID,
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
      filename: "housing.step",
      mimeType: "model/step",
      objectKey: `modeling/user-1/${PROJECT_ID}/imports/${"e".repeat(40)}.step`,
      checksumSha256: sourceChecksum,
      sizeBytes: sourceBytes.byteLength
    });
    const downloadArtifact = vi.fn(async (descriptor) =>
      descriptor.kind === "stl" ? stlBytes : glbBytes
    );
    const cadClient: ModelingCadClientPort = {
      build: vi.fn(async () => validBuild([])),
      validate: vi.fn(async () => validValidation()),
      importStep: vi.fn(async () => importResponse),
      cleanupArtifacts: vi.fn(async () => undefined),
      downloadArtifact
    };
    const storage = fakeStorage(sourceBytes);
    const processor = new ModelingJobProcessor({
      repository,
      planStore: fakePlanStore(needsInputDraft()),
      planner: vi.fn(async () => needsInputDraft()),
      cadClient,
      objectStorage: storage,
      now: () => new Date("2026-08-01T00:00:00.000Z")
    });
    const job = {
      ...buildJob("export"),
      input: { formats: ["step", "stl", "glb"] }
    };

    await processor.process(job, new AbortController().signal);

    expect(cadClient.build).not.toHaveBeenCalled();
    expect(cadClient.importStep).toHaveBeenCalledWith(
      expect.objectContaining({
        bytes: sourceBytes,
        filename: "housing.step",
        contentType: "model/step",
        formats: ["stl", "glb"]
      })
    );
    expect(downloadArtifact).toHaveBeenCalledTimes(2);
    const uploads = vi
      .mocked(storage.putPrivate)
      .mock.calls.map(([upload]) => upload);
    const stepUpload = uploads.find(
      (upload) => upload.contentType === "model/step"
    );
    expect(stepUpload?.body).toBe(sourceBytes);
    expect(createHash("sha256").update(stepUpload!.body).digest("hex")).toBe(
      sourceChecksum
    );
    const artifacts = vi.mocked(repository.complete).mock.calls[0]?.[2];
    expect(artifacts).toHaveLength(3);
    expect(artifacts?.map((artifact) => artifact.kind)).toEqual([
      "export",
      "export",
      "export"
    ]);
    expect(artifacts?.map((artifact) => artifact.expiresAt)).toEqual([
      new Date("2026-08-08T00:00:00.000Z"),
      new Date("2026-08-08T00:00:00.000Z"),
      new Date("2026-08-08T00:00:00.000Z")
    ]);
    expect(cadClient.cleanupArtifacts).toHaveBeenCalledWith(EXECUTION_ID);
    expect(
      vi.mocked(storage.putPrivate).mock.invocationCallOrder.at(-1)!
    ).toBeLessThan(
      vi.mocked(cadClient.cleanupArtifacts).mock.invocationCallOrder[0]!
    );
    expect(
      vi.mocked(cadClient.cleanupArtifacts).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(repository.complete).mock.invocationCallOrder[0]!);
  });

  it("rejects multiple imported STEP bases", async () => {
    const checksum = "b".repeat(64);
    const repository = fakeRepository();
    const imported = importedDocument(checksum, [
      `import.body.${checksum.slice(0, 12)}.0123456789ab.1`
    ]);
    vi.mocked(repository.loadRevision).mockResolvedValue({
      id: REVISION_ID,
      projectId: PROJECT_ID,
      contentHash: HASH,
      document: {
        ...imported,
        features: [
          ...imported.features,
          {
            ...imported.features[0]!,
            id: "66666666-6666-4666-8666-666666666666",
            semanticRef: "feature.imported-step.unsupported-second-base"
          }
        ]
      }
    });
    const cadClient = fakeCadClient();
    const processor = new ModelingJobProcessor({
      repository,
      planStore: fakePlanStore(needsInputDraft()),
      planner: vi.fn(async () => needsInputDraft()),
      cadClient,
      objectStorage: fakeStorage()
    });

    await expect(
      processor.process(buildJob("preview"), new AbortController().signal)
    ).rejects.toThrow("只能包含一个未抑制的 STEP 基础实体");
    expect(repository.loadSourceArtifact).not.toHaveBeenCalled();
    expect(cadClient.build).not.toHaveBeenCalled();
    expect(cadClient.importStep).not.toHaveBeenCalled();
  });
});

function document(): ModelDocument {
  return {
    version: "openvac.modeling.v1",
    id: DOCUMENT_ID,
    revision: 0,
    revisionId: REVISION_ID,
    name: "测试泵",
    unitSystem: "mm-deg",
    parameters: [],
    sketches: [],
    features: [],
    components: [],
    assemblyConstraints: []
  };
}

function sketchOnlyDocument(): ModelDocument {
  return {
    ...document(),
    sketches: [
      {
        id: "12121212-1212-4212-8212-121212121212",
        semanticRef: "sketch.ai-profile",
        name: "AI profile",
        plane: "xy",
        entities: [
          {
            id: "13131313-1313-4313-8313-131313131313",
            semanticRef: "sketch.ai-profile.origin",
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

function aiJob(): LeasedModelingJob {
  return {
    ...buildJob("ai_plan"),
    input: {
      baseRevisionId: REVISION_ID,
      baseRevisionHash: HASH,
      prompt: "把转子直径改为 42 mm"
    }
  };
}

function buildJob(kind: LeasedModelingJob["kind"]): LeasedModelingJob {
  return {
    id: JOB_ID,
    projectId: PROJECT_ID,
    revisionId: REVISION_ID,
    planId: null,
    ownerId: "user-1",
    kind,
    input: kind === "export" ? { formats: ["step"] } : {},
    idempotencyKey: "job-idempotency-1",
    progress: 1,
    workerId: "worker-1",
    leaseToken: LEASE_TOKEN,
    leaseExpiresAt: new Date("2026-08-01T00:01:00.000Z"),
    cancelRequestedAt: null,
    recovered: false
  };
}

function importJob(
  sizeBytes: number,
  checksumSha256: string
): LeasedModelingJob {
  return {
    ...buildJob("import"),
    input: {
      objectKey: `modeling/user-1/${PROJECT_ID}/imports/${"e".repeat(40)}.step`,
      sourceName: "housing.step",
      sizeBytes,
      checksumSha256,
      contentType: "model/step"
    }
  };
}

function importedDocument(
  checksumSha256: string,
  bodySemanticRefs: string[]
): ModelDocument {
  return {
    ...document(),
    name: "housing",
    features: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        semanticRef: "feature.imported-step.base",
        name: "Imported STEP: housing.step",
        featureKind: "imported_step",
        artifactId: SOURCE_ARTIFACT_ID,
        artifactSha256: checksumSha256,
        sourceName: "housing.step",
        bodySemanticRefs,
        suppressed: false
      }
    ],
    metadata: {
      description: "Opaque STEP base entity imported from housing.step",
      tags: ["source.imported-step"]
    }
  };
}

function fakeRepository(): ModelingWorkerRepository {
  return {
    claimExpiredArtifact: vi.fn(async () => null),
    completeExpiredArtifactCleanup: vi.fn(async () => undefined),
    failExpiredArtifactCleanup: vi.fn(async () => undefined),
    claimNext: vi.fn(async () => null),
    renewLease: vi.fn(async () => "active" as const),
    transition: vi.fn(async () => undefined),
    loadRevision: vi.fn(async () => ({
      id: REVISION_ID,
      projectId: PROJECT_ID,
      contentHash: HASH,
      document: document()
    })),
    loadSourceArtifact: vi.fn(async () => {
      throw new Error("not used");
    }),
    loadExistingAiPlan: vi.fn(async () => null),
    completeAiPlan: vi.fn(async () => ({
      status: "succeeded" as const,
      artifactIds: [],
      planId: "66666666-6666-4666-8666-666666666666",
      replayed: false
    })),
    complete: vi.fn(async () => ({
      status: "succeeded" as const,
      artifactIds: []
    })),
    completeImport: vi.fn(async () => ({
      status: "succeeded" as const,
      artifactIds: [],
      revisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    })),
    markCancelled: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => "failed" as const)
  };
}

function fakePlanStore(draft: ModelingPlanDraft): ModelingPlanStore {
  return {
    storeGeneratedPlan: vi.fn(async () => ({
      value: {
        id: "66666666-6666-4666-8666-666666666666",
        planHash: draft.planHash,
        status: draft.status,
        missingInputs: draft.missingInputs
      } as ModelingPlanRow,
      replayed: false
    }))
  };
}

function fakeCadClient(
  response: CadBuildResponse = validBuild([]),
  bytes = new Uint8Array(),
  validationResponse: CadBuildResponse = response
): ModelingCadClientPort {
  return {
    build: vi.fn(async () => response),
    validate: vi.fn(async () => validationResponse),
    importStep: vi.fn(async () => {
      throw new Error("not used");
    }),
    cleanupArtifacts: vi.fn(async () => undefined),
    downloadArtifact: vi.fn(async () => bytes)
  };
}

function fakeStorage(
  privateBytes = new Uint8Array()
): ModelingObjectStoragePort {
  return {
    deletePrivate: vi.fn(async () => undefined),
    getPrivate: vi.fn(async () => privateBytes),
    putPrivate: vi.fn(async ({ key }) => ({ key }))
  };
}

function needsInputDraft(): ModelingPlanDraft {
  return {
    version: "openvac.modeling.v1",
    id: "77777777-7777-4777-8777-777777777777",
    documentId: DOCUMENT_ID,
    baseRevisionId: REVISION_ID,
    title: "需要尺寸",
    summary: "等待用户提供制造尺寸。",
    status: "needs_input",
    assumptions: [],
    warnings: [],
    missingInputs: ["请输入转子直径（mm）。"],
    expectedChecks: [],
    planHash: "b".repeat(64)
  };
}

function validatedDraft(): ModelingPlanDraft {
  return {
    version: "openvac.modeling.v1",
    id: "77777777-7777-4777-8777-777777777777",
    documentId: DOCUMENT_ID,
    baseRevisionId: REVISION_ID,
    title: "增加转子直径参数",
    summary: "增加用户指定的参数。",
    status: "validated",
    assumptions: [],
    warnings: [],
    missingInputs: [],
    expectedChecks: ["闭合实体"],
    planHash: "c".repeat(64),
    operationBatch: {
      version: "openvac.modeling.v1",
      id: "88888888-8888-4888-8888-888888888888",
      documentId: DOCUMENT_ID,
      baseRevisionId: REVISION_ID,
      idempotencyKey: "plan-operation-1",
      operations: [
        {
          operationId: "99999999-9999-4999-8999-999999999999",
          kind: "add",
          collection: "parameters",
          item: {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            semanticRef: "parameter.rotor-diameter",
            name: "rotor_diameter",
            label: "转子直径",
            parameterType: "length",
            unit: "mm",
            value: 42,
            source: "user",
            editable: true
          }
        }
      ]
    }
  };
}

function validBuild(
  artifacts: CadBuildResponse["artifacts"]
): CadBuildResponse {
  return {
    version: "openvac.modeling.v1",
    job_id: JOB_ID,
    model_hash: "d".repeat(64),
    kernel_version: "2.8.0",
    solver_version: "slvs-3.2",
    valid: true,
    diagnostics: [],
    metrics: {
      solid_count: 1,
      volume_mm3: 1_000,
      surface_area_mm2: 600,
      bounding_box_mm: [10, 10, 10],
      center_of_mass_mm: [0, 0, 0],
      mass_kg: null,
      mass_status: "unavailable_density_required"
    },
    artifacts,
    duration_ms: 20
  };
}

function validValidation(): CadBuildResponse {
  return {
    ...validBuild([]),
    metrics: null
  };
}

function artifactDescriptor(
  kind: "stl" | "glb",
  fileName: string,
  contentType: string,
  bytes: Uint8Array
): CadStepImportResponse["artifacts"][number] {
  return {
    kind,
    file_name: fileName,
    content_type: contentType,
    size_bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    download_path: `/v1/artifacts/${JOB_ID}/${fileName}`
  };
}

function buildArtifactDescriptor(
  kind: "step" | "stl" | "glb",
  fileName: string,
  contentType: string,
  bytes: Uint8Array
): CadBuildResponse["artifacts"][number] {
  return {
    kind,
    file_name: fileName,
    content_type: contentType,
    size_bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    download_path: `/v1/artifacts/${JOB_ID}/${fileName}`
  };
}
