import { createHash } from "node:crypto";

import { hashCanonicalSpec } from "@/lib/modeling/protocol";
import { authenticate } from "@/server/api/auth";
import { ApiError, jsonData, notFound, parseJson } from "@/server/api/errors";
import {
  modelingRepository,
  type ModelingRepository
} from "@/server/modeling/repository";
import { ProviderError } from "@/server/providers/errors";
import { getObjectStorage } from "@/server/providers/oss";
import type {
  ObjectStorage,
  PrivateObjectStat,
  PrivateUploadUrl
} from "@/server/providers/types";

import {
  importCompleteSchema,
  importPresignSchema,
  modelingUuidSchema,
  STEP_IMPORT_MAX_BYTES
} from "./schemas";
import { jobDto, requireIdempotencyKey, withModelingApiErrors } from "./shared";

function uploadUnavailable(): ApiError {
  return new ApiError(
    501,
    "CAPABILITY_UNAVAILABLE",
    "当前对象存储适配器不支持可校验的私有直传签名，导入上传尚未启用。"
  );
}

const STEP_CONTENT_TYPES = new Set([
  "model/step",
  "application/step",
  "application/octet-stream"
]);
const STEP_UPLOAD_EXPIRES_SECONDS = 900;

export interface VerifiedStepUpload {
  objectKey: string;
  sourceName: string;
  sizeBytes: number;
  checksumSha256: string;
  contentType: string;
  etag?: string;
  verifiedAt: string;
}

export interface StepUploadIdentity {
  ownerId: string;
  projectId: string;
}

export interface CreateStepUploadInput extends StepUploadIdentity {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  idempotencyKey: string;
}

export interface CanonicalStepUploadIntent extends StepUploadIdentity {
  idempotencyKey: string;
  requestHash: string;
  objectKey: string;
  sourceName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface VerifyStepUploadInput extends StepUploadIdentity {
  objectKey: string;
  sizeBytes: number;
  checksumSha256: string;
}

/** Creates a private, header-bound upload without trusting a browser path. */
export async function createPrivateStepUpload(
  input: CreateStepUploadInput,
  storage: ObjectStorage = getObjectStorage()
): Promise<PrivateUploadUrl> {
  return signPrivateStepUpload(canonicalStepUploadIntent(input), storage);
}

export function canonicalStepUploadIntent(
  input: CreateStepUploadInput
): CanonicalStepUploadIntent {
  const sourceName = validateStepLimits(
    input.filename,
    input.mimeType,
    input.sizeBytes,
    input.checksumSha256
  );
  const mimeType = normalizeContentType(input.mimeType);
  if (!mimeType) {
    throw uploadVerificationFailed("STEP 文件的 Content-Type 不受支持。");
  }
  const requestHash = hashCanonicalSpec({
    protocol: "openvac.modeling.v1",
    kind: "step_upload",
    sourceName,
    mimeType,
    sizeBytes: input.sizeBytes,
    checksumSha256: input.checksumSha256
  });
  const prefix = modelingImportPrefix(input.ownerId, input.projectId);
  const uploadId = createHash("sha256")
    .update(
      JSON.stringify([
        input.ownerId,
        input.projectId,
        input.idempotencyKey,
        requestHash
      ])
    )
    .digest("hex")
    .slice(0, 40);

  return {
    ownerId: input.ownerId,
    projectId: input.projectId,
    idempotencyKey: input.idempotencyKey,
    requestHash,
    objectKey: `${prefix}${uploadId}.step`,
    sourceName,
    mimeType,
    sizeBytes: input.sizeBytes,
    checksumSha256: input.checksumSha256
  };
}

async function signPrivateStepUpload(
  intent: CanonicalStepUploadIntent,
  storage: ObjectStorage
): Promise<PrivateUploadUrl> {
  if (!storage.createPrivateUploadUrl) {
    throw uploadUnavailable();
  }
  const ownerSegment = encodeURIComponent(intent.ownerId);

  try {
    return await storage.createPrivateUploadUrl({
      key: intent.objectKey,
      contentType: intent.mimeType,
      contentLength: intent.sizeBytes,
      checksumSha256: intent.checksumSha256,
      metadata: {
        "upload-kind": "modeling-step",
        "owner-id": ownerSegment,
        "project-id": intent.projectId,
        "source-name": encodeURIComponent(intent.sourceName)
      },
      expiresSeconds: STEP_UPLOAD_EXPIRES_SECONDS
    });
  } catch (error) {
    throw storageApiError(error);
  }
}

export async function verifyCompletedStepUpload(
  input: VerifyStepUploadInput,
  storage: ObjectStorage = getObjectStorage()
): Promise<VerifiedStepUpload> {
  if (!storage.statPrivate) {
    throw uploadUnavailable();
  }
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > STEP_IMPORT_MAX_BYTES ||
    !/^[a-f0-9]{64}$/u.test(input.checksumSha256)
  ) {
    throw uploadVerificationFailed("上传对象大小或 SHA-256 无效。");
  }
  const prefix = modelingImportPrefix(input.ownerId, input.projectId);
  if (
    !input.objectKey.startsWith(prefix) ||
    !/^[0-9a-f]{40}\.step$/.test(input.objectKey.slice(prefix.length))
  ) {
    throw new ApiError(
      422,
      "INVALID_OBJECT_KEY",
      "上传对象不属于当前用户和项目。"
    );
  }

