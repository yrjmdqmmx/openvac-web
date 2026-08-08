export interface BanState {
  banned?: boolean | null;
  banExpires?: Date | string | null;
}

export type BanDisposition = "allow" | "block" | "clear";

export function banDisposition(
  state: BanState,
  now: Date = new Date()
): BanDisposition {
  if (!state.banned) return "allow";
  if (!state.banExpires) return "block";

  const expiresAt =
    state.banExpires instanceof Date
      ? state.banExpires.getTime()
      : new Date(state.banExpires).getTime();

  return !Number.isFinite(expiresAt) || expiresAt > now.getTime()
    ? "block"
    : "clear";
}

export function isEffectiveBan(
  state: BanState,
  now: Date = new Date()
): boolean {
  return banDisposition(state, now) === "block";
}
