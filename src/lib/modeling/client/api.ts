import type { AiPlanOperation } from "@/lib/modeling/client/workspace-state";
import type { ModelDocument, ModelOperationBatch } from "@/types/modeling";

type ApiEnvelope<T> = { data: T };

type ApiErrorEnvelope = {
  error?: { code?: string; message?: string; details?: unknown };
};

export class ModelingClientError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, status = 0, code?: string, details?: unknown) {
    super(message);
    this.name = "ModelingClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type ModelingRevisionSummary = {
  id: string;
  parentRevisionId?: string | null;
  revisionNumber?: number;
  source?: "initial" | "manual" | "ai_plan" | "import";
  document?: ModelDocument;
  contentHash?: string;
  createdAt?: string;
};

export type ModelingProjectSummary = {
  id: string;
  name: string;
  description?: string | null;
  currentRevision?: ModelingRevisionSummary | null;
};

export type AiPlanClientResult =
  | {
      status: "needs_input";
      planId?: string;
      question: string;
    }
  | {
      status: "preview";
      planId: string;
      planHash?: string;
      previewArtifactId?: string;
      operations: AiPlanOperation[];
      summary?: string;
      assumptions: string[];
      warnings: string[];
      expectedChecks: string[];
      diagnostics: Array<{ code: string; severity: string; message: string }>;
      metrics?: Record<string, number>;
    }
  | { status: "pending"; jobId?: string };

export type ModelingJobSummary = {
  id: string;
  kind?: string;
  status: string;
  progress?: number;
  planId?: string | null;
  errorMessage?: string | null;
  output?: {
    revisionId?: string;
    artifactIds?: string[];
    diagnostics?: ModelingKernelDiagnostic[];
    dryRun?: {
      diagnostics?: Array<{ code: string; severity: string; message: string }>;
      metrics?: Record<string, number>;
      valid?: boolean;
      modelHash?: string;
      kernelVersion?: string;
    } | null;
  };
};

export type ModelingKernelDiagnostic = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  target_id?: string | null;
  targetId?: string | null;
};

export type ModelingRevisionPage = {
  items: ModelingRevisionSummary[];
  page: number;
  pageSize: number;
  total: number;
};

export type StepImportProgress =
  "hashing" | "presigning" | "uploading" | "verifying";

export type StepImportResult = {
  job: ModelingJobSummary;
};

type PrivateStepUpload = {
  key: string;
  method: "PUT";
  url: string;
  requiredHeaders: Record<string, string>;
  expiresAt: string;
};

type Fetcher = typeof fetch;

async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  fetcher: Fetcher
): Promise<{ data: T; status: number }> {
  let response: Response;
  try {
    response = await fetcher(input, init);
  } catch {
    throw new ModelingClientError(
      "无法连接建模服务，当前修改保留为离线草稿。",
      0
    );
  }

  const payload = (await response.json().catch(() => null)) as
    ApiEnvelope<T> | ApiErrorEnvelope | null;
  if (!response.ok) {
    const error = payload && "error" in payload ? payload.error : undefined;
    throw new ModelingClientError(
      error?.message ?? "建模服务暂时不可用，当前修改保留为离线草稿。",
      response.status,
      error?.code,
      error?.details
    );
  }
  if (!payload || !("data" in payload)) {
    throw new ModelingClientError(
      "建模服务返回了无法识别的数据。",
      response.status
    );
  }
  return { data: payload.data, status: response.status };
}

export async function listModelingProjects(fetcher: Fetcher = fetch) {
  const { data } = await requestJson<
    ModelingProjectSummary[] | { items?: ModelingProjectSummary[] }
  >("/api/modeling/projects", { cache: "no-store" }, fetcher);
  return Array.isArray(data) ? data : (data.items ?? []);
}

export async function getModelingProject(
  projectId: string,
  fetcher: Fetcher = fetch
) {
  const { data } = await requestJson<ModelingProjectSummary>(
    `/api/modeling/projects/${encodeURIComponent(projectId)}`,
    { cache: "no-store" },
    fetcher
  );
  return data;
}

