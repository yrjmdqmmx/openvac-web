import { describe, expect, it, vi } from "vitest";

import { ProviderResponseError } from "./errors";
import { AlibabaOssStorage } from "./oss";

function storageWithClient(client: Record<string, unknown>): AlibabaOssStorage {
  const storage = new AlibabaOssStorage({
    region: "cn-test",
    bucket: "private-test",
    accessKeyId: "test-id",
    accessKeySecret: "test-secret"
  });
  Object.defineProperty(storage, "client", {
    configurable: true,
    value: {
      put: vi.fn(),
      get: vi.fn(),
      ...client
    }
  });
  return storage;
}

describe("AlibabaOssStorage private uploads", () => {
  it("prefers OSS V4 and binds content type, length and checksum metadata", async () => {
    const signatureUrlV4 = vi.fn(async () => "https://oss.test/signed-v4");
    const signatureUrl = vi.fn(() => "https://oss.test/legacy");
    const storage = storageWithClient({ signatureUrlV4, signatureUrl });

    const result = await storage.createPrivateUploadUrl({
      key: "modeling/user/project/imports/model.step",
      contentType: "model/step",
      contentLength: 1_024,
      checksumSha256: "a".repeat(64),
      metadata: { "project-id": "project" },
      expiresSeconds: 600
    });

    expect(signatureUrl).not.toHaveBeenCalled();
    expect(signatureUrlV4).toHaveBeenCalledWith(
      "PUT",
      600,
      {
        headers: expect.objectContaining({
          "Content-Type": "model/step",
          "Content-Length": "1024",
          "x-oss-object-acl": "private",
          "x-oss-forbid-overwrite": "true",
          "x-oss-meta-sha256": "a".repeat(64),
          "x-oss-meta-size-bytes": "1024",
          "x-oss-meta-project-id": "project"
        }),
        queries: {}
      },
      "modeling/user/project/imports/model.step",
      ["content-length"]
    );
    expect(result).toMatchObject({
      key: "modeling/user/project/imports/model.step",
      method: "PUT",
      url: "https://oss.test/signed-v4",
      requiredHeaders: {
        "Content-Type": "model/step",
        "Content-Length": "1024",
        "x-oss-object-acl": "private",
        "x-oss-forbid-overwrite": "true",
        "x-oss-meta-project-id": "project",
        "x-oss-meta-sha256": "a".repeat(64),
        "x-oss-meta-size-bytes": "1024"
      }
    });
  });

  it("binds forbid-overwrite in the legacy signed PUT path", async () => {
    const signatureUrl = vi.fn(() => "https://oss.test/legacy");
    const storage = storageWithClient({ signatureUrl });

    const result = await storage.createPrivateUploadUrl({
      key: "private/knowledge-originals/document/version/manual.pdf",
      contentType: "application/pdf",
      contentLength: 10,
      checksumSha256: "a".repeat(64)
    });

    expect(signatureUrl).toHaveBeenCalledWith(
      "private/knowledge-originals/document/version/manual.pdf",
      expect.objectContaining({
        method: "PUT",
        "x-oss-forbid-overwrite": "true"
      })
    );
    expect(result.requiredHeaders["x-oss-forbid-overwrite"]).toBe("true");
  });

  it("reads the authoritative size and user metadata from OSS", async () => {
    const storage = storageWithClient({
      getObjectMeta: vi.fn(async () => ({
        res: {
          headers: {
            "content-length": "2048",
            etag: '"etag-1"',
            "content-type": "model/step",
            "last-modified": "Sat, 01 Aug 2026 00:00:00 GMT"
          }
        }
      })),
      head: vi.fn(async () => ({
        meta: {
          sha256: "b".repeat(64),
          "size-bytes": "2048",
          "project-id": "project"
        },
        res: { headers: { "content-length": "999" } }
      }))
    });

    await expect(
      storage.statPrivate("modeling/user/project/imports/model.step")
    ).resolves.toEqual({
      key: "modeling/user/project/imports/model.step",
      sizeBytes: 2_048,
      etag: '"etag-1"',
      contentType: "model/step",
      metadata: {
        sha256: "b".repeat(64),
        "size-bytes": "2048",
        "project-id": "project"
      },
      lastModified: "Sat, 01 Aug 2026 00:00:00 GMT"
    });
  });

  it("deletes a validated private key and treats missing objects as success", async () => {
    const deleteObject = vi
      .fn()
      .mockResolvedValueOnce({ status: 204 })
      .mockRejectedValueOnce({ status: 404, code: "NoSuchKey" });
    const storage = storageWithClient({ delete: deleteObject });
    const key = "modeling/user/project/preview/model.glb";

    await expect(storage.deletePrivate(key)).resolves.toBeUndefined();
    await expect(storage.deletePrivate(key)).resolves.toBeUndefined();
    expect(deleteObject).toHaveBeenNthCalledWith(1, key);
    expect(deleteObject).toHaveBeenNthCalledWith(2, key);
  });

  it("rejects unsafe delete keys before contacting OSS", async () => {
    const deleteObject = vi.fn();
    const storage = storageWithClient({ delete: deleteObject });

    await expect(
      storage.deletePrivate("modeling/user/../other/model.glb")
    ).rejects.toBeInstanceOf(ProviderResponseError);
    await expect(
      storage.deletePrivate("modeling//project/model.glb")
    ).rejects.toBeInstanceOf(ProviderResponseError);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("maps OSS delete failures with status and retryability", async () => {
    const cause = { statusCode: 503, code: "ServiceUnavailable" };
    const storage = storageWithClient({
      delete: vi.fn().mockRejectedValue(cause)
    });

    await expect(
      storage.deletePrivate("modeling/user/project/model.glb")
    ).rejects.toMatchObject({
      provider: "alibaba-oss",
      status: 503,
      retryable: true,
      cause
    });
  });
});
