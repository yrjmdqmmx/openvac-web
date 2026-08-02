import { describe, expect, it } from "vitest";
import {
  clearPendingQuestionDraft,
  consumeLegacyPendingQuestionDraft,
  consumePendingQuestionIntent,
  loadPendingQuestionDraft,
  PENDING_QUESTION_DRAFT_KEY,
  PENDING_QUESTION_DRAFT_TTL_MS,
  PENDING_QUESTION_INTENT_KEY,
  PENDING_QUESTION_INTENT_TTL_MS,
  savePendingQuestionDraft,
  savePendingQuestionIntent
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

  it("migrates a valid v1 draft into the ordinary composer exactly once", () => {
    const storage = new MemoryStorage();
    savePendingQuestionDraft({
      text: "旧版草稿",
      ownerUserId: "user-a",
      now: 1_000,
      storage
    });

    expect(
      consumeLegacyPendingQuestionDraft({
        userId: "user-a",
        now: 2_000,
        storage
      })
    ).toMatchObject({ text: "旧版草稿" });
    expect(storage.getItem(PENDING_QUESTION_DRAFT_KEY)).toBeNull();
    expect(
      consumeLegacyPendingQuestionDraft({
        userId: "user-a",
        now: 2_000,
        storage
      })
    ).toBeNull();
  });
});

describe("pending question send intent v2", () => {
  it("saves and atomically consumes an unbound pre-login intent", () => {
    const storage = new MemoryStorage();
    expect(
      savePendingQuestionIntent({
        text: "  登录后直接发送这个问题  ",
        now: 1_000,
        storage
      })
    ).toBe(true);

    expect(
      consumePendingQuestionIntent({
        userId: "user-a",
        now: 2_000,
        storage
      })
    ).toMatchObject({
      version: 2,
      intent: "send",
      text: "登录后直接发送这个问题"
    });
    expect(storage.getItem(PENDING_QUESTION_INTENT_KEY)).toBeNull();
    expect(
      consumePendingQuestionIntent({
        userId: "user-a",
        now: 2_000,
        storage
      })
    ).toBeNull();
  });

  it("consumes an owner-bound intent only for the matching account", () => {
    const storage = new MemoryStorage();
    savePendingQuestionIntent({
      text: "属于用户 A 的问题",
      ownerUserId: "user-a",
      now: 1_000,
      storage
    });

    expect(
      consumePendingQuestionIntent({
        userId: "user-a",
        now: 2_000,
        storage
      })
    ).toMatchObject({ ownerUserId: "user-a" });
  });

  it("clears an account-mismatched intent without exposing its text", () => {
    const storage = new MemoryStorage();
    savePendingQuestionIntent({
      text: "属于用户 A 的问题",
      ownerUserId: "user-a",
      now: 1_000,
      storage
    });

    expect(
      consumePendingQuestionIntent({
        userId: "user-b",
        now: 2_000,
        storage
      })
    ).toBeNull();
    expect(storage.getItem(PENDING_QUESTION_INTENT_KEY)).toBeNull();
  });

  it("clears expired, malformed, and illegal intents", () => {
    const storage = new MemoryStorage();
    savePendingQuestionIntent({
      text: "已经过期的问题",
      now: 1_000,
      storage
    });

    expect(
      consumePendingQuestionIntent({
        userId: "user-a",
        now: 1_000 + PENDING_QUESTION_INTENT_TTL_MS,
        storage
      })
    ).toBeNull();

    storage.setItem(PENDING_QUESTION_INTENT_KEY, "{");
    expect(
      consumePendingQuestionIntent({ userId: "user-a", now: 2_000, storage })
    ).toBeNull();

    storage.setItem(
      PENDING_QUESTION_INTENT_KEY,
      JSON.stringify({
        version: 2,
        intent: "preview",
        text: "非法意图",
        createdAt: 1_000,
        expiresAt: 2_000
      })
    );
    expect(
      consumePendingQuestionIntent({ userId: "user-a", now: 1_500, storage })
    ).toBeNull();
  });

  it("fails closed when session storage is unavailable", () => {
    const unavailable = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      }
    };

    expect(
      savePendingQuestionIntent({
        text: "无法保存的问题",
        storage: unavailable
      })
    ).toBe(false);
    expect(
      consumePendingQuestionIntent({
        userId: "user-a",
        storage: unavailable
      })
    ).toBeNull();
  });
});