export async function listModelingRevisions(
  projectId: string,
  input: { page?: number; pageSize?: number } = {},
  fetcher: Fetcher = fetch
) {
  const parameters = new URLSearchParams({
    page: String(input.page ?? 1),
    pageSize: String(input.pageSize ?? 20)
  });
  const { data } = await requestJson<ModelingRevisionPage>(
    `/api/modeling/projects/${encodeURIComponent(projectId)}/revisions?${parameters.toString()}`,
    { cache: "no-store" },
    fetcher
  );
  return data;
}

export async function createModelingProject(
  input: { name: string; document: ModelDocument; idempotencyKey: string },
  fetcher: Fetcher = fetch
) {
  const { data } = await requestJson<
    ModelingProjectSummary | { project: ModelingProjectSummary }
  >(
    "/api/modeling/projects",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    },
    fetcher
  );
  return "project" in data ? data.project : data;
}

export async function postOperationBatch(
  projectId: string,
  input: ModelOperationBatch,
  fetcher: Fetcher = fetch
) {
  const { data } = await requestJson<
    ModelingRevisionSummary | { revision: ModelingRevisionSummary }
  >(
    `/api/modeling/projects/${encodeURIComponent(projectId)}/operation-batches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    },
    fetcher
  );
  return "revision" in data ? data.revision : data;
}

export async function createAiPlan(
  projectId: string,
  input: {
    baseRevisionId: string;
    prompt: string;
    idempotencyKey: string;
    selectedSemanticRefs?: string[];
  },
  fetcher: Fetcher = fetch
): Promise<AiPlanClientResult> {
  const { data } = await requestJson<unknown>(
    `/api/modeling/projects/${encodeURIComponent(projectId)}/ai-plans`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    },
    fetcher
  );
  return normalizeAiPlan(data);
}

export async function createModelingJob(
  projectId: string,
  input: {
    revisionId: string;
    kind: "build" | "preview" | "export";
    formats?: Array<"step" | "stl" | "glb">;
    validatePump?: boolean;
    idempotencyKey: string;
  },
  fetcher: Fetcher = fetch
): Promise<ModelingJobSummary> {
  const { data } = await requestJson<
    ModelingJobSummary | { job: ModelingJobSummary }
  >(
    `/api/modeling/projects/${encodeURIComponent(projectId)}/jobs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    },
    fetcher
  );
  return "job" in data ? data.job : data;
}

export async function cancelModelingJob(
  jobId: string,
  fetcher: Fetcher = fetch
) {
  const { data } = await requestJson<{
    job: ModelingJobSummary;
    cancellationRequested: boolean;
  }>(
    `/api/modeling/jobs/${encodeURIComponent(jobId)}/cancel`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: clientId(`cancel-${jobId}`) })
    },
    fetcher
  );
  return data;
}

