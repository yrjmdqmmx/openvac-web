import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { ModelingServiceClient } from "../src/server/modeling/cad-client";
import { getObjectStorage } from "../src/server/providers/oss";
import type { ObjectStorage } from "../src/server/providers/types";

const REQUIRED_ENVIRONMENT = [
  "MODELING_SERVICE_URL",
  "MODELING_SERVICE_TOKEN",
  "ALIBABA_OSS_REGION",
  "ALIBABA_OSS_BUCKET",
  "ALIBABA_OSS_ACCESS_KEY_ID",
  "ALIBABA_OSS_ACCESS_KEY_SECRET"
] as const;

const OBJECT_SIZE_BYTES = 64;
const SIGNED_URL_EXPIRY_SECONDS = 60;
const SIGNED_DOWNLOAD_TIMEOUT_MS = 10_000;

export interface ModelingRuntimeVerificationResult {
  cadReady: true;
  objectStorage: string;
  bytesVerified: number;
}

export interface ModelingRuntimeVerificationOptions {
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  objectStorage?: ObjectStorage;
  createObjectKey?: () => string;
  createObjectBody?: () => Uint8Array;
}

interface RuntimeConfiguration {
  modelingServiceUrl: string;
  modelingServiceToken: string;
}

export class ModelingRuntimeVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelingRuntimeVerificationError";
  }
}

export async function verifyModelingRuntime(
  options: ModelingRuntimeVerificationOptions = {}
): Promise<ModelingRuntimeVerificationResult> {
  const env = options.env ?? process.env;
  const configuration = readRuntimeConfiguration(env);
  const fetchFn = options.fetch ?? fetch;
  const cadClient = new ModelingServiceClient({
    baseUrl: configuration.modelingServiceUrl,
    token: configuration.modelingServiceToken,
    fetch: fetchFn
  });

  if (!(await cadClient.ready())) {
    throw new ModelingRuntimeVerificationError(
      "CAD /ready verification failed: the service is unavailable or rejected authentication."
    );
  }

  const objectStorage = options.objectStorage ?? getObjectStorage();
  const key =
    options.createObjectKey?.() ??
    `modeling/runtime-verification/${randomUUID()}.bin`;
  const body =
    options.createObjectBody?.() ??
    new Uint8Array(randomBytes(OBJECT_SIZE_BYTES));
  if (body.byteLength < 1 || body.byteLength > 4_096) {
    throw new ModelingRuntimeVerificationError(
      "Runtime verification object must contain between 1 and 4096 bytes."
    );
  }

  let operationFailure: ModelingRuntimeVerificationError | undefined;
  try {
    await verifyPrivateObjectRoundTrip(objectStorage, key, body, fetchFn);
  } catch (error) {
    operationFailure = publicStorageFailure(error);
  }

  try {
    await objectStorage.deletePrivate(key);
  } catch {
    throw new ModelingRuntimeVerificationError(
      "Private OSS cleanup failed; runtime verification did not pass."
    );
  }

  if (operationFailure) {
    throw operationFailure;
  }

  return {
    cadReady: true,
    objectStorage: objectStorage.id,
    bytesVerified: body.byteLength
  };
}

async function verifyPrivateObjectRoundTrip(
  objectStorage: ObjectStorage,
  key: string,
  body: Uint8Array,
  fetchFn: typeof fetch
): Promise<void> {
  let stored;
  try {
    stored = await objectStorage.putPrivate({
      key,
      body,
      contentType: "application/octet-stream",
      metadata: { purpose: "modeling-runtime-verification" }
    });
  } catch {
    throw new ModelingRuntimeVerificationError("Private OSS put failed.");
  }
  if (stored.key !== key) {
    throw new ModelingRuntimeVerificationError(
      "Private OSS put returned an unexpected object key."
    );
  }

  let providerBytes: Uint8Array;
  try {
    providerBytes = await objectStorage.getPrivate(key);
  } catch {
    throw new ModelingRuntimeVerificationError("Private OSS get failed.");
  }
  assertSameBytes(body, providerBytes, "Private OSS get content mismatch.");

  let signedUrlValue: string;
  try {
    signedUrlValue = await objectStorage.createPrivateDownloadUrl(
      key,
      SIGNED_URL_EXPIRY_SECONDS
    );
  } catch {
    throw new ModelingRuntimeVerificationError(
      "Private OSS signed URL creation failed."
    );
  }
  const signedUrl = parseSignedUrl(signedUrlValue);

  let response: Response;
  try {
    response = await fetchFn(signedUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(SIGNED_DOWNLOAD_TIMEOUT_MS)
    });
  } catch {
    throw new ModelingRuntimeVerificationError(
      "Private OSS signed URL download failed."
    );
  }
  if (!response.ok) {
    throw new ModelingRuntimeVerificationError(
      "Private OSS signed URL download was rejected."
    );
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) !== body.byteLength)
  ) {
    throw new ModelingRuntimeVerificationError(
      "Private OSS signed URL content length mismatch."
    );
  }

  let signedBytes: Uint8Array;
  try {
    signedBytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new ModelingRuntimeVerificationError(
      "Private OSS signed URL response was unreadable."
    );
  }
  assertSameBytes(
    body,
    signedBytes,
    "Private OSS signed URL content mismatch."
  );
}

function readRuntimeConfiguration(
  env: Readonly<Record<string, string | undefined>>
): RuntimeConfiguration {
  const missing = REQUIRED_ENVIRONMENT.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new ModelingRuntimeVerificationError(
      `Missing required runtime configuration: ${missing.join(", ")}.`
    );
  }
  return {
    modelingServiceUrl: env.MODELING_SERVICE_URL!.trim(),
    modelingServiceToken: env.MODELING_SERVICE_TOKEN!.trim()
  };
}

function parseSignedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ModelingRuntimeVerificationError(
      "Private OSS returned an invalid signed URL."
    );
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    Boolean(url.username) ||
    Boolean(url.password)
  ) {
    throw new ModelingRuntimeVerificationError(
      "Private OSS returned an unsafe signed URL."
    );
  }
  return url;
}

function assertSameBytes(
  expected: Uint8Array,
  actual: Uint8Array,
  message: string
): void {
  if (
    expected.byteLength !== actual.byteLength ||
    expected.some((byte, index) => byte !== actual[index])
  ) {
    throw new ModelingRuntimeVerificationError(message);
  }
}

function publicStorageFailure(
  error: unknown
): ModelingRuntimeVerificationError {
  return error instanceof ModelingRuntimeVerificationError
    ? error
    : new ModelingRuntimeVerificationError(
        "Private OSS runtime verification failed."
      );
}

export async function main(): Promise<void> {
  const result = await verifyModelingRuntime();
  console.log(
    `Modeling runtime verified: authenticated CAD /ready and ${result.objectStorage} private object round trip (${result.bytesVerified} bytes).`
  );
}

const executedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (executedPath === import.meta.url) {
  main().catch((error: unknown) => {
    const message =
      error instanceof ModelingRuntimeVerificationError
        ? error.message
        : "Modeling runtime verification failed unexpectedly.";
    console.error(`[openvac-modeling-runtime] ${message}`);
    process.exitCode = 1;
  });
}
