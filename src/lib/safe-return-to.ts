const DEFAULT_RETURN_TO = "/chat";
const MAX_RETURN_TO_LENGTH = 2048;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function hasUnsafeDecodedForm(value: string) {
  let current = value;

  for (let depth = 0; depth < 4; depth += 1) {
    if (
      !current.startsWith("/") ||
      current.startsWith("//") ||
      current.includes("\\") ||
      CONTROL_CHARACTER.test(current)
    ) {
      return true;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return true;
    }

    if (decoded === current) return false;
    current = decoded;
  }

  return true;
}

export function resolveSafeReturnTo(value: string | null | undefined) {
  if (
    !value ||
    value.length > MAX_RETURN_TO_LENGTH ||
    hasUnsafeDecodedForm(value)
  ) {
    return DEFAULT_RETURN_TO;
  }

  try {
    const base = new URL("https://openvac.invalid");
    const target = new URL(value, base);

    if (
      target.origin !== base.origin ||
      !target.pathname.startsWith("/") ||
      target.pathname.startsWith("//") ||
      target.pathname.includes("\\")
    ) {
      return DEFAULT_RETURN_TO;
    }

    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}
