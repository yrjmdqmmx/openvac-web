import { describe, expect, it } from "vitest";
import {
  clearPendingQuestionDraft,
  loadPendingQuestionDraft,
  PENDING_QUESTION_DRAFT_KEY,
  PENDING_QUESTION_DRAFT_TTL_MS,
  savePendingQuestionDraft
} from "@/lib/pending-question-draft";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("pending question draft", () => {
  it("claims a pre-login draft for the first authenticated account", () => {
    const storage = new MemoryStorage();
    expect(
      savePendingQuestionDraft({
        text: "  如何排查抽速下降？  ",
        now: 1_000,
        storage
      })
    ).toBe(true);

    expect(
      loadPendingQuestionDraft({ userId: "user-a", now: 2_000, storage })
    ).toMatchObject({
      text: "如何排查抽速下降？",
      ownerUserId: "user-a"
    });
  });

  it("clears a draft when another account tries to load it", () => {
    const storage = new MemoryStorage();
    savePendingQuestionDraft({
      text: "待确认的问题",
      ownerUserId: "user-a",
      now: 1_000,
      storage
    });

    expect(
      loadPendingQuestionDraft({ userId: "user-b", now: 2_000, storage })
    ).toBeNull();
    expect(storage.getItem(PENDING_QUESTION_DRAFT_KEY)).toBeNull();
  });

  it("clears expired and malformed drafts without returning their text", () => {
    const storage = new MemoryStorage();
    savePendingQuestionDraft({
      text: "已过期的问题",
      now: 1_000,
      storage
    });

    expect(
      loadPendingQuestionDraft({
        userId: "user-a",
        now: 1_000 + PENDING_QUESTION_DRAFT_TTL_MS,
        storage
      })
    ).toBeNull();

    storage.setItem(PENDING_QUESTION_DRAFT_KEY, "{");
    expect(
      loadPendingQuestionDraft({ userId: "user-a", now: 2_000, storage })
    ).toBeNull();
  });

  it("supports explicit clearing on sign out or discard", () => {
    const storage = new MemoryStorage();
    savePendingQuestionDraft({ text: "草稿", now: 1_000, storage });
    clearPendingQuestionDraft(storage);
    expect(storage.getItem(PENDING_QUESTION_DRAFT_KEY)).toBeNull();
  });
});