  let stored: PrivateObjectStat;
  try {
    stored = await storage.statPrivate(input.objectKey);
  } catch (error) {
    throw storageApiError(error);
  }

  const contentType = normalizeContentType(stored.contentType);
  const expectedMetadata: Record<string, string> = {
    sha256: input.checksumSha256,
    "size-bytes": String(input.sizeBytes),
    "upload-kind": "modeling-step",
    "owner-id": encodeURIComponent(input.ownerId),
    "project-id": input.projectId
  };
  const sourceName = decodeSourceName(stored.metadata["source-name"]);
  if (
    stored.key !== input.objectKey ||
    stored.sizeBytes !== input.sizeBytes ||
    !contentType ||
    !STEP_CONTENT_TYPES.has(contentType) ||
    Object.entries(expectedMetadata).some(
      ([key, value]) =>
        stored.metadata[key]?.toLowerCase() !== value.toLowerCase()
    ) ||
    !sourceName
  ) {
    throw uploadVerificationFailed(
      "对象大小、类型或服务端校验元数据与预签名请求不一致。"
    );
  }

  return {
    objectKey: stored.key,
    sourceName,
    sizeBytes: stored.sizeBytes,
    checksumSha256: input.checksumSha256,
    contentType,
    etag: stored.etag,
    verifiedAt: new Date().toISOString()
  };
}

export const handlePresignModelingImport = withModelingApiErrors(
  async (
    request: Request,
    projectId: string,
    repository: ModelingRepository = modelingRepository,
    storage: ObjectStorage = getObjectStorage()
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(projectId);
    const input = await parseJson(request, importPresignSchema);
    const project = await repository.getProject(user.id, id);
    if (!project) {
      throw notFound("建模项目");
    }
    const idempotencyKey = requireIdempotencyKey(request, input.idempotencyKey);
    const canonical = canonicalStepUploadIntent({
      ownerId: user.id,
      projectId: id,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256,
      idempotencyKey
    });
    const reserved = await repository.reserveStepUploadIntent({
      ...canonical,
      expiresAt: new Date(Date.now() + STEP_UPLOAD_EXPIRES_SECONDS * 1_000)
    });
    if (!reserved) {
      throw notFound("建模项目");
    }
    if (reserved.value.completedAt) {
      throw new ApiError(
        409,
        "STEP_UPLOAD_ALREADY_COMPLETED",
        "该 STEP 上传已经确认，不能再次覆盖源文件。"
      );
    }
    const upload = await signPrivateStepUpload(
      {
        ownerId: reserved.value.ownerId,
        projectId: reserved.value.projectId,
        idempotencyKey: reserved.value.idempotencyKey,
        requestHash: reserved.value.requestHash,
        objectKey: reserved.value.objectKey,
        sourceName: reserved.value.sourceName,
        mimeType: reserved.value.mimeType,
        sizeBytes: reserved.value.sizeBytes,
        checksumSha256: reserved.value.checksumSha256
      },
      storage
    );
    return jsonData(
      {
        upload,
        constraints: {
          format: "STEP",
          maxBytes: STEP_IMPORT_MAX_BYTES
        },
        idempotentReplay: reserved.replayed
      },
      {
        headers: reserved.replayed ? { "idempotency-replayed": "true" } : {}
      }
    );
  }
);

