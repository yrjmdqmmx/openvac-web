import { getObjectStorage } from "@/server/providers";
import {
  parseArtifactSpec,
  renderArtifactFiles,
  type RenderedArtifactFile
} from "@/server/artifacts";
import type {
  ArtifactGenerationFailureCode,
  ArtifactStorage,
  ArtifactStorageCreateInput,
  StoredArtifact
} from "@/server/agent/artifact-tools";
import { ArtifactToolError } from "@/server/agent/artifact-tools";
import type { ArtifactFormat, ArtifactSpec } from "@/types/chat-v3";

import {
  ChatArtifactStorageService,
  chatArtifactStorageRepository,
  type ChatArtifactView
} from "./artifact-storage";

export type ArtifactFileRenderer = (
  spec: ArtifactSpec
) => Promise<RenderedArtifactFile[]>;

export class ProductionArtifactStorage implements ArtifactStorage {
  constructor(
    private readonly storage: ChatArtifactStorageService,
    private readonly renderer: ArtifactFileRenderer = renderArtifactFiles
  ) {}

  async create(input: ArtifactStorageCreateInput): Promise<StoredArtifact> {
    input.signal?.throwIfAborted();
    let spec: ArtifactSpec;
    try {
      spec = parseArtifactSpec(input.spec);
    } catch (error) {
      throw new ArtifactToolError(
        artifactRecordCreationFailureCode(error),
        "Artifact specification could not be prepared."
      );
    }
    if (spec.sourceTurnId !== input.turnId) {
      throw new ArtifactToolError(
        "ARTIFACT_SCOPE_MISMATCH",
        "Artifact source turn does not match the active turn."
      );
    }
    let artifact: ChatArtifactView;
    try {
      artifact = await this.storage.create({
        userId: input.userId,
        conversationId: input.conversationId,
        runId: input.runId,
        assistantMessageId: input.assistantMessageId,
        spec
      });
    } catch (error) {
      throw new ArtifactToolError(
        artifactRecordCreationFailureCode(error),
        "Artifact metadata could not be created."
      );
    }

    let failureCode: ArtifactGenerationFailureCode = "ARTIFACT_RENDER_FAILED";
    try {
      const files = await this.renderer(spec);
      input.signal?.throwIfAborted();
      assertRenderedFiles(spec, files);
      failureCode = "ARTIFACT_PERSIST_FAILED";
      for (const file of files) {
        input.signal?.throwIfAborted();
        await this.storage.persistFile({
          artifactId: artifact.id,
          conversationId: input.conversationId,
          userId: input.userId,
          format: file.format,
          filename: file.filename,
          bytes: file.bytes
        });
        input.signal?.throwIfAborted();
      }
      input.signal?.throwIfAborted();
      failureCode = "ARTIFACT_FINALIZE_FAILED";
      const ready = await this.storage.complete({
        artifactId: artifact.id,
        conversationId: input.conversationId,
        userId: input.userId
      });
      input.signal?.throwIfAborted();
      assertReadyArtifact(ready, artifact, spec);
      return storedArtifact(ready, input.userId);
    } catch {
      if (input.signal?.aborted) failureCode = "ARTIFACT_RUN_ABORTED";
      try {
        await this.storage.fail({
          artifactId: artifact.id,
          conversationId: input.conversationId,
          userId: input.userId
        });
      } catch {
        failureCode = "ARTIFACT_CLEANUP_FAILED";
      }
      return {
        ...storedArtifact(artifact, input.userId),
        status: "failed",
        failureCode
      };
    }
  }

  async discardRun(input: {
    runId: string;
    userId: string;
    conversationId: string;
    turnId: string;
    assistantMessageId: string;
  }): Promise<void> {
    await this.storage.failRun(input);
  }
}

export const chatArtifactStorageService = new ChatArtifactStorageService(
  chatArtifactStorageRepository,
  getObjectStorage()
);

/** Inject this single instance into AgentRunOrchestrator's artifactStorage. */
export const agentArtifactStorage = new ProductionArtifactStorage(
  chatArtifactStorageService
);

export function artifactRecordCreationFailureCode(
  error: unknown
):
  | "INVALID_ARTIFACT_SPEC"
  | "ARTIFACT_SCOPE_MISMATCH"
  | "ARTIFACT_SCHEMA_UNAVAILABLE"
  | "ARTIFACT_STORAGE_FORBIDDEN"
  | "ARTIFACT_STORAGE_UNAVAILABLE"
  | "ARTIFACT_RECORD_CREATE_TIMEOUT"
  | "ARTIFACT_RECORD_CREATE_FAILED" {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  if (code === "ARTIFACT_SPEC_INVALID") return "INVALID_ARTIFACT_SPEC";
  if (code === "NOT_FOUND" || code === "23503") {
    return "ARTIFACT_SCOPE_MISMATCH";
  }
  if (["42P01", "42703", "42704", "42883"].includes(code ?? "")) {
    return "ARTIFACT_SCHEMA_UNAVAILABLE";
  }
  if (code === "42501") return "ARTIFACT_STORAGE_FORBIDDEN";
  if (
    /^08/u.test(code ?? "") ||
    ["53300", "57P01", "57P02", "57P03"].includes(code ?? "")
  ) {
    return "ARTIFACT_STORAGE_UNAVAILABLE";
  }
  if (code === "57014") return "ARTIFACT_RECORD_CREATE_TIMEOUT";
  if (["22P02", "23502", "23514"].includes(code ?? "")) {
    return "INVALID_ARTIFACT_SPEC";
  }
  return "ARTIFACT_RECORD_CREATE_FAILED";
}

function assertRenderedFiles(
  spec: ArtifactSpec,
  files: readonly RenderedArtifactFile[]
): void {
  const formats = files.map((file) => file.format);
  if (
    !sameFormats(formats, spec.formats) ||
    files.some(
      (file) =>
        !(file.bytes instanceof Uint8Array) ||
        file.bytes.byteLength < 1 ||
        !file.filename.toLowerCase().endsWith(`.${file.format}`)
    )
  ) {
    throw new Error("Rendered artifact files do not match the validated spec.");
  }
}

function assertReadyArtifact(
  ready: ChatArtifactView,
  created: ChatArtifactView,
  spec: ArtifactSpec
): void {
  if (
    ready.id !== created.id ||
    ready.conversationId !== created.conversationId ||
    ready.sourceTurnId !== spec.sourceTurnId ||
    ready.kind !== spec.kind ||
    ready.title !== spec.title ||
    ready.status !== "ready" ||
    !ready.readyAt ||
    !sameFormats(ready.formats, spec.formats)
  ) {
    throw new Error(
      "Artifact repository did not atomically finalize the artifact."
    );
  }
}

function storedArtifact(
  artifact: ChatArtifactView,
  userId: string
): StoredArtifact {
  return {
    artifactId: artifact.id,
    userId,
    conversationId: artifact.conversationId,
    sourceTurnId: artifact.sourceTurnId,
    kind: artifact.kind,
    title: artifact.title,
    formats: [...artifact.formats],
    status: artifact.status
  };
}

function sameFormats(
  left: readonly ArtifactFormat[],
  right: readonly ArtifactFormat[]
): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((format) => right.includes(format))
  );
}
