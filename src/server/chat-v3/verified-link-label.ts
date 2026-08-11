export const VERIFIED_LINK_LABEL_FALLBACK = "已验证来源";

const MAX_VERIFIED_LINK_LABEL_UTF16_UNITS = 240;
const UNSAFE_ANSWER_VISIBLE_TEXT =
  /(?:https?:\/\/|www\.|\[[0-9]+\]|\b(?:provider|tool|tool_call|function_call|formulaId|formulaVersion|normalizedInputs|rawArguments|schemaVersion|evidenceNotice|system\s*prompt)\b|系统提示|内部提示|(?:x-amz|x-oss)-[a-z-]*signature|ossaccesskeyid|(?:signature|expires)=[^\s&]+)/iu;

export function containsUnsafeAnswerVisibleText(value: string): boolean {
  return UNSAFE_ANSWER_VISIBLE_TEXT.test(value.normalize("NFKC"));
}

export function canonicalVerifiedLinkLabel(value: string): string {
  if (value.length > 4_096 || hasUnpairedSurrogate(value)) {
    return VERIFIED_LINK_LABEL_FALLBACK;
  }
  const normalized = value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    !normalized ||
    containsUnsafeAnswerVisibleText(normalized) ||
    isUrlLikeVerifiedLinkLabel(normalized)
  ) {
    return VERIFIED_LINK_LABEL_FALLBACK;
  }
  let label = "";
  for (const character of normalized) {
    if (label.length + character.length > MAX_VERIFIED_LINK_LABEL_UTF16_UNITS) {
      break;
    }
    label += character;
  }
  const canonical = label.trim();
  return !canonical ||
    hasUnpairedSurrogate(canonical) ||
    containsUnsafeAnswerVisibleText(canonical) ||
    isUrlLikeVerifiedLinkLabel(canonical)
    ? VERIFIED_LINK_LABEL_FALLBACK
    : canonical;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isUrlLikeVerifiedLinkLabel(value: string): boolean {
  if (/\s/u.test(value)) return false;
  const candidate = value.endsWith(".") ? value.slice(0, -1) : value;
  if (!candidate || !/[./:[\]]/u.test(candidate)) return false;
  try {
    const parsed = new URL(`https://${candidate}`);
    const hostname = parsed.hostname;
    return (
      parsed.username === "" &&
      parsed.password === "" &&
      Boolean(
        hostname &&
        (hostname.includes(".") ||
          hostname.startsWith("[") ||
          /^[0-9.]+$/u.test(hostname))
      )
    );
  } catch {
    return false;
  }
}
