export function mergeSeedSourceMetadata(
  existing: Record<string, unknown> | undefined,
  seeded: Record<string, unknown>
): Record<string, unknown> {
  if (!existing) return seeded;

  return {
    ...seeded,
    ...existing,
    ...(existing.rightsDecision !== undefined
      ? { rightsDecision: existing.rightsDecision }
      : {})
  };
}

export function existingSeedSourcePatch(input: {
  existingMetadata: Record<string, unknown>;
  seededMetadata: Record<string, unknown>;
  updatedAt: Date;
}): { metadata: Record<string, unknown>; updatedAt: Date } {
  return {
    metadata: mergeSeedSourceMetadata(
      input.existingMetadata,
      input.seededMetadata
    ),
    updatedAt: input.updatedAt
  };
}