export async function importPrivateStep(
  projectId: string,
  file: File,
  options: {
    fetcher?: Fetcher;
    onProgress?: (progress: StepImportProgress) => void;
  } = {}
): Promise<StepImportResult> {
  const fetcher = options.fetcher ?? fetch;
  validateStepFile(file);
  options.onProgress?.("hashing");
  const checksumSha256 = await fileSha256(file);
  const mimeType = stepMimeType(file.type);

  options.onProgress?.("presigning");
  const { data: presigned } = await requestJson<{
    upload: PrivateStepUpload;
    constraints: { format: "STEP"; maxBytes: number };
  }>(
    `/api/modeling/projects/${encodeURIComponent(projectId)}/imports/presign`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        mimeType,
        sizeBytes: file.size,
        checksumSha256,
        idempotencyKey: clientId("step-presign")
      })
    },
    fetcher
  );
  if (
    presigned.upload.method !== "PUT" ||
    !presigned.upload.key ||
    !presigned.upload.url ||
    presigned.constraints.format !== "STEP" ||
    file.size > presigned.constraints.maxBytes
  ) {
    throw new ModelingClientError(
      "对象存储返回了无法识别的私有上传签名。",
      502
    );
  }

  options.onProgress?.("uploading");
  let uploadResponse: Response;
  try {
    uploadResponse = await fetcher(presigned.upload.url, {
      method: "PUT",
      headers: browserUploadHeaders(presigned.upload.requiredHeaders),
      body: file
    });
  } catch {
    throw new ModelingClientError(
      "无法连接私有对象存储，尚未创建导入版本。",
      0,
      "PRIVATE_UPLOAD_UNREACHABLE"
    );
  }
  if (!uploadResponse.ok) {
    throw new ModelingClientError(
      `STEP 私有上传失败（HTTP ${uploadResponse.status}），尚未创建导入版本。`,
      uploadResponse.status
    );
  }

  options.onProgress?.("verifying");
  const { data: completed } = await requestJson<{
    job: ModelingJobSummary;
  }>(
    `/api/modeling/projects/${encodeURIComponent(projectId)}/imports/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objectKey: presigned.upload.key,
        sizeBytes: file.size,
        checksumSha256,
        idempotencyKey: clientId("step-complete")
      })
    },
    fetcher
  );
  return { job: completed.job };
}

export async function fileSha256(file: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new ModelingClientError(
      "当前浏览器不支持导入所需的 SHA-256 校验，请升级浏览器后重试。",
      0,
      "BROWSER_CRYPTO_UNAVAILABLE"
    );
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer()
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function validateStepFile(file: File) {
  if (!/\.(?:step|stp)$/iu.test(file.name)) {
    throw new ModelingClientError("首版仅支持 .step 或 .stp 文件。", 422);
  }
  if (file.size < 1 || file.size > 50 * 1024 * 1024) {
    throw new ModelingClientError("STEP 文件必须大于 0 且不超过 50 MB。", 422);
  }
}

function stepMimeType(value: string) {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  return normalized === "model/step" || normalized === "application/step"
    ? normalized
    : "application/octet-stream";
}

function browserUploadHeaders(required: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(required).filter(
      ([name]) => name.toLowerCase() !== "content-length"
    )
  );
}

export function modelingArtifactDownloadUrl(artifactId: string) {
  return `/api/modeling/artifacts/${encodeURIComponent(artifactId)}/download`;
}

export async function confirmAiPlan(
  planId: string,
  input: { baseRevisionId: string; planHash: string },
  fetcher: Fetcher = fetch
) {
  const { data } = await requestJson<unknown>(
    `/api/modeling/ai-plans/${encodeURIComponent(planId)}/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        idempotencyKey: clientId("confirm")
      })
    },
    fetcher
  );
  return data;
}

export async function rejectAiPlan(planId: string, fetcher: Fetcher = fetch) {
  const { data } = await requestJson<unknown>(
    `/api/modeling/ai-plans/${encodeURIComponent(planId)}/reject`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: clientId("reject") })
    },
    fetcher
  );
  return data;
}

export async function getModelingJob(
  jobId: string,
  fetcher: Fetcher = fetch
): Promise<ModelingJobSummary> {
  const { data } = await requestJson<ModelingJobSummary>(
    `/api/modeling/jobs/${encodeURIComponent(jobId)}`,
    { cache: "no-store" },
    fetcher
  );
  return data;
}

export async function getAiPlan(
  planId: string,
  fetcher: Fetcher = fetch
): Promise<AiPlanClientResult> {
  const { data } = await requestJson<unknown>(
    `/api/modeling/ai-plans/${encodeURIComponent(planId)}`,
    { cache: "no-store" },
    fetcher
  );
  return normalizeAiPlan(data);
}

export function clientId(prefix: string) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `${prefix}-${uuid}`
    : `${prefix}-${Date.now()}-${Math.random()}`;
}

