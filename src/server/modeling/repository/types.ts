import type {
  modelingArtifact,
  modelingImportIntent,
  modelingJob,
  modelingJobEvent,
  modelingPlan,
  modelingProject,
  modelingRevision,
  modelingValidationAttempt
} from "@/server/db/schema";
import type {
  ModelDocument,
  ModelingPlanDraft,
  ModelOperationBatch
} from "@/types/modeling";

type ModelOperation = ModelOperationBatch["operations"][number];

export type ModelingProjectRow = typeof modelingProject.$inferSelect;
export type ModelingRevisionRow = typeof modelingRevision.$inferSelect;
export type ModelingPlanRow = typeof modelingPlan.$inferSelect;
export type ModelingJobRow = typeof modelingJob.$inferSelect;
export type ModelingJobEventRow = typeof modelingJobEvent.$inferSelect;
export type ModelingArtifactRow = typeof modelingArtifact.$inferSelect;
export type ModelingImportIntentRow = typeof modelingImportIntent.$inferSelect;
export type ModelingValidationAttemptRow =
  typeof modelingValidationAttempt.$inferSelect;

export type ProjectDetail = ModelingProjectRow & {
  currentRevision: ModelingRevisionRow | null;
};

export type PageResult<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

export type ReplayResult<T> = {
  value: T;
  replayed: boolean;
};

export type CreateProjectInput = {
  ownerId: string;
  name: string;
  description?: string | null;
  document: ModelDocument;
  idempotencyKey: string;
};

export type UpdateProjectInput = {
  name?: string;
  description?: string | null;
};

export type CommitOperationInput = {
  ownerId: string;
  projectId: string;
  baseRevisionId: string;
  idempotencyKey: string;
  operations: ModelOperation[];
  document: ModelDocument;
  contentHash: string;
};

export type ValidationAttemptKind = "project_create" | "operation_batch";

export type BeginValidationAttemptInput = {
  ownerId: string;
  projectId?: string | null;
  kind: ValidationAttemptKind;
  idempotencyKey: string;
  requestHash: string;
};

export type BeginValidationAttemptResult =
  | {
      state: "reserved";
      attemptId: string;
      leaseToken: string;
      reservedComputeMs: number;
    }
  | {
      state: "succeeded";
      attemptId: string;
      kernelVersion: string | null;
    }
  | {
      state: "failed";
      attemptId: string;
      failure: {
        status: number;
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
    };

export type CompleteValidationAttemptInput = {
  ownerId: string;
  attemptId: string;
  leaseToken: string;
  actualDurationMs: number;
  outcome:
    | {
        status: "succeeded";
        kernelVersion: string;
      }
    | {
        status: "failed";
        kernelVersion?: string | null;
        errorStatus: number;
        errorCode: string;
        errorMessage: string;
        errorDetails?: Record<string, unknown>;
      };
};

export type CreateAiPlanJobInput = {
  ownerId: string;
  projectId: string;
  baseRevisionId: string;
  prompt: string;
  selectedSemanticRefs?: string[];
  idempotencyKey: string;
};

export type CreateModelingJobInput = {
  ownerId: string;
  projectId: string;
  revisionId: string;
  kind: Exclude<ModelingJobRow["kind"], "ai_plan">;
  idempotencyKey: string;
  input?: Record<string, unknown>;
};

export type ReserveStepUploadIntentInput = {
  ownerId: string;
  projectId: string;
  idempotencyKey: string;
  requestHash: string;
  objectKey: string;
  sourceName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  expiresAt: Date;
};

export type CompleteStepUploadIntentInput = {
  ownerId: string;
  projectId: string;
  revisionId: string;
  completionIdempotencyKey: string;
  objectKey: string;
  sourceName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
};

export type StoreGeneratedPlanInput = {
  ownerId: string;
  projectId: string;
  baseRevisionId: string;
  baseRevisionHash: string;
  prompt: string;
  draft: ModelingPlanDraft;
  idempotencyKey: string;
};

export type ConfirmPlanInput = {
  ownerId: string;
  planId: string;
  expectedBaseRevisionId: string;
  expectedPlanHash: string;
  idempotencyKey: string;
  document: ModelDocument;
  contentHash: string;
};

export type CancelJobResult = {
  job: ModelingJobRow;
  replayed: boolean;
  cancellationRequested: boolean;
};

export type DeleteProjectResult = "deleted" | "not_found" | "artifacts_changed";

export interface ModelingRepository {
  beginValidationAttempt(
    input: BeginValidationAttemptInput
  ): Promise<BeginValidationAttemptResult | null>;
  completeValidationAttempt(
    input: CompleteValidationAttemptInput
  ): Promise<void>;
  listProjects(
    ownerId: string,
    page: number,
    pageSize: number
  ): Promise<PageResult<ProjectDetail>>;
  getProject(ownerId: string, projectId: string): Promise<ProjectDetail | null>;
  createProject(
    input: CreateProjectInput
  ): Promise<ReplayResult<ProjectDetail>>;
  updateProject(
    ownerId: string,
    projectId: string,
    input: UpdateProjectInput
  ): Promise<ProjectDetail | null>;
  listProjectArtifactKeys(
    ownerId: string,
    projectId: string
  ): Promise<string[] | null>;
  deleteProject(
    ownerId: string,
    projectId: string,
    deletedObjectKeys: string[]
  ): Promise<DeleteProjectResult>;
  listRevisions(
    ownerId: string,
    projectId: string,
    page: number,
    pageSize: number
  ): Promise<PageResult<ModelingRevisionRow> | null>;
  getRevision(
    ownerId: string,
    projectId: string,
    revisionId: string
  ): Promise<ModelingRevisionRow | null>;
  commitOperationBatch(
    input: CommitOperationInput
  ): Promise<ReplayResult<ModelingRevisionRow> | null>;
  createAiPlanJob(
    input: CreateAiPlanJobInput
  ): Promise<ReplayResult<ModelingJobRow> | null>;
  createJob(
    input: CreateModelingJobInput
  ): Promise<ReplayResult<ModelingJobRow> | null>;
  reserveStepUploadIntent(
    input: ReserveStepUploadIntentInput
  ): Promise<ReplayResult<ModelingImportIntentRow> | null>;
  getStepUploadIntent(
    ownerId: string,
    projectId: string,
    objectKey: string
  ): Promise<ModelingImportIntentRow | null>;
  completeStepUploadIntent(
    input: CompleteStepUploadIntentInput
  ): Promise<ReplayResult<ModelingJobRow> | null>;
  storeGeneratedPlan(
    input: StoreGeneratedPlanInput
  ): Promise<ReplayResult<ModelingPlanRow> | null>;
  listPlans(
    ownerId: string,
    projectId: string,
    page: number,
    pageSize: number
  ): Promise<PageResult<ModelingPlanRow> | null>;
  getPlan(ownerId: string, planId: string): Promise<ModelingPlanRow | null>;
  confirmPlan(
    input: ConfirmPlanInput
  ): Promise<ReplayResult<ModelingRevisionRow> | null>;
  rejectPlan(
    ownerId: string,
    planId: string
  ): Promise<ReplayResult<ModelingPlanRow> | null>;
  getJob(ownerId: string, jobId: string): Promise<ModelingJobRow | null>;
  cancelJob(ownerId: string, jobId: string): Promise<CancelJobResult | null>;
  listJobEvents(
    ownerId: string,
    jobId: string,
    afterSequence: number,
    limit: number
  ): Promise<ModelingJobEventRow[] | null>;
  getArtifact(
    ownerId: string,
    artifactId: string
  ): Promise<ModelingArtifactRow | null>;
}