export const handleCompleteModelingImport = withModelingApiErrors(
  async (
    request: Request,
    projectId: string,
    repository: ModelingRepository = modelingRepository,
    storage: ObjectStorage = getObjectStorage()
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(projectId);
    const input = await parseJson(request, importCompleteSchema);
    const idempotencyKey = requireIdempotencyKey(request, input.idempotencyKey);
    const project = await repository.getProject(user.id, id);
    if (!project) {
      throw notFound("建模项目");
    }
    if (!project.currentRevision) {
      throw new ApiError(
        409,
        "PROJECT_HAS_NO_REVISION",
        "建模项目缺少可作为 STEP 导入基础的当前版本。"
      );
    }
    const intent = await repository.getStepUploadIntent(
      user.id,
      id,
      input.objectKey
    );
    if (
      !intent ||
      intent.sizeBytes !== input.sizeBytes ||
      intent.checksumSha256 !== input.checksumSha256
    ) {
      throw new ApiError(
        409,
        "STEP_UPLOAD_INTENT_MISMATCH",
        "完成确认必须与当前用户和项目的 STEP 预签名请求完全一致。"
      );
    }

    const verifiedUpload: VerifiedStepUpload = intent.completedAt
      ? {
          objectKey: intent.objectKey,
          sourceName: intent.sourceName,
          sizeBytes: intent.sizeBytes,
          checksumSha256: intent.checksumSha256,
          contentType: intent.mimeType,
          verifiedAt: intent.completedAt.toISOString()
        }
      : await verifyCompletedStepUpload(
          {
            ownerId: user.id,
            projectId: id,
            objectKey: input.objectKey,
            checksumSha256: input.checksumSha256,
            sizeBytes: input.sizeBytes
          },
          storage
        );
    if (
      verifiedUpload.sourceName !== intent.sourceName ||
      verifiedUpload.contentType !== intent.mimeType
    ) {
      throw new ApiError(
        409,
        "STEP_UPLOAD_INTENT_MISMATCH",
        "上传对象的文件名或类型与持久化预签名请求不一致。"
      );
    }

    const result = await repository.completeStepUploadIntent({
      ownerId: user.id,
      projectId: id,
      revisionId: project.currentRevision.id,
      completionIdempotencyKey: idempotencyKey,
      objectKey: verifiedUpload.objectKey,
      sourceName: verifiedUpload.sourceName,
      sizeBytes: verifiedUpload.sizeBytes,
      checksumSha256: verifiedUpload.checksumSha256,
      mimeType: verifiedUpload.contentType
    });
    if (!result) {
      throw new ApiError(
        409,
        "STEP_UPLOAD_INTENT_MISMATCH",
        "STEP 预签名请求不存在、已变更或不属于当前项目。"
      );
    }
    return jsonData(
      {
        upload: verifiedUpload,
        job: jobDto(result.value),
        enqueued: true,
        idempotentReplay: result.replayed
      },
      {
        status: result.replayed ? 200 : 202,
        headers: result.replayed ? { "idempotency-replayed": "true" } : {}
      }
    );
  }
);

function modelingImportPrefix(ownerId: string, projectId: string): string {
  return `modeling/${encodeURIComponent(ownerId)}/${projectId}/imports/`;
}

function validateStepLimits(
  filename: string,
  mimeType: string,
  sizeBytes: number,
  checksumSha256: string
): string {
  const sourceName = filename.normalize("NFKC").trim();
  if (
    !sourceName ||
    sourceName.length > 255 ||
    sourceName.includes("\0") ||
    sourceName.includes("/") ||
    sourceName.includes("\\") ||
    !/\.(?:step|stp)$/iu.test(sourceName)
  ) {
    throw uploadVerificationFailed("首版仅支持 .step 或 .stp 文件。");
  }
  if (!STEP_CONTENT_TYPES.has(normalizeContentType(mimeType) ?? "")) {
    throw uploadVerificationFailed("STEP 文件的 Content-Type 不受支持。");
  }
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > STEP_IMPORT_MAX_BYTES
  ) {
    throw uploadVerificationFailed("STEP 文件必须大于 0 且不超过 50 MB。");
  }
  if (!/^[a-f0-9]{64}$/u.test(checksumSha256)) {
    throw uploadVerificationFailed("STEP 文件 SHA-256 无效。");
  }
  return sourceName;
}

function normalizeContentType(value: string | undefined): string | undefined {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function decodeSourceName(value: string | undefined): string | undefined {
  if (!value || value.length > 1_024) {
    return undefined;
  }
  try {
    const decoded = decodeURIComponent(value).normalize("NFKC").trim();
    if (
      !decoded ||
      decoded.length > 255 ||
      decoded.includes("\0") ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      !/\.(?:step|stp)$/iu.test(decoded)
    ) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

function uploadVerificationFailed(message: string): ApiError {
  return new ApiError(422, "UPLOAD_VERIFICATION_FAILED", message);
}

function storageApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof ProviderError && error.status === 404) {
    return new ApiError(
      422,
      "UPLOADED_OBJECT_NOT_FOUND",
      "未找到待确认的上传对象，或对象已过期。"
    );
  }
  return new ApiError(
    503,
    "OBJECT_STORAGE_UNAVAILABLE",
    "对象存储暂时不可用，请稍后重试。"
  );
}