export function normalizeAiPlan(value: unknown): AiPlanClientResult {
  if (!value || typeof value !== "object") return { status: "pending" };
  const root = value as Record<string, unknown>;
  const planRow =
    root.plan && typeof root.plan === "object"
      ? (root.plan as Record<string, unknown>)
      : root;
  const plan =
    planRow.draft && typeof planRow.draft === "object"
      ? (planRow.draft as Record<string, unknown>)
      : planRow;
  const rawStatus = String(
    plan.status ?? root.status ?? "pending"
  ).toLowerCase();
  const planId = asString(planRow.id ?? plan.id ?? root.planId);

  if (
    rawStatus === "needs_input" ||
    rawStatus === "needs-input" ||
    rawStatus === "awaiting_input"
  ) {
    const missingInputText = Array.isArray(plan.missingInputs)
      ? plan.missingInputs
          .filter((item): item is string => typeof item === "string")
          .join("；")
      : undefined;
    return {
      status: "needs_input",
      planId,
      question:
        asString(plan.question ?? plan.missingInput ?? root.question) ??
        asString(missingInputText) ??
        "请补充需要修改的尺寸或约束。"
    };
  }

  const operationBatch =
    plan.operationBatch && typeof plan.operationBatch === "object"
      ? (plan.operationBatch as Record<string, unknown>)
      : undefined;
  const operationsValue = operationBatch?.operations ?? plan.operations;
  if (
    (rawStatus === "validated" ||
      rawStatus === "preview" ||
      rawStatus === "ready" ||
      rawStatus === "proposed") &&
    planId
  ) {
    return {
      status: "preview",
      planId,
      planHash: asString(planRow.planHash ?? plan.planHash),
      previewArtifactId: previewArtifactId(root, planRow, plan),
      summary: asString(plan.summary),
      assumptions: stringArray(plan.assumptions),
      warnings: stringArray(plan.warnings),
      expectedChecks: stringArray(plan.expectedChecks),
      diagnostics: dryRunDiagnostics(root, planRow, plan),
      metrics: dryRunMetrics(root, planRow, plan),
      operations: Array.isArray(operationsValue)
        ? operationsValue.map((operation, index) =>
            normalizePlanOperation(operation, index)
          )
        : []
    };
  }

  return {
    status: "pending",
    jobId: asString(
      root.job && typeof root.job === "object"
        ? (root.job as Record<string, unknown>).id
        : root.jobId
    )
  };
}

function previewArtifactId(
  ...values: Array<Record<string, unknown>>
): string | undefined {
  for (const value of values) {
    const direct = asString(value.previewArtifactId ?? value.artifactId);
    if (direct) return direct;
    const job =
      value.job && typeof value.job === "object"
        ? (value.job as Record<string, unknown>)
        : undefined;
    const output =
      (job?.output && typeof job.output === "object"
        ? (job.output as Record<string, unknown>)
        : undefined) ??
      (value.output && typeof value.output === "object"
        ? (value.output as Record<string, unknown>)
        : undefined);
    const artifactIds = output?.artifactIds;
    if (Array.isArray(artifactIds)) {
      const artifactId = artifactIds.find(
        (candidate): candidate is string =>
          typeof candidate === "string" && Boolean(candidate.trim())
      );
      if (artifactId) return artifactId;
    }
  }
}

function normalizePlanOperation(
  value: unknown,
  index: number
): AiPlanOperation {
  const operation =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const kind = asString(operation.kind);
  const collection = asString(operation.collection);
  const target =
    operation.target && typeof operation.target === "object"
      ? (operation.target as Record<string, unknown>)
      : undefined;
  const item =
    operation.item && typeof operation.item === "object"
      ? { ...(operation.item as Record<string, unknown>) }
      : undefined;
  const changes =
    operation.changes && typeof operation.changes === "object"
      ? { ...(operation.changes as Record<string, unknown>) }
      : undefined;
  const normalizedTarget = normalizePlanReference(target);
  const orderedRefs = Array.isArray(operation.orderedRefs)
    ? operation.orderedRefs.flatMap((reference) => {
        const normalized = normalizePlanReference(reference);
        return normalized ? [normalized] : [];
      })
    : undefined;
  const semanticTarget = asString(
    target?.semanticRef ?? item?.semanticRef ?? operation.semanticRef
  );
  return decoratePlanOperation({
    id:
      asString(operation.operationId ?? operation.id) ??
      `plan-operation-${index}`,
    kind,
    collection,
    target: normalizedTarget,
    item,
    changes,
    orderedRefs,
    suppressed:
      typeof operation.suppressed === "boolean"
        ? operation.suppressed
        : undefined,
    label:
      asString(operation.label ?? operation.type) ?? `建模操作 ${index + 1}`,
    summary:
      asString(operation.summary ?? operation.description) ??
      (semanticTarget ? `语义目标：${semanticTarget}` : "等待确认后执行"),
    diffs: []
  });
}

