import { z } from "zod";

import type { ModelDocument } from "@/types/modeling";

const MAX_ARTIFACT_TRANSFER_BYTES = 100 * 1024 * 1024;
const cadJobIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,120}$/u, "invalid CAD job id");

const diagnosticSchema = z.object({
  code: z.string(),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string(),
  target_id: z.string().nullable().optional()
});

const artifactSchema = z.object({
  kind: z.enum(["step", "stl", "glb"]),
  file_name: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  download_path: z.string().startsWith("/v1/artifacts/")
});

const buildResponseSchema = z.object({
  version: z.literal("openvac.modeling.v1"),
  job_id: z.string(),
  model_hash: z.string().regex(/^[a-f0-9]{64}$/),
  kernel_version: z.string(),
  solver_version: z.string(),
  valid: z.boolean(),
  diagnostics: z.array(diagnosticSchema),
  metrics: z
    .object({
      solid_count: z.number().int().nonnegative(),
      volume_mm3: z.number().nonnegative(),
      surface_area_mm2: z.number().nonnegative(),
      bounding_box_mm: z.tuple([z.number(), z.number(), z.number()]),
      center_of_mass_mm: z.tuple([z.number(), z.number(), z.number()]),
      mass_kg: z.number().nonnegative().nullable(),
      mass_status: z.enum([
        "computed_from_user_density",
        "unavailable_density_required"
      ])
    })
    .nullable(),
  artifacts: z.array(artifactSchema),
  duration_ms: z.number().nonnegative()
});

const stepImportResponseSchema = z.object({
  version: z.literal("openvac.modeling.v1"),
  job_id: z.string(),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_size_bytes: z.number().int().positive(),
  kernel_version: z.string(),
  valid: z.boolean(),
  diagnostics: z.array(diagnosticSchema),
  metrics: buildResponseSchema.shape.metrics,
  body_semantic_refs: z.array(z.string().min(3)).min(1).max(1_000),
  artifacts: z.array(artifactSchema),
  duration_ms: z.number().nonnegative()
});

const artifactCleanupResponseSchema = z.object({
  status: z.enum(["deleted", "absent"]),
  job_id: cadJobIdSchema
});

export type CadBuildResponse = z.infer<typeof buildResponseSchema>;
export type CadArtifactDescriptor = z.infer<typeof artifactSchema>;
export type CadStepImportResponse = z.infer<typeof stepImportResponseSchema>;

export interface CadImportedStepSource {
  artifactId: string;
  artifactSha256: string;
  bytes: Uint8Array;
  filename: string;
  contentType: "model/step" | "application/step" | "application/octet-stream";
}

export interface CadBuildRequest {
  jobId: string;
  document: ModelDocument;
  formats: Array<"step" | "stl" | "glb">;
  validatePump?: boolean;
  importedStep?: CadImportedStepSource;
  signal?: AbortSignal;
}

export interface CadStepImportRequest {
  jobId: string;
  bytes: Uint8Array;
  filename: string;
  contentType: "model/step" | "application/step" | "application/octet-stream";
  formats?: Array<"stl" | "glb">;
  signal?: AbortSignal;
}

export interface CadValidationRequest {
  jobId: string;
  document: ModelDocument;
  validatePump?: boolean;
  importedStep?: CadImportedStepSource;
  signal?: AbortSignal;
}

