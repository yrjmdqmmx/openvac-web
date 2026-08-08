import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import type { ObjectStorage } from "@/server/providers/types";

import {
  accountAvatarObjectKey,
  handleDeleteAccountAvatar,
  handleGetAccountAvatar,
  handleUploadAccountAvatar,
  processAvatarImage,
  type AvatarRepository
} from "./avatar";

const user = {
  id: "user-1",
  sessionId: "session-1",
  email: "user@example.test",
  emailVerified: true,
  name: "User",
  image: null,
  banned: false,
  roleHint: null
} as const;

function storage(overrides: Partial<ObjectStorage> = {}): ObjectStorage {
  return {
    id: "test-storage",
    putPrivate: vi.fn(),
    getPrivate: vi.fn(),
    deletePrivate: vi.fn(),
    createPrivateDownloadUrl: vi.fn(),
    ...overrides
  } as ObjectStorage;
}

function repository(
  overrides: Partial<AvatarRepository> = {}
): AvatarRepository {
  return {
    get: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
    ...overrides
  };
}

describe("account avatar image processing", () => {
  it("decodes an allowed image and emits a stripped 256px WebP", async () => {
    const source = await sharp({
      create: {
        width: 640,
        height: 320,
        channels: 3,
        background: { r: 20, g: 100, b: 180 }
      }
    })
      .jpeg()
      .toBuffer();

    const output = await processAvatarImage(source);
    const metadata = await sharp(output).metadata();

    expect(metadata).toMatchObject({
      format: "webp",
      width: 256,
      height: 256
    });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });

  it("rejects bytes that cannot be decoded as an image", async () => {
    await expect(
      processAvatarImage(new TextEncoder().encode("not an image"))
    ).rejects.toMatchObject({ code: "INVALID_AVATAR_IMAGE", status: 422 });
  });
});

describe("account avatar handlers", () => {
  it("stores only normalized WebP bytes under a derived user key", async () => {
    const objectStorage = storage({
      putPrivate: vi.fn(async ({ key }) => ({ key }))
    });
    const repo = repository({
      set: vi.fn(async (_userId, objectKey) => ({
        objectKey,
        revision: 4
      }))
    });
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([1, 2, 3])], "avatar.png", {
        type: "image/png"
      })
    );
    const response = await handleUploadAccountAvatar(
      new Request("https://openvac.test/api/account/avatar", {
        method: "POST",
        body: form
      }),
      repo,
      objectStorage,
      vi.fn(async () => user),
      vi.fn(async () => new Uint8Array([8, 9]))
    );

    expect(response.status).toBe(200);
    expect(objectStorage.putPrivate).toHaveBeenCalledWith({
      key: accountAvatarObjectKey(user.id),
      body: new Uint8Array([8, 9]),
      contentType: "image/webp",
      metadata: {
        purpose: "account-avatar",
        "pixel-size": "256x256"
      }
    });
    expect(repo.set).toHaveBeenCalledWith(
      user.id,
      accountAvatarObjectKey(user.id),
      expect.objectContaining({
        actor: expect.objectContaining({ role: "user" })
      })
    );
    await expect(response.json()).resolves.toEqual({
      data: { image: "/api/account/avatar", revision: 4 }
    });
  });

  it("rejects a declared non-image before reading or uploading it", async () => {
    const objectStorage = storage();
    const form = new FormData();
    form.set("file", new File(["plain"], "avatar.txt", { type: "text/plain" }));
    const response = await handleUploadAccountAvatar(
      new Request("https://openvac.test/api/account/avatar", {
        method: "POST",
        body: form
      }),
      repository(),
      objectStorage,
      vi.fn(async () => user)
    );

    expect(response.status).toBe(415);
    expect(objectStorage.putPrivate).not.toHaveBeenCalled();
  });

  it("does not erase a stable previous object when the profile update fails", async () => {
    const objectStorage = storage({
      putPrivate: vi.fn(async ({ key }) => ({ key })),
      deletePrivate: vi.fn(async () => undefined)
    });
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([1])], "avatar.png", { type: "image/png" })
    );
    const response = await handleUploadAccountAvatar(
      new Request("https://openvac.test/api/account/avatar", {
        method: "POST",
        body: form
      }),
      repository({ set: vi.fn(async () => null) }),
      objectStorage,
      vi.fn(async () => user),
      vi.fn(async () => new Uint8Array([8]))
    );

    expect(response.status).toBe(404);
    expect(objectStorage.deletePrivate).not.toHaveBeenCalled();
  });

  it("serves only the authenticated user's exact stable object key", async () => {
    const key = accountAvatarObjectKey(user.id);
    const objectStorage = storage({
      getPrivate: vi.fn(async () => new Uint8Array([1, 2, 3]))
    });
    const response = await handleGetAccountAvatar(
      new Request("https://openvac.test/api/account/avatar"),
      repository({ get: vi.fn(async () => ({ objectKey: key, revision: 2 })) }),
      objectStorage,
      vi.fn(async () => user)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(objectStorage.getPrivate).toHaveBeenCalledWith(key);
  });

  it("fails closed when a persisted object key is outside the user partition", async () => {
    const objectStorage = storage();
    const response = await handleGetAccountAvatar(
      new Request("https://openvac.test/api/account/avatar"),
      repository({
        get: vi.fn(async () => ({
          objectKey: "account-avatars/another-user/avatar.webp",
          revision: 1
        }))
      }),
      objectStorage,
      vi.fn(async () => user)
    );

    expect(response.status).toBe(404);
    expect(objectStorage.getPrivate).not.toHaveBeenCalled();
  });

  it("clears profile state and idempotently deletes the derived private object", async () => {
    const objectStorage = storage({
      deletePrivate: vi.fn(async () => undefined)
    });
    const repo = repository({ clear: vi.fn(async () => true) });
    const response = await handleDeleteAccountAvatar(
      new Request("https://openvac.test/api/account/avatar", {
        method: "DELETE"
      }),
      repo,
      objectStorage,
      vi.fn(async () => user)
    );

    expect(response.status).toBe(200);
    expect(objectStorage.deletePrivate).toHaveBeenCalledWith(
      accountAvatarObjectKey(user.id)
    );
    await expect(response.json()).resolves.toEqual({ data: { image: null } });
  });
});
