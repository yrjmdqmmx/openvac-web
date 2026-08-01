/**
 * Modeling stays closed in production until the three acceptance gates have
 * passed. Development and test builds remain usable without extra setup.
 */
export function isModelingEnabled(
  environment: Partial<
    Pick<NodeJS.ProcessEnv, "MODELING_ENABLED" | "NODE_ENV">
  > = process.env
): boolean {
  const configured = environment.MODELING_ENABLED?.trim().toLowerCase();
  if (configured !== undefined && configured !== "") {
    return configured === "true" || configured === "1";
  }
  return environment.NODE_ENV !== "production";
}