export interface ModelingServiceClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class ModelingServiceError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "ModelingServiceError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export class ModelingServiceClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: ModelingServiceClientOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      process.env.MODELING_SERVICE_URL ??
      "http://127.0.0.1:8080"
    ).replace(/\/+$/, "");
    this.token = options.token ?? process.env.MODELING_SERVICE_TOKEN;
    this.timeoutMs =
      options.timeoutMs ??
      Number(process.env.MODELING_JOB_TIMEOUT_MS ?? 180_000);
    this.fetchFn = options.fetch ?? fetch;
  }

  async ready(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.request(
        "/ready",
        { method: "GET", signal },
        5_000
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async cleanupArtifacts(jobId: string, signal?: AbortSignal): Promise<void> {
    const parsedJobId = cadJobIdSchema.safeParse(jobId);
    if (!parsedJobId.success) {
      throw new ModelingServiceError("建模服务临时制品 job id 无效。", {
        cause: parsedJobId.error
      });
    }
    const response = await this.request(
      `/v1/artifacts/${encodeURIComponent(parsedJobId.data)}`,
      { method: "DELETE", signal },
      Math.min(this.timeoutMs, 10_000)
    );
    const body = await boundedJson(response, 16 * 1024);
    if (!response.ok) {
      throw new ModelingServiceError(extractErrorMessage(body), {
        status: response.status,
        retryable: response.status >= 500
      });
    }
    const parsed = artifactCleanupResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.job_id !== parsedJobId.data) {
      throw new ModelingServiceError("建模服务返回了不兼容的制品清理结果。", {
        cause: parsed.success ? undefined : parsed.error
      });
    }
  }

  async build(request: CadBuildRequest): Promise<CadBuildResponse> {
    const response = request.importedStep
      ? await this.requestWithImportedStep(
          "/v1/builds/imported-step",
          request.jobId,
          request.document,
          request.importedStep,
          {
            formats: request.formats.join(","),
            validate_pump: String(request.validatePump ?? false)
          },
          request.signal,
          this.timeoutMs
        )
      : await this.request(
          "/v1/builds",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              version: "openvac.modeling.v1",
              job_id: request.jobId,
              document: request.document,
              formats: request.formats,
              validate_pump: request.validatePump ?? false
            }),
            signal: request.signal
          },
          this.timeoutMs
        );
    const body = await boundedJson(response, 4 * 1024 * 1024);
    if (!response.ok) {
      throw new ModelingServiceError(extractErrorMessage(body), {
        status: response.status,
        retryable: response.status >= 500
      });
    }
    const parsed = buildResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ModelingServiceError("建模服务返回了不兼容的构建结果。", {
        cause: parsed.error
      });
    }
    return parsed.data;
  }

  async importStep(
    request: CadStepImportRequest
  ): Promise<CadStepImportResponse> {
    if (
      request.bytes.byteLength < 1 ||
      request.bytes.byteLength > 50 * 1024 * 1024
    ) {
      throw new ModelingServiceError("STEP 文件必须大于 0 且不超过 50 MB。");
    }
    const formats = [...new Set(request.formats ?? ["glb"])] as Array<
      "stl" | "glb"
    >;
    if (
      formats.length < 1 ||
      formats.length > 2 ||
      formats.some((format) => format !== "stl" && format !== "glb")
    ) {
      throw new ModelingServiceError("STEP 转换格式必须是 STL 或 GLB。");
    }
    const form = new FormData();
    const ownedBytes = new Uint8Array(request.bytes);
    form.append(
      "file",
      new Blob([ownedBytes.buffer], { type: request.contentType }),
      request.filename
    );
    const response = await this.request(
      `/v1/imports/step?job_id=${encodeURIComponent(request.jobId)}&formats=${formats.join(
        ","
      )}`,
      { method: "POST", body: form, signal: request.signal },
      this.timeoutMs
    );
    const body = await boundedJson(response, 4 * 1024 * 1024);
    if (!response.ok) {
      throw new ModelingServiceError(extractErrorMessage(body), {
        status: response.status,
        retryable: response.status >= 500
      });
    }
    const parsed = stepImportResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ModelingServiceError("建模服务返回了不兼容的 STEP 导入结果。", {
        cause: parsed.error
      });
    }
    return parsed.data;
  }

  async validate(request: CadValidationRequest): Promise<CadBuildResponse> {
    const timeoutMs = Number(
      process.env.MODELING_INTERACTIVE_TIMEOUT_MS ?? 30_000
    );
    const response = request.importedStep
      ? await this.requestWithImportedStep(
          "/v1/validations/imported-step",
          request.jobId,
          request.document,
          request.importedStep,
          { validate_pump: String(request.validatePump ?? false) },
          request.signal,
          timeoutMs
        )
      : await this.request(
          "/v1/validations",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              version: "openvac.modeling.v1",
              job_id: request.jobId,
              document: request.document,
              validate_pump: request.validatePump ?? false
            }),
            signal: request.signal
          },
          timeoutMs
        );
    const body = await boundedJson(response, 4 * 1024 * 1024);
    if (!response.ok) {
      throw new ModelingServiceError(extractErrorMessage(body), {
        status: response.status,
        retryable: response.status >= 500
      });
    }
    const parsed = buildResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.artifacts.length > 0) {
      throw new ModelingServiceError("建模服务返回了不兼容的校验结果。", {
        cause: parsed.success ? undefined : parsed.error
      });
    }
    return parsed.data;
  }

  private async requestWithImportedStep(
    path: string,
    jobId: string,
    document: ModelDocument,
    source: CadImportedStepSource,
    query: Record<string, string>,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<Response> {
    if (
      source.bytes.byteLength < 1 ||
      source.bytes.byteLength > 50 * 1024 * 1024
    ) {
      throw new ModelingServiceError(
        "STEP 基础实体必须大于 0 且不超过 50 MB。"
      );
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        source.artifactId
      ) ||
      !/^[a-f0-9]{64}$/u.test(source.artifactSha256)
    ) {
      throw new ModelingServiceError("STEP 基础实体身份或 SHA-256 无效。");
    }
    const parameters = new URLSearchParams({
      job_id: jobId,
      artifact_id: source.artifactId,
      artifact_sha256: source.artifactSha256,
      ...query
    });
    const form = new FormData();
    form.append("document", JSON.stringify(document));
    const ownedBytes = new Uint8Array(source.bytes);
    form.append(
      "file",
      new Blob([ownedBytes.buffer], { type: source.contentType }),
      source.filename
    );
    return this.request(
      `${path}?${parameters.toString()}`,
      { method: "POST", body: form, signal },
      timeoutMs
    );
  }

  async downloadArtifact(
    artifact: CadArtifactDescriptor,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const response = await this.request(
      artifact.download_path,
      { method: "GET", signal },
      this.timeoutMs
    );
    if (!response.ok) {
      throw new ModelingServiceError("无法从建模服务读取制品。", {
        status: response.status,
        retryable: response.status >= 500
      });
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_ARTIFACT_TRANSFER_BYTES) {
      throw new ModelingServiceError("建模制品超过内部传输上限。");
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_ARTIFACT_TRANSFER_BYTES) {
      throw new ModelingServiceError("建模制品超过内部传输上限。");
    }
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength !== artifact.size_bytes) {
      throw new ModelingServiceError("建模制品长度与内核描述不一致。", {
        retryable: true
      });
    }
    return bytes;
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new ModelingServiceError("建模服务超时配置无效。");
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const headers = new Headers(init.headers);
    if (this.token) {
      headers.set("x-openvac-service-token", this.token);
    }
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal
      });
    } catch (cause) {
      throw new ModelingServiceError("无法连接确定性 CAD 内核。", {
        retryable: true,
        cause
      });
    }
  }
}

async function boundedJson(
  response: Response,
  maxBytes: number
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) {
    throw new ModelingServiceError("建模服务响应超过大小限制。");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new ModelingServiceError("建模服务响应超过大小限制。");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ModelingServiceError("建模服务返回了无效 JSON。", { cause });
  }
}

function extractErrorMessage(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "确定性 CAD 内核执行失败。";
  }
  const detail = (value as { detail?: unknown }).detail;
  return typeof detail === "string" && detail.trim()
    ? detail
    : "确定性 CAD 内核执行失败。";
}

let singleton: ModelingServiceClient | undefined;

export function getModelingServiceClient(): ModelingServiceClient {
  singleton ??= new ModelingServiceClient();
  return singleton;
}
