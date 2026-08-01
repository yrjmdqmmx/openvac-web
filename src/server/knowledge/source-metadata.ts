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
