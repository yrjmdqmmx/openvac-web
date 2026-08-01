import { z } from "zod";

import { ApiError, withApiErrors } from "@/server/api/errors";
import type {
  ModelingArtifactRow,
  ModelingJobRow,
  ModelingPlanRow,
  ModelingProjectRow,
  ModelingRevisionRow,
  ProjectDetail
} from "@/server/modeling/repository";
import { ModelingRepositoryError } from "@/server/modeling/repository";
import { isModelingEnabled } from "@/server/modeling/feature-flag";

import { idempotencyKeySchema } from "./schemas";

const PRIVATE_RESPONSE_KEYS = new Set([
  "objectKey",
  "storageKey",
  "leaseToken",
  "signedUrl"
]);

export function sanitizeModelingJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeModelingJson);
  }
  if (typeof value !== "object" || value === null || value instanceof Date) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !PRIVATE_RESPONSE_KEYS.has(key))
      .map(([key, nested]) => [key, sanitizeModelingJson(nested)])
  );
}

export function withModelingApiErrors<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<Response>
): (...args: TArgs) => Promise<Response> {
  return withApiErrors(async (...args: TArgs) => {
    try {
      if (!isModelingEnabled()) {
        throw new ApiError(
          503,
          "MODELING_DISABLED",
          "智能建模功能尚未通过上线验收，当前未开放。"
        );
      }
      return await handler(...args);
    } catch (error) {
      if (error instanceof ModelingRepositoryError) {
        throw new ApiError(
          error.code.startsWith("MODELING_") && error.code.endsWith("_LIMIT")
            ? 429
            : error.code === "MODELING_QUEUE_FULL"
              ? 503
              : 409,
          error.code,
          error.message,
          error.details
        );
      }
      throw error;
    }
  });
}

export function requireIdempotencyKey(
  request: Request,
  bodyValue?: string
): string {
  const value =
    bodyValue ?? request.headers.get("idempotency-key") ?? undefined;
  if (!value) {
    throw new ApiError(
      422,
      "IDEMPOTENCY_KEY_REQUIRED",
      "该操作需要 Idempotency-Key 请求头或请求体字段。"
    );
  }
  return idempotencyKeySchema.parse(value);
}

export async function parseIdempotencyOnly(request: Request): Promise<string> {
  const header = request.headers.get("idempotency-key") ?? undefined;
  if (header) {
    return requireIdempotencyKey(request, header);
  }
  const text = await request.text();
  if (!text.trim()) {
    return requireIdempotencyKey(request);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "请求体必须是有效的 JSON。");
  }
  const parsed = z
    .object({ idempotencyKey: idempotencyKeySchema })
    .strict()
    .parse(value);
  return parsed.idempotencyKey;
}

export function projectDto(project: ProjectDetail) {
  const { ownerId, createIdempotencyKey, currentRevision, ...safeProject } =
    project;
  void ownerId;
  void createIdempotencyKey;
  return {
    ...safeProject,
    currentRevision: currentRevision ? revisionDto(currentRevision) : null
  };
}

export function projectSummaryDto(project: ModelingProjectRow) {
  const { ownerId, createIdempotencyKey, ...safeProject } = project;
  void ownerId;
  void createIdempotencyKey;
  return safeProject;
}

export function revisionDto(revision: ModelingRevisionRow) {
  const { createdByUserId, idempotencyKey, ...safeRevision } = revision;
  void createdByUserId;
  void idempotencyKey;
  return safeRevision;
}

export function planDto(plan: ModelingPlanRow) {
  const { createdByUserId, idempotencyKey, ...safePlan } = plan;
  void createdByUserId;
  void idempotencyKey;
  return safePlan;
}

export function jobDto(job: ModelingJobRow) {
  const {
    createdByUserId,
    idempotencyKey,
    leaseOwner,
    leaseToken,
    leaseExpiresAt,
    ...safeJob
  } = job;
  void createdByUserId;
  void idempotencyKey;
  void leaseOwner;
  void leaseToken;
  void leaseExpiresAt;
  return {
    ...safeJob,
    input: sanitizeModelingJson(safeJob.input),
    output: sanitizeModelingJson(safeJob.output)
  };
}

export function artifactDto(artifact: ModelingArtifactRow) {
  const { createdByUserId, objectKey, ...safeArtifact } = artifact;
  void createdByUserId;
  void objectKey;
  return safeArtifact;
}