export function withAiPlanOperationDiffs(
  operations: AiPlanOperation[],
  document: ModelDocument
): AiPlanOperation[] {
  return operations.map((operation) => {
    const items = modelCollectionItems(document, operation.collection);
    const baseItem = findOperationTarget(items, operation.target);
    return decoratePlanOperation(operation, baseItem, items);
  });
}

const OPERATION_KIND_LABELS: Record<string, string> = {
  add: "新增",
  update: "修改",
  delete: "删除",
  reorder: "重排",
  suppress: "抑制状态"
};

const COLLECTION_LABELS: Record<string, string> = {
  parameters: "参数",
  sketches: "草图",
  features: "特征",
  components: "组件",
  assemblyConstraints: "装配约束"
};

const FIELD_LABELS: Record<string, string> = {
  name: "名称",
  label: "显示名称",
  value: "数值",
  unit: "单位",
  minimum: "最小值",
  maximum: "最大值",
  source: "数值来源",
  editable: "可编辑",
  suppressed: "抑制状态",
  entities: "草图实体",
  constraints: "草图约束",
  solveStatus: "求解状态",
  plane: "草图平面",
  featureKind: "特征类型",
  profileRefs: "轮廓引用",
  sourceFeatureRef: "源特征",
  sourceFeatureRefs: "源特征",
  targetFeatureRef: "目标特征",
  toolFeatureRefs: "工具特征",
  operation: "几何运算",
  direction: "方向",
  transform: "位置与旋转",
  featureRefs: "特征引用",
  componentRefs: "组件引用",
  constraintKind: "约束类型",
  status: "状态",
  orderedRefs: "顺序"
};

const FEATURE_KIND_LABELS: Record<string, string> = {
  extrude: "拉伸",
  revolve: "旋转",
  boolean: "布尔",
  circular_pattern: "圆周阵列",
  linear_pattern: "线性阵列",
  port: "接口",
  hole: "孔",
  fillet: "圆角",
  chamfer: "倒角",
  mirror: "镜像",
  imported_step: "STEP 基础实体"
};

function decoratePlanOperation(
  operation: AiPlanOperation,
  baseItem?: Record<string, unknown>,
  collectionItems: Record<string, unknown>[] = []
): AiPlanOperation {
  const diffs = planOperationDiffs(operation, baseItem, collectionItems);
  const targetName =
    asString(operation.item?.label ?? operation.item?.name) ??
    asString(baseItem?.label ?? baseItem?.name) ??
    operation.target?.semanticRef ??
    asString(operation.item?.semanticRef);
  const kindLabel = operation.kind
    ? (OPERATION_KIND_LABELS[operation.kind] ?? operation.kind)
    : undefined;
  const collectionLabel = operation.collection
    ? (COLLECTION_LABELS[operation.collection] ?? operation.collection)
    : undefined;
  const generatedLabel =
    kindLabel && collectionLabel
      ? `${kindLabel}${collectionLabel}${targetName ? ` · ${targetName}` : ""}`
      : operation.label;
  const generatedSummary = diffs.length
    ? diffs.length === 1
      ? `${diffs[0]!.label}：${diffs[0]!.before} → ${diffs[0]!.after}`
      : `${diffs.length} 项字段变化${operation.target?.semanticRef ? ` · ${operation.target.semanticRef}` : ""}`
    : operation.summary;

  return {
    ...operation,
    label: generatedLabel,
    summary: generatedSummary,
    diffs
  };
}

