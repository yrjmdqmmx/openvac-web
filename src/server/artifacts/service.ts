import { createHash } from "node:crypto";

import type {
  ArtifactFormat,
  ArtifactPart,
  ArtifactSpec
} from "@/types/chat-v3";
import { renderArtifactFiles } from "./renderers";
import type {
  ArtifactDownloadMetadata,
  ArtifactFailureCode,
  ArtifactFileRecord,
  ArtifactGenerationRequest,
  ArtifactGenerationResult,
  ArtifactObjectStore,
  ArtifactRenderer,
  ArtifactRepository
} from "./types";
import { parseArtifactSpec } from "./validation";

export type ArtifactServiceDependencies = {
  repository: ArtifactRepository;
  objectStore: ArtifactObjectStore;
  renderer?: ArtifactRenderer;
  now?: () => Date;
};

export class ArtifactService {
  private readonly renderer: ArtifactRenderer;
  private readonly now: () => Date;

  constructor(private readonly dependencies: ArtifactServiceDependencies) {
    this.renderer = dependencies.renderer ?? { render: renderArtifactFiles };
    this.now = dependencies.now ?? (() => new Date());
  }

  async generateSafely(
    request: ArtifactGenerationRequest
  ): Promise<ArtifactGenerationResult> {
    let spec: ArtifactSpec;
    try {
      spec = parseArtifactSpec(request.spec);
    } catch {
      return failedResult(request.artifactId, undefined, "VALIDATION_FAILED");
    }

    const createdAt = this.now();
    const base = {
      artifactId: request.artifactId,
      ownerId: request.ownerId,
      conversationId: request.conversationId,
      sourceTurnId: spec.sourceTurnId,
      kind: spec.kind,
      title: spec.title,
      formats: spec.formats,
      createdAt,
      updatedAt: createdAt
    };

    try {
      await this.dependencies.repository.createGenerating(base);
    } catch {
      return failedResult(request.artifactId, spec, "REPOSITORY_FAILED");
    }

    let rendered;
    try {
      rendered = await this.renderer.render(spec);
      if (!renderedFilesMatchSpec(spec, rendered)) {
        throw new Error("Renderer output does not match requested formats.");
      }
    } catch {
      await this.markFailed(request.artifactId, "RENDER_FAILED");
      return failedResult(request.artifactId, spec, "RENDER_FAILED");
    }

    const stored: ArtifactFileRecord[] = [];
    try {
      for (const file of rendered) {
        const checksumSha256 = sha256(file.bytes);
        const objectKey = artifactObjectKey(
          request.ownerId,
          request.artifactId,
          file.format,
          checksumSha256
        );
        await this.dependencies.objectStore.put({
          objectKey,
          bytes: file.bytes,
          contentType: file.contentType,
          checksumSha256
        });
        stored.push({
          format: file.format,
          filename: file.filename,
          contentType: file.contentType,
          sizeBytes: file.bytes.length,
          checksumSha256,
          objectKey,
          createdAt
        });
      }
    } catch {
      await Promise.allSettled(
        stored.map((file) =>
          this.dependencies.objectStore.delete(file.objectKey)
        )
      );
      await this.markFailed(request.artifactId, "STORAGE_FAILED");
      return failedResult(request.artifactId, spec, "STORAGE_FAILED");
    }

    try {
      await this.dependencies.repository.markReady(
        request.artifactId,
        stored,
        this.now()
      );
    } catch {
      await Promise.allSettled(
        stored.map((file) =>
          this.dependencies.objectStore.delete(file.objectKey)
        )
      );
      await this.markFailed(request.artifactId, "REPOSITORY_FAILED");
      return failedResult(request.artifactId, spec, "REPOSITORY_FAILED");
    }

    return {
      artifact: artifactPart(request.artifactId, spec, "ready"),
      downloads: stored.map((file) =>
        downloadMetadata(request.artifactId, file)
      )
    };
  }

  private async markFailed(
    artifactId: string,
    code: ArtifactFailureCode
  ): Promise<void> {
    await this.dependencies.repository
      .markFailed(artifactId, code, this.now())
      .catch(() => undefined);
  }
}

function failedResult(
  artifactId: string,
  spec: ArtifactSpec | undefined,
  failureCode: ArtifactFailureCode
): ArtifactGenerationResult {
  const fallback: Pick<ArtifactSpec, "kind" | "title" | "formats"> = {
    kind: "diagnosis_report",
    title: "产物生成失败",
    formats: []
  };
  const display = spec ?? fallback;
  return {
    artifact: {
      type: "artifact",
      artifactId,
      kind: display.kind,
      title: display.title,
      formats: display.formats,
      status: "failed"
    },
    downloads: [],
    failureCode
  };
}

function artifactPart(
  artifactId: string,
  spec: Pick<ArtifactSpec, "kind" | "title" | "formats">,
  status: ArtifactPart["status"]
): ArtifactPart {
  return {
    type: "artifact",
    artifactId,
    kind: spec.kind,
    title: spec.title,
    formats: spec.formats,
    status
  };
}

function downloadMetadata(
  artifactId: string,
  file: ArtifactFileRecord
): ArtifactDownloadMetadata {
  return {
    artifactId,
    format: file.format,
    filename: file.filename,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    downloadPath: `/api/artifacts/${encodeURIComponent(artifactId)}/${file.format}`,
    createdAt: file.createdAt.toISOString()
  };
}

function artifactObjectKey(
  ownerId: string,
  artifactId: string,
  format: ArtifactFormat,
  checksumSha256: string
): string {
  const ownerPartition = createHash("sha256")
    .update(ownerId)
    .digest("hex")
    .slice(0, 24);
  return `chat-artifacts/${ownerPartition}/${artifactId}/${checksumSha256}.${format}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function renderedFilesMatchSpec(
  spec: ArtifactSpec,
  files: Array<{ format: ArtifactFormat; bytes: Uint8Array }>
): boolean {
  const formats = files.map((file) => file.format);
  return (
    formats.length === spec.formats.length &&
    new Set(formats).size === formats.length &&
    spec.formats.every((format) => formats.includes(format)) &&
    files.every((file) => file.bytes.length > 0)
  );
}
