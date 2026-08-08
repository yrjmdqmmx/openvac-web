const ACCOUNT_AVATAR_PATH = "/api/account/avatar";

export function safeAccountAvatarUrl(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, "https://openvac.invalid");
    if (
      url.origin !== "https://openvac.invalid" ||
      url.pathname !== ACCOUNT_AVATAR_PATH ||
      url.hash
    ) {
      return null;
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