function planOperationDiffs(
  operation: AiPlanOperation,
  baseItem?: Record<string, unknown>,
  collectionItems: Record<string, unknown>[] = []
) {
  if (operation.kind === "update" && operation.changes) {
    const afterItem = { ...baseItem, ...operation.changes };
    return Object.entries(operation.changes).flatMap(([field, afterValue]) => {
      const beforeValue = baseItem?.[field];
      if (baseItem && modelingValuesEqual(beforeValue, afterValue)) return [];
      return [
        {
          field,
          label: FIELD_LABELS[field] ?? field,
          before: baseItem
            ? formatPlanValue(beforeValue, field, baseItem)
            : "当前值",
          after: formatPlanValue(afterValue, field, afterItem)
        }
      ];
    });
  }

  if (operation.kind === "add" && operation.item) {
    return [
      {
        field: "item",
        label: COLLECTION_LABELS[operation.collection ?? ""] ?? "对象",
        before: "不存在",
        after:
          describePlanItem(operation.item, operation.collection) ?? "未命名对象"
      }
    ];
  }

  if (operation.kind === "delete") {
    return [
      {
        field: "item",
        label: COLLECTION_LABELS[operation.collection ?? ""] ?? "对象",
        before:
          describePlanItem(baseItem, operation.collection) ??
          operation.target?.semanticRef ??
          "当前对象",
        after: "删除"
      }
    ];
  }

  if (operation.kind === "suppress") {
    return [
      {
        field: "suppressed",
        label: FIELD_LABELS.suppressed!,
        before:
          typeof baseItem?.suppressed === "boolean"
            ? formatPlanValue(baseItem.suppressed, "suppressed", baseItem)
            : "当前状态",
        after:
          typeof operation.suppressed === "boolean"
            ? formatPlanValue(operation.suppressed, "suppressed", baseItem)
            : "未指定"
      }
    ];
  }

  if (operation.kind === "reorder" && operation.orderedRefs) {
    return [
      {
        field: "orderedRefs",
        label: FIELD_LABELS.orderedRefs!,
        before: formatReferenceSequence(collectionItems),
        after: formatReferenceSequence(operation.orderedRefs)
      }
    ];
  }

  return [];
}

function modelCollectionItems(
  document: ModelDocument,
  collection?: string
): Record<string, unknown>[] {
  switch (collection) {
    case "parameters":
      return document.parameters as unknown as Record<string, unknown>[];
    case "sketches":
      return document.sketches as unknown as Record<string, unknown>[];
    case "features":
      return document.features as unknown as Record<string, unknown>[];
    case "components":
      return document.components as unknown as Record<string, unknown>[];
    case "assemblyConstraints":
      return document.assemblyConstraints as unknown as Record<
        string,
        unknown
      >[];
    default:
      return [];
  }
}

function findOperationTarget(
  items: Record<string, unknown>[],
  target?: { id?: string; semanticRef?: string }
) {
  if (!target) return undefined;
  return items.find(
    (item) =>
      (target.id && item.id === target.id) ||
      (target.semanticRef && item.semanticRef === target.semanticRef)
  );
}

function normalizePlanReference(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const reference = value as Record<string, unknown>;
  const id = asString(reference.id);
  const semanticRef = asString(reference.semanticRef);
  return id || semanticRef ? { id, semanticRef } : undefined;
}

function describePlanItem(
  item: Record<string, unknown> | undefined,
  collection?: string
) {
  if (!item) return undefined;
  const name =
    asString(item.label ?? item.name ?? item.semanticRef) ?? "未命名对象";
  if (collection === "parameters") {
    return `${name} = ${formatPlanValue(item.value, "value", item)}`;
  }
  if (collection === "features") {
    const featureKind = asString(item.featureKind);
    return featureKind
      ? `${name}（${FEATURE_KIND_LABELS[featureKind] ?? featureKind}）`
      : name;
  }
  if (collection === "sketches") {
    const entities = Array.isArray(item.entities) ? item.entities.length : 0;
    const constraints = Array.isArray(item.constraints)
      ? item.constraints.length
      : 0;
    return `${name}（${entities} 个实体，${constraints} 个约束）`;
  }
  return name;
}

