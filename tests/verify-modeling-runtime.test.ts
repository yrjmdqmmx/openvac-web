import { describe, expect, it, vi } from "vitest";

import {
  ModelingRuntimeVerificationError,
  verifyModelingRuntime
} from "../scripts/verify-modeling-runtime";
import type { ObjectStorage } from "../src/server/providers/types";

const completeEnvironment = {
  MODELING_SERVICE_URL: "http://modeling.internal:8080",
  MODELING_SERVICE_TOKEN: "cad-secret-token",
  ALIBABA_OSS_REGION: "cn-test",
  ALIBABA_OSS_BUCKET: "private-test",
  ALIBABA_OSS_ACCESS_KEY_ID: "oss-secret-id",
  ALIBABA_OSS_ACCESS_KEY_SECRET: "oss-secret-key"
} satisfies Readonly<Record<string, string | undefined>>;

const objectKey =
  "modeling/runtime-verification/11111111-1111-4111-8111-111111111111.bin";
const objectBody = new Uint8Array([11, 22, 33, 44]);
const signedUrl =
  "https://private-test.oss.example.test/object?signature=secret-signature";

function createStorage(overrides: Partial<ObjectStorage> = {}): ObjectStorage {
  return {
    id: "alibaba-oss",
    putPrivate: vi.fn(async ({ key }) => ({ key })),
    getPrivate: vi.fn(async () => new Uint8Array(objectBody)),
    deletePrivate: vi.fn(async () => undefined),
    createPrivateDownloadUrl: vi.fn(async () => signedUrl),
    ...overrides
  };
}

function createFetch(body = objectBody): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === "http://modeling.internal:8080/ready") {
      expect(new Headers(init?.headers).get("x-openvac-service-token")).toBe(
        completeEnvironment.MODELING_SERVICE_TOKEN
      );
      return new Response(null, { status: 204 });
    }
    if (url === signedUrl) {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { "content-length": String(body.byteLength) }
      });
    }
    throw new Error("unexpected test URL");
  });
}

function verificationOptions(
  objectStorage: ObjectStorage,
  fetchFn: typeof fetch = createFetch()
) {
  return {
    env: completeEnvironment,
    fetch: fetchFn,
    objectStorage,
    createObjectKey: () => objectKey,
    createObjectBody: () => new Uint8Array(objectBody)
  };
}

describe("modeling runtime verification", () => {
  it("authenticates CAD readiness and completes the private OSS round trip", async () => {
    const storage = createStorage();
    const fetchFn = createFetch();

    await expect(
      verifyModelingRuntime(verificationOptions(storage, fetchFn))
    ).resolves.toEqual({
      cadReady: true,
      objectStorage: "alibaba-oss",
      bytesVerified: objectBody.byteLength
    });

    expect(storage.putPrivate).toHaveBeenCalledWith({
      key: objectKey,
      body: objectBody,
      contentType: "application/octet-stream",
      metadata: { purpose: "modeling-runtime-verification" }
    });
    expect(storage.getPrivate).toHaveBeenCalledWith(objectKey);
    expect(storage.createPrivateDownloadUrl).toHaveBeenCalledWith(
      objectKey,
      60
    );
    expect(storage.deletePrivate).toHaveBeenCalledWith(objectKey);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("fails closed before network access when required configuration is missing", async () => {
    const storage = createStorage();
    const fetchFn = vi.fn<typeof fetch>();

    await expect(
      verifyModelingRuntime({
        env: {},
        fetch: fetchFn,
        objectStorage: storage
      })
    ).rejects.toThrow(/MODELING_SERVICE_URL.*ALIBABA_OSS_ACCESS_KEY_SECRET/u);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(storage.putPrivate).not.toHaveBeenCalled();
    expect(storage.deletePrivate).not.toHaveBeenCalled();
  });

  it("fails on object content mismatch and still cleans up", async () => {
    const storage = createStorage({
      getPrivate: vi.fn(async () => new Uint8Array([99]))
    });

    await expect(
      verifyModelingRuntime(verificationOptions(storage))
    ).rejects.toThrow("Private OSS get content mismatch");
    expect(storage.createPrivateDownloadUrl).not.toHaveBeenCalled();
    expect(storage.deletePrivate).toHaveBeenCalledOnce();
  });

  it("fails when the signed URL returns different content and still cleans up", async () => {
    const storage = createStorage();

    await expect(
      verifyModelingRuntime(
        verificationOptions(storage, createFetch(new Uint8Array([1, 2])))
      )
    ).rejects.toThrow(/signed URL content (length )?mismatch/u);
    expect(storage.deletePrivate).toHaveBeenCalledOnce();
  });

  it("treats cleanup failure as a failed verification without exposing secrets", async () => {
    const storage = createStorage({
      deletePrivate: vi.fn(async () => {
        throw new Error(`delete failed: ${signedUrl}`);
      })
    });

    let failure: unknown;
    try {
      await verifyModelingRuntime(verificationOptions(storage));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ModelingRuntimeVerificationError);
    expect((failure as Error).message).toBe(
      "Private OSS cleanup failed; runtime verification did not pass."
    );
    expect((failure as Error).message).not.toContain(signedUrl);
    expect((failure as Error).message).not.toContain(
      completeEnvironment.MODELING_SERVICE_TOKEN
    );
    expect((failure as Error).message).not.toContain(
      completeEnvironment.ALIBABA_OSS_ACCESS_KEY_SECRET
    );
  });
});
