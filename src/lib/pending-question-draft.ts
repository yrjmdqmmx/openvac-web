export const PENDING_QUESTION_DRAFT_KEY = "openvac:pending-question-draft:v1";
export const PENDING_QUESTION_DRAFT_TTL_MS = 15 * 60 * 1000;

const MAX_QUESTION_LENGTH = 4000;

export type PendingQuestionDraft = {
  version: 1;
  text: string;
  createdAt: number;
  expiresAt: number;
  ownerUserId?: string;
};

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function getSessionStorage(storage?: DraftStorage) {
  if (storage) return storage;
  if (typeof window === "undefined") return undefined;

  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function removeDraft(storage?: DraftStorage) {
  try {
    getSessionStorage(storage)?.removeItem(PENDING_QUESTION_DRAFT_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

function writeDraft(draft: PendingQuestionDraft, storage?: DraftStorage) {
  try {
    const target = getSessionStorage(storage);
    if (!target) return false;
    target.setItem(PENDING_QUESTION_DRAFT_KEY, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

function isValidDraft(
  value: unknown,
  now: number
): value is PendingQuestionDraft {
  if (!value || typeof value !== "object") return false;

  const draft = value as Partial<PendingQuestionDraft>;
  const ownerIsValid =
    draft.ownerUserId === undefined ||
    (typeof draft.ownerUserId === "string" &&
      draft.ownerUserId.length > 0 &&
      draft.ownerUserId.length <= 256);

  return (
    draft.version === 1 &&
    typeof draft.text === "string" &&
    draft.text.trim().length > 0 &&
    draft.text.length <= MAX_QUESTION_LENGTH &&
    typeof draft.createdAt === "number" &&
    Number.isFinite(draft.createdAt) &&
    typeof draft.expiresAt === "number" &&
    Number.isFinite(draft.expiresAt) &&
    draft.createdAt <= now + 60_000 &&
    draft.expiresAt > now &&
    draft.expiresAt > draft.createdAt &&
    draft.expiresAt - draft.createdAt <= PENDING_QUESTION_DRAFT_TTL_MS &&
    ownerIsValid
  );
}

export function savePendingQuestionDraft({
  text,
  ownerUserId,
  now = Date.now(),
  storage
}: {
  text: string;
  ownerUserId?: string;
  now?: number;
  storage?: DraftStorage;
}) {
  const normalizedText = text.trim();
  if (!normalizedText || normalizedText.length > MAX_QUESTION_LENGTH) {
    removeDraft(storage);
    return false;
  }

  const normalizedOwner = ownerUserId?.trim();
  const draft: PendingQuestionDraft = {
    version: 1,
    text: normalizedText,
    createdAt: now,
    expiresAt: now + PENDING_QUESTION_DRAFT_TTL_MS,
    ...(normalizedOwner ? { ownerUserId: normalizedOwner } : {})
  };

  return writeDraft(draft, storage);
}

export function loadPendingQuestionDraft({
  userId,
  now = Date.now(),
  storage
}: {
  userId: string;
  now?: number;
  storage?: DraftStorage;
}) {
  const target = getSessionStorage(storage);
  if (!target) return null;

  let parsed: unknown;
  try {
    const serialized = target.getItem(PENDING_QUESTION_DRAFT_KEY);
    if (!serialized) return null;
    parsed = JSON.parse(serialized);
  } catch {
    removeDraft(target);
    return null;
  }

  if (!isValidDraft(parsed, now)) {
    removeDraft(target);
    return null;
  }

  if (parsed.ownerUserId && parsed.ownerUserId !== userId) {
    removeDraft(target);
    return null;
  }

  if (!parsed.ownerUserId) {
    const claimed = { ...parsed, ownerUserId: userId };
    if (!writeDraft(claimed, target)) {
      removeDraft(target);
      return null;
    }
    return claimed;
  }

  return parsed;
}

export function clearPendingQuestionDraft(storage?: DraftStorage) {
  removeDraft(storage);
}
