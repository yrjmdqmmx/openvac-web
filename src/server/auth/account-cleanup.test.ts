import { describe, expect, it, vi } from "vitest";

import {
  assertUserCanSelfDelete,
  cleanupDeletedUserAvatarBestEffort,
  DeletedUserDatabaseCleanupError,
  runDeletedUserDatabaseCleanupWithRetry
} from "./account-cleanup";

describe("account deletion policy", () => {
  it("blocks self-deletion while any administrator role remains", () => {
    expect(() => assertUserCanSelfDelete([{ role: "analyst" }])).toThrowError(
      expect.objectContaining({
        code: "ADMIN_ACCOUNT_DELETION_FORBIDDEN"
      })
    );
  });

  it("allows a regular account to continue through deletion cleanup", () => {
    expect(() => assertUserCanSelfDelete([])).not.toThrow();
  });
});

describe("deleted-user avatar cleanup", () => {
  it("contains synchronous storage construction failures", async () => {
    await expect(
      cleanupDeletedUserAvatarBestEffort("deleted-user", {
        getStorage: () => {
          throw new Error("storage construction failed");
        }
      })
    ).resolves.toBeUndefined();
  });

  it("contains asynchronous object deletion failures", async () => {
    const deletePrivate = vi.fn().mockRejectedValue(new Error("delete failed"));

    await expect(
      cleanupDeletedUserAvatarBestEffort("deleted-user", {
        getStorage: () => ({ deletePrivate }),
        objectKey: () => "account-avatars/test/avatar.webp"
      })
    ).resolves.toBeUndefined();
    expect(deletePrivate).toHaveBeenCalledExactlyOnceWith(
      "account-avatars/test/avatar.webp"
    );
  });
});

describe("post-delete database cleanup retry", () => {
  it("retries transient failures with bounded delays", async () => {
    const attempts: number[] = [];
    const delays: number[] = [];

    await runDeletedUserDatabaseCleanupWithRetry(
      async () => {
        attempts.push(attempts.length + 1);
        if (attempts.length < 3) {
          throw new Error("transient cleanup failure");
        }
      },
      {
        retryDelaysMs: [10, 20],
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        }
      }
    );

    expect(attempts).toEqual([1, 2, 3]);
    expect(delays).toEqual([10, 20]);
  });

  it("rethrows the final failure after the retry budget is exhausted", async () => {
    const failure = new Error("persistent cleanup failure");
    let attempts = 0;

    await expect(
      runDeletedUserDatabaseCleanupWithRetry(
        async () => {
          attempts += 1;
          throw failure;
        },
        {
          retryDelaysMs: [10, 20],
          sleep: async () => undefined
        }
      )
    ).rejects.toBe(failure);
    expect(attempts).toBe(3);
  });

  it("exposes only a fixed code for the final database cleanup boundary", () => {
    const cause = new Error("database response details");
    const error = new DeletedUserDatabaseCleanupError({ cause });

    expect(error).toMatchObject({
      name: "DeletedUserDatabaseCleanupError",
      code: "DELETED_USER_DATABASE_CLEANUP_FAILED",
      cause
    });
  });
});
