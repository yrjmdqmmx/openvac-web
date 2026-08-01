import { authenticate } from "@/server/api/auth";
import { ApiError, notFound, parseSearchParams } from "@/server/api/errors";
import {
  modelingRepository,
  type ModelingRepository
} from "@/server/modeling/repository";
import {
  ConfigurationError,
  ProviderError,
  ProviderResponseError
} from "@/server/providers/errors";
import { getObjectStorage } from "@/server/providers/oss";
import type { ObjectStorage } from "@/server/providers/types";

import { artifactDownloadQuerySchema, modelingUuidSchema } from "./schemas";
import { withModelingApiErrors } from "./shared";

export const handleDownloadModelingArtifact = withModelingApiErrors(
  async (
    request: Request,
    artifactId: string,
    repository: ModelingRepository = modelingRepository,
    storage: ObjectStorage = getObjectStorage()
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(artifactId);
    const query = parseSearchParams(request, artifactDownloadQuerySchema);
    const artifact = await repository.getArtifact(user.id, id);
    if (!artifact) {
      throw notFound("建模产物");
    }
    if (artifact.expiresAt && artifact.expiresAt.getTime() <= Date.now()) {
      throw new ApiError(410, "ARTIFACT_EXPIRED", "该建模产物已经过期。");
    }

    let signedUrl: string;
    try {
      signedUrl = await storage.createPrivateDownloadUrl(
        artifact.objectKey,
        query.expiresSeconds
      );
    } catch (error) {
      if (
        error instanceof ConfigurationError ||
        (error instanceof ProviderResponseError &&
          error.message.includes("cannot create signed URLs"))
      ) {
        throw new ApiError(
          501,
          "CAPABILITY_UNAVAILABLE",
          "当前对象存储尚不能生成私有下载签名。"
        );
      }
      if (error instanceof ProviderError) {
        throw new ApiError(
          502,
          "STORAGE_PROVIDER_ERROR",
          "对象存储暂时无法生成下载地址。"
        );
      }
      throw error;
    }

    let target: URL;
    try {
      target = new URL(signedUrl);
    } catch {
      throw new ApiError(
        502,
        "INVALID_SIGNED_URL",
        "对象存储返回了无效的下载地址。"
      );
    }
    if (target.protocol !== "https:") {
      throw new ApiError(
        502,
        "INVALID_SIGNED_URL",
        "对象存储下载地址必须使用 HTTPS。"
      );
    }
    return new Response(null, {
      status: 307,
      headers: {
        location: target.toString(),
        "cache-control": "private, no-store"
      }
    });
  }
);
