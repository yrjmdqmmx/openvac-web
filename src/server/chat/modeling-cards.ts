import { isModelingEnabled } from "@/server/modeling/feature-flag";
import {
  modelingRepository,
  type ModelingRepository
} from "@/server/modeling/repository";
import type { ModelingCard } from "@/types/chat";

const UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, "iu");
const PROJECT_LINK_PATTERN = new RegExp(
  `(?:^|\\s|\\(|\\[|\\{|"|'|：)\\/modeling\\?project=(${UUID_SOURCE})(?![0-9a-z&=/-])`,
  "giu"
);
const ARTIFACT_LINK_PATTERN = new RegExp(
  `(?:^|\\s|\\(|\\[|\\{|"|'|：)\\/api\\/modeling\\/artifacts\\/(${UUID_SOURCE})\\/download(?![0-9a-z/?-])`,
  "giu"
);
const MAX_CARDS = 8;

type ModelingCardRepository = Pick<
  ModelingRepository,
  "getArtifact" | "getProject"
>;

export async function resolveAuthorizedModelingCards(input: {
  ownerId: string;
  texts: readonly string[];
  repository?: ModelingCardRepository;
  enabled?: boolean;
  now?: Date;
}): Promise<ModelingCard[]> {
  const enabled = input.enabled ?? isModelingEnabled();
  if (!enabled) return [];

  const repository = input.repository ?? modelingRepository;
  const references = extractModelingReferences(input.texts);
  const now = input.now ?? new Date();
  const projects = new Map<
    string,
    ReturnType<ModelingCardRepository["getProject"]>
  >();

  const getProject = async (projectId: string) => {
    const existing = projects.get(projectId);
    if (existing) return existing;
    const pending = repository
      .getProject(input.ownerId, projectId)
      .catch(() => null);
    projects.set(projectId, pending);
    return pending;
  };

  const cards = await Promise.all(
    references.map(async (reference): Promise<ModelingCard | null> => {
      if (reference.kind === "project") {
        const project = await getProject(reference.id);
        if (!project) return null;
        return {
          kind: "project",
          projectId: project.id,
          title: project.name,
          ...(project.description ? { description: project.description } : {})
        };
      }

      const artifact = await repository
        .getArtifact(input.ownerId, reference.id)
        .catch(() => null);
      if (!artifact) return null;
      if (artifact.expiresAt && artifact.expiresAt.getTime() <= now.getTime()) {
        return null;
      }
      const project = await getProject(artifact.projectId);
      if (!project) return null;
      return {
        kind: "artifact",
        artifactId: artifact.id,
        projectId: artifact.projectId,
        title: artifact.filename,
        projectTitle: project.name,
        format: artifactFormat(artifact.filename, artifact.mimeType),
        sizeBytes: artifact.sizeBytes,
        ...(artifact.expiresAt
          ? { expiresAt: artifact.expiresAt.toISOString() }
          : {})
      };
    })
  );

  return cards.filter((card): card is ModelingCard => card !== null);
}

export function extractModelingReferences(texts: readonly string[]): Array<{
  kind: "project" | "artifact";
  id: string;
}> {
  const result: Array<{ kind: "project" | "artifact"; id: string }> = [];
  const seen = new Set<string>();

  for (const text of texts) {
    for (const [kind, pattern] of [
      ["project", PROJECT_LINK_PATTERN],
      ["artifact", ARTIFACT_LINK_PATTERN]
    ] as const) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const id = match[1]?.toLowerCase();
        if (!id || !UUID_PATTERN.test(id)) continue;
        const key = `${kind}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ kind, id });
        if (result.length >= MAX_CARDS) return result;
      }
    }
  }

  return result;
}

function artifactFormat(filename: string, mimeType: string): string {
  const extension = filename.match(/\.([a-z0-9]{1,8})$/iu)?.[1];
  if (extension) return extension.toUpperCase();
  if (mimeType === "model/gltf-binary") return "GLB";
  if (mimeType === "model/stl") return "STL";
  if (mimeType.includes("step")) return "STEP";
  return "CAD";
}
