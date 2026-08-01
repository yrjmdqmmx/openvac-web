import type {
  CadArtifactDescriptor,
  CadBuildRequest,
  CadBuildResponse,
  CadStepImportRequest,
  CadStepImportResponse,
  CadValidationRequest
} from "@/server/modeling/cad-client";
import type {
  StoreGeneratedPlanInput,
  ModelingPlanRow,
  ReplayResult
} from "@/server/modeling/repository";
import type { ObjectStorage } from "@/server/providers/types";
import type {
  ModelDocument,
  ModelingPlanDraft,
  ModelOperation
} from "@/types/modeling";

export type ModelingJobKind =
  "ai_plan" | "import" | "build" | "preview" | "conversion" | "export";

export type ActiveModelingJobStatus =
  "running" | "validating" | "meshing" | "exporting";

export interface LeasedModelingJob {
  id: string;
  projectId: string;
  revisionId: string | null;
  planId: string | null;
  ownerId: string;
  kind: ModelingJobKind;
  input: Record<string, unknown>;
  idempotencyKey: string;
  progress: number;
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: Date;
  cancelRequestedAt: Date | null;
  recovered: boolean;
}

export interface ModelingRevisionSnapshot {
  id: string;
  projectId: string;
  contentHash: string;
  document: ModelDocument;
}

export interface ModelingSourceArtifact {
  id: string;
  projectId: string;
  revisionId: string | null;
  filename: string;
  mimeType: string;
  objectKey: string;
  checksumSha256: string;
  sizeBytes: number;
}

export type ModelingArtifactKind =
  "source" | "model" | "preview" | "export" | "log";

export interface PendingModelingArtifact {
  id: string;
  kind: ModelingArtifactKind;
  filename: string;
  mimeType: string;
  objectKey: string;
  checksumSha256: string;
  sizeBytes: number;
  expiresAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface LeasedArtifactCleanup {
  id: string;
  projectId: string;
  kind: "preview" | "export";
  objectKey: string;
  leaseToken: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
  attempts: number;
}

export interface CompleteJobResult {
  status: "succeeded" | "cancelled";
  artifactIds: string[];
}

export interface CompleteImportInput {
  document: ModelDocument;
  contentHash: string;
  operations: ModelOperation[];
  output: Record<string, unknown>;
  sourceArtifact: PendingModelingArtifact;
  previewArtifacts: PendingModelingArtifact[];
}

export interface CompleteImportResult extends CompleteJobResult {
  revisionId?: string;
}

export interface StoredAiPlanSnapshot {
  id: string;
  projectId: string;
  baseRevisionId: string;
  baseRevisionHash: string;
  planHash: string;
  prompt: string;
  draft: ModelingPlanDraft;
  status: ModelingPlanRow["status"];
  missingInputs: string[];
}

export interface CompleteAiPlanInput {
  baseRevisionHash: string;
  prompt: string;
  draft: ModelingPlanDraft;
  dryRun: Record<string, unknown> | null;
  artifacts: PendingModelingArtifact[];
}

export interface CompleteAiPlanResult extends CompleteJobResult {
  planId?: string;
  replayed?: boolean;
}

export type LeaseRenewal = "active" | "cancel_requested";

export interface ModelingWorkerRepository {
  claimExpiredArtifact(
    workerId: string,
    leaseMs: number
  ): Promise<LeasedArtifactCleanup | null>;
  completeExpiredArtifactCleanup(
    artifact: LeasedArtifactCleanup
  ): Promise<void>;
  failExpiredArtifactCleanup(
    artifact: LeasedArtifactCleanup,
    error: Error,
    retryDelayMs: number
  ): Promise<void>;
  claimNext(
    workerId: string,
    leaseMs: number
  ): Promise<LeasedModelingJob | null>;
  renewLease(job: LeasedModelingJob, leaseMs: number): Promise<LeaseRenewal>;
  transition(
    job: LeasedModelingJob,
    status: ActiveModelingJobStatus,
    progress: number,
    eventType: string,
    eventData?: Record<string, unknown>
  ): Promise<void>;
  loadRevision(job: LeasedModelingJob): Promise<ModelingRevisionSnapshot>;
  loadSourceArtifact(
    job: LeasedModelingJob,
    artifactId: string
  ): Promise<ModelingSourceArtifact>;
  loadExistingAiPlan(
    job: LeasedModelingJob
  ): Promise<StoredAiPlanSnapshot | null>;
  completeAiPlan(
    job: LeasedModelingJob,
    input: CompleteAiPlanInput
  ): Promise<CompleteAiPlanResult>;
  complete(
    job: LeasedModelingJob,
    output: Record<string, unknown>,
    artifacts?: PendingModelingArtifact[]
  ): Promise<CompleteJobResult>;
  completeImport(
    job: LeasedModelingJob,
    input: CompleteImportInput
  ): Promise<CompleteImportResult>;
  markCancelled(job: LeasedModelingJob, reason: string): Promise<void>;
  markFailed(
    job: LeasedModelingJob,
    error: Error
  ): Promise<"failed" | "cancelled">;
}

export interface ModelingPlanStore {
  storeGeneratedPlan(
    input: StoreGeneratedPlanInput
  ): Promise<ReplayResult<ModelingPlanRow> | null>;
}

export interface ModelingPlannerPort {
  (input: {
    document: ModelDocument;
    baseRevisionId: string;
    prompt: string;
    idempotencyKey: string;
    selectedSemanticRefs?: string[];
    signal?: AbortSignal;
  }): Promise<ModelingPlanDraft>;
}

export interface ModelingCadClientPort {
  build(request: CadBuildRequest): Promise<CadBuildResponse>;
  validate(request: CadValidationRequest): Promise<CadBuildResponse>;
  importStep(request: CadStepImportRequest): Promise<CadStepImportResponse>;
  cleanupArtifacts(jobId: string, signal?: AbortSignal): Promise<void>;
  downloadArtifact(
    artifact: CadArtifactDescriptor,
    signal?: AbortSignal
  ): Promise<Uint8Array>;
}

export type ModelingObjectStoragePort = Pick<
  ObjectStorage,
  "deletePrivate" | "getPrivate" | "putPrivate"
>;

export type ModelingWorkerOutcome =
  "idle" | "completed" | "failed" | "cancelled" | "interrupted";
