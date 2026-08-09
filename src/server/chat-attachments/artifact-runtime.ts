import { getObjectStorage } from "@/server/providers";
import {
  parseArtifactSpec,
  renderArtifactFiles,
  type RenderedArtifactFile
} from "@/server/artifacts";
import type {
  ArtifactStorage,
  ArtifactStorageCreateInput,
  StoredArtifact
} from "@/server/agent/artifact-tools";
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
    const spec = parseArtifactSpec(input.spec);
    if (spec.sourceTurnId !== input.turnId) {
      throw new Error("Artifact source turn does not match the active turn.");
    }
    const artifact = await this.storage.create({
      userId: input.userId,
      conversationId: input.conversationId,
      runId: input.runId,
      assistantMessageId: input.assistantMessageId,
      spec
    });

    try {
      const files = await this.renderer(spec);
      input.signal?.throwIfAborted();
      assertRenderedFiles(spec, files);
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
      const ready = await this.storage.complete({
        artifactId: artifact.id,
        conversationId: input.conversationId,
        userId: input.userId
      });
      input.signal?.throwIfAborted();
      assertReadyArtifact(ready, artifact, spec);
      return storedArtifact(ready, input.userId);
    } catch {
      await this.storage.fail({
        artifactId: artifact.id,
        conversationId: input.conversationId,
        userId: input.userId
      });
      return {
        ...storedArtifact(artifact, input.userId),
        status: "failed"
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
