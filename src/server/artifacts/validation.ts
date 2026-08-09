import type { ArtifactSpec } from "@/types/chat-v3";
import { artifactSpecSchema } from "@/server/chat-v3/contracts";

const MAX_ARTIFACT_TEXT_CHARACTERS = 2_000_000;
const DISALLOWED_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export class ArtifactSpecValidationError extends Error {
  readonly code = "ARTIFACT_SPEC_INVALID";

  constructor(readonly issues: string[]) {
    super(`ArtifactSpec validation failed: ${issues.join("; ")}`);
    this.name = "ArtifactSpecValidationError";
  }
}

export function parseArtifactSpec(input: unknown): ArtifactSpec {
  const result = artifactSpecSchema.safeParse(input);
  if (!result.success) {
    throw new ArtifactSpecValidationError(
      result.error.issues.map(
        (issue) =>
          `${issue.path.length > 0 ? issue.path.join(".") : "spec"}: ${issue.message}`
      )
    );
  }

  const strings = collectArtifactStrings(result.data);
  const totalCharacters = strings.reduce(
    (total, value) => total + value.length,
    0
  );
  const controlCharacterPath = strings.findIndex((value) =>
    DISALLOWED_CONTROL_CHARACTERS.test(value)
  );

  if (totalCharacters > MAX_ARTIFACT_TEXT_CHARACTERS) {
    throw new ArtifactSpecValidationError([
      `spec: artifact text exceeds ${MAX_ARTIFACT_TEXT_CHARACTERS} characters`
    ]);
  }
  if (controlCharacterPath >= 0) {
    throw new ArtifactSpecValidationError([
      `spec: disallowed control character in text item ${controlCharacterPath}`
    ]);
  }

  return result.data;
}

function collectArtifactStrings(spec: ArtifactSpec): string[] {
  return [
    spec.title,
    spec.summary,
    ...spec.sections.flatMap((section) => [
      section.heading,
      ...section.paragraphs
    ]),
    ...spec.tables.flatMap((table) => [
      ...(table.title ? [table.title] : []),
      ...table.columns,
      ...table.rows.flat()
    ])
  ];
}