function formatPlanValue(
  value: unknown,
  field: string,
  context?: Record<string, unknown>
): string {
  if (value === undefined) return "未设置";
  if (value === null) return "空";
  if (typeof value === "boolean") {
    if (field === "suppressed") return value ? "已抑制" : "启用";
    return value ? "是" : "否";
  }
  if (typeof value === "number") {
    const unit =
      field === "value"
        ? parameterUnitLabel(asString(context?.unit))
        : field.toLowerCase().includes("degrees")
          ? "°"
          : field.toLowerCase().includes("mm")
            ? " mm"
            : "";
    return `${value}${unit}`;
  }
  if (typeof value === "string") {
    if (field === "featureKind") return FEATURE_KIND_LABELS[value] ?? value;
    return value;
  }
  if (Array.isArray(value)) {
    if (field === "entities") return `${value.length} 个实体`;
    if (field === "constraints") return `${value.length} 个约束`;
    if (value.every((item) => typeof item === "number")) {
      return `[${value.join(", ")}]`;
    }
    const references = value.flatMap((item) => {
      const reference = normalizePlanReference(item);
      return reference ? [reference.semanticRef ?? reference.id ?? ""] : [];
    });
    if (references.length) return compactSequence(references);
    return `${value.length} 项`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const reference = normalizePlanReference(record);
    if (reference) return reference.semanticRef ?? reference.id ?? "未命名引用";
    const translation = Array.isArray(record.translationMm)
      ? `[${record.translationMm.join(", ")}] mm`
      : undefined;
    const rotation = Array.isArray(record.rotationDegrees)
      ? `[${record.rotationDegrees.join(", ")}]°`
      : undefined;
    if (translation || rotation) {
      return [
        translation && `位置 ${translation}`,
        rotation && `旋转 ${rotation}`
      ]
        .filter(Boolean)
        .join("；");
    }
    const serialized = JSON.stringify(record);
    return serialized.length > 120
      ? `${serialized.slice(0, 117)}…`
      : serialized;
  }
  return String(value);
}

function parameterUnitLabel(unit?: string) {
  if (!unit || unit === "ratio") return "";
  if (unit === "deg") return "°";
  if (unit === "count") return " 个";
  return ` ${unit}`;
}

function formatReferenceSequence(values: Record<string, unknown>[]) {
  const references = values.map(
    (value) => asString(value.semanticRef ?? value.id) ?? "未命名对象"
  );
  return references.length ? compactSequence(references) : "空顺序";
}

function compactSequence(values: string[]) {
  const visible = values.slice(0, 4);
  return `${visible.join(" → ")}${values.length > visible.length ? ` 等 ${values.length} 项` : ""}`;
}

function modelingValuesEqual(left: unknown, right: unknown) {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && Boolean(item.trim())
      )
    : [];
}

function dryRunDiagnostics(...values: Array<Record<string, unknown>>) {
  const dryRun = findDryRun(values);
  const raw = dryRun?.diagnostics;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const diagnostic = item as Record<string, unknown>;
    const code = asString(diagnostic.code);
    const severity = asString(diagnostic.severity);
    const message = asString(diagnostic.message);
    return code && severity && message ? [{ code, severity, message }] : [];
  });
}

function dryRunMetrics(...values: Array<Record<string, unknown>>) {
  const raw = findDryRun(values)?.metrics;
  if (!raw || typeof raw !== "object") return undefined;
  const metrics = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).flatMap(([key, value]) =>
      typeof value === "number" && Number.isFinite(value) ? [[key, value]] : []
    )
  );
  return Object.keys(metrics).length ? metrics : undefined;
}

function findDryRun(values: Array<Record<string, unknown>>) {
  for (const value of values) {
    const job =
      value.job && typeof value.job === "object"
        ? (value.job as Record<string, unknown>)
        : undefined;
    const output =
      (job?.output && typeof job.output === "object"
        ? (job.output as Record<string, unknown>)
        : undefined) ??
      (value.output && typeof value.output === "object"
        ? (value.output as Record<string, unknown>)
        : undefined);
    const dryRun = output?.dryRun;
    if (dryRun && typeof dryRun === "object") {
      return dryRun as Record<string, unknown>;
    }
  }
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
