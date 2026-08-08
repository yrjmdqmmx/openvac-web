import OSS from "ali-oss";

import { ProviderResponseError } from "./errors";
import { asRecord, optionalString, pickString, requireString } from "./runtime";
import type {
  CreatePrivateUploadUrlRequest,
  ObjectStorage,
  PrivateObjectStat,
  PrivateUploadUrl,
  PutObjectRequest,
  StoredObject
} from "./types";

const PROVIDER_ID = "alibaba-oss";

interface OssClient {
  put(
    key: string,
    body: Buffer,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  get(key: string): Promise<unknown>;
  delete(key: string, options?: Record<string, unknown>): Promise<unknown>;
  head?(key: string, options?: Record<string, unknown>): Promise<unknown>;
  getObjectMeta?(
    key: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  signatureUrlV4?: (
    method: string,
    expires: number,
    options: Record<string, unknown>,
    key: string,
    additionalHeaders?: string[]
  ) => Promise<string> | string;
  signatureUrl?: (
    key: string,
    options: Record<string, unknown>
  ) => Promise<string> | string;
}

export interface OssStorageOptions {
  region?: string;
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  securityToken?: string;
}

export class AlibabaOssStorage implements ObjectStorage {
  readonly id = PROVIDER_ID;

  private readonly options: OssStorageOptions;
  private client?: OssClient;

  constructor(options: OssStorageOptions = {}) {
    this.options = {
      region: options.region ?? process.env.ALIBABA_OSS_REGION,
      endpoint: options.endpoint ?? process.env.ALIBABA_OSS_ENDPOINT,
      bucket: options.bucket ?? process.env.ALIBABA_OSS_BUCKET,
      accessKeyId: options.accessKeyId ?? process.env.ALIBABA_OSS_ACCESS_KEY_ID,
      accessKeySecret:
        options.accessKeySecret ?? process.env.ALIBABA_OSS_ACCESS_KEY_SECRET,
      securityToken:
        options.securityToken ?? process.env.ALIBABA_OSS_SECURITY_TOKEN
    };
  }

  async putPrivate(request: PutObjectRequest): Promise<StoredObject> {
    validateObjectKey(request.key);
    const client = this.getClient();
    const result = asRecord(
      await client.put(
        request.key,
        Buffer.from(
          typeof request.body === "string"
            ? new TextEncoder().encode(request.body)
            : request.body
        ),
        {
          headers: {
            "x-oss-object-acl": "private",
            ...(request.contentType
              ? { "Content-Type": request.contentType }
              : {})
          },
          meta: request.metadata
        }
      )
    );
    const response = asRecord(result.res);
    return {
      key: request.key,
      etag:
        pickString(result, ["etag"]) ??
        pickString(asRecord(response.headers), ["etag"]),
      url: pickString(result, ["url"])
    };
  }

  async getPrivate(key: string): Promise<Uint8Array> {
    validateObjectKey(key);
    const result = asRecord(await this.getClient().get(key));
    const content = result.content;
    if (!(content instanceof Uint8Array) && typeof content !== "string") {
      throw new ProviderResponseError(
        PROVIDER_ID,
        "OSS returned an object without readable content.",
        { retryable: true }
      );
    }
    return typeof content === "string"
      ? new TextEncoder().encode(content)
      : new Uint8Array(content);
  }

  async deletePrivate(key: string): Promise<void> {
    validateObjectKey(key);
    try {
      await this.getClient().delete(key);
    } catch (cause) {
      const { code, status } = providerFailure(cause);
      if (status === 404 || code === "NoSuchKey" || code === "NoSuchObject") {
        return;
      }
      throw new ProviderResponseError(
        PROVIDER_ID,
        "OSS failed to delete the private object.",
        {
          status,
          retryable:
            status === undefined ||
            status === 408 ||
            status === 429 ||
            status >= 500,
          cause
        }
      );
    }
  }

  async createPrivateDownloadUrl(
    key: string,
    expiresSeconds = 300
  ): Promise<string> {
    validateObjectKey(key);
    if (
      !Number.isInteger(expiresSeconds) ||
      expiresSeconds < 1 ||
      expiresSeconds > 3600
    ) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        "Private download URL expiry must be between 1 and 3600 seconds."
      );
    }
    const client = this.getClient();
    if (client.signatureUrlV4) {
      return await client.signatureUrlV4(
        "GET",
        expiresSeconds,
        { headers: {}, queries: {} },
        key
      );
    }
    if (client.signatureUrl) {
      return await client.signatureUrl(key, {
        expires: expiresSeconds,
        method: "GET"
      });
    }
    throw new ProviderResponseError(
      PROVIDER_ID,
      "The installed ali-oss client cannot create signed URLs."
    );
  }

  async createPrivateUploadUrl(
    request: CreatePrivateUploadUrlRequest
  ): Promise<PrivateUploadUrl> {
    validateObjectKey(request.key);
    validateUploadRequest(request);

    const expiresSeconds = request.expiresSeconds ?? 900;
    const metadata = normalizeUploadMetadata({
      ...request.metadata,
      sha256: request.checksumSha256,
      "size-bytes": String(request.contentLength)
    });
    const requiredHeaders: Record<string, string> = {
      "Content-Type": request.contentType,
      "x-oss-object-acl": "private",
      "x-oss-forbid-overwrite": "true",
      ...Object.fromEntries(
        Object.entries(metadata).map(([key, value]) => [
          `x-oss-meta-${key}`,
          value
        ])
      )
    };

    const client = this.getClient();
    let url: string;
    if (client.signatureUrlV4) {
      // ali-oss includes content-type and all x-oss-* headers in the V4
      // canonical request. Content-Length is deliberately omitted because
      // browser JavaScript cannot set that forbidden request header.
      url = await client.signatureUrlV4(
        "PUT",
        expiresSeconds,
        { headers: requiredHeaders, queries: {} },
        request.key
      );
    } else if (client.signatureUrl) {
      // The legacy signer includes Content-Type and x-oss-* metadata. The
      // signed size-bytes metadata plus completion-time stat preserves the
      // size invariant when V4 is unavailable.
      url = await client.signatureUrl(request.key, {
        expires: expiresSeconds,
        method: "PUT",
        ...requiredHeaders
      });
    } else {
      throw new ProviderResponseError(
        PROVIDER_ID,
        "The installed ali-oss client cannot create signed upload URLs."
      );
    }

    return {
      key: request.key,
      method: "PUT",
      url,
      requiredHeaders,
      expiresAt: new Date(Date.now() + expiresSeconds * 1_000).toISOString()
    };
  }

  async statPrivate(key: string): Promise<PrivateObjectStat> {
    validateObjectKey(key);
    const client = this.getClient();
    if (!client.head && !client.getObjectMeta) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        "The installed ali-oss client cannot inspect private objects."
      );
    }

    try {
      const [objectMetaResult, headResult] = await Promise.all([
        client.getObjectMeta?.(key),
        client.head?.(key)
      ]);
      const objectMeta = asRecord(objectMetaResult);
      const head = asRecord(headResult);
      const objectMetaHeaders = asRecord(asRecord(objectMeta.res).headers);
      const headHeaders = asRecord(asRecord(head.res).headers);
      const headers = { ...headHeaders, ...objectMetaHeaders };
      const sizeBytes = parseStoredObjectSize(headers);
      const metadata = {
        ...metadataFromHeaders(headHeaders),
        ...metadataFromHeaders(objectMetaHeaders),
        ...normalizeReturnedMetadata(asRecord(head.meta))
      };

      return {
        key,
        sizeBytes,
        etag: headerString(headers, "etag"),
        contentType: headerString(headers, "content-type"),
        metadata,
        lastModified: headerString(headers, "last-modified")
      };
    } catch (cause) {
      if (cause instanceof ProviderResponseError) {
        throw cause;
      }
      const { status } = providerFailure(cause);
      throw new ProviderResponseError(
        PROVIDER_ID,
        "OSS failed to inspect the private object.",
        {
          status,
          retryable: status === undefined || status >= 500,
          cause
        }
      );
    }
  }

  private getClient(): OssClient {
    if (this.client) {
      return this.client;
    }
    const region = requireString(
      PROVIDER_ID,
      "ALIBABA_OSS_REGION",
      this.options.region
    );
    const bucket = requireString(
      PROVIDER_ID,
      "ALIBABA_OSS_BUCKET",
      this.options.bucket
    );
    const accessKeyId = requireString(
      PROVIDER_ID,
      "ALIBABA_OSS_ACCESS_KEY_ID",
      this.options.accessKeyId
    );
    const accessKeySecret = requireString(
      PROVIDER_ID,
      "ALIBABA_OSS_ACCESS_KEY_SECRET",
      this.options.accessKeySecret
    );
    this.client = new OSS({
      region,
      bucket,
      endpoint: optionalString(this.options.endpoint),
      accessKeyId,
      accessKeySecret,
      stsToken: optionalString(this.options.securityToken),
      authorizationV4: true,
      secure: true
    }) as unknown as OssClient;
    return this.client;
  }
}

function validateObjectKey(key: string): void {
  const segments = key.split("/");
  if (
    !key ||
    key.length > 1_024 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(key) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new ProviderResponseError(PROVIDER_ID, "OSS object key is invalid.");
  }
}

function providerFailure(cause: unknown): {
  code?: string;
  status?: number;
} {
  const causeRecord = asRecord(cause);
  const response = asRecord(causeRecord.res);
  const rawStatus =
    causeRecord.status ?? causeRecord.statusCode ?? response.status;
  const status =
    typeof rawStatus === "number" && Number.isFinite(rawStatus)
      ? rawStatus
      : typeof rawStatus === "string" && /^\d{3}$/u.test(rawStatus)
        ? Number(rawStatus)
        : undefined;
  const code = pickString(causeRecord, ["code", "name"]);
  return { code, status };
}

function validateUploadRequest(request: CreatePrivateUploadUrlRequest): void {
  if (
    !Number.isSafeInteger(request.contentLength) ||
    request.contentLength <= 0
  ) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "Private upload content length must be a positive safe integer."
    );
  }
  if (!/^[0-9a-f]{64}$/.test(request.checksumSha256)) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "Private upload SHA-256 must be lowercase hexadecimal."
    );
  }
  if (
    !request.contentType.trim() ||
    /[\r\n]/.test(request.contentType) ||
    request.contentType.length > 255
  ) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "Private upload content type is invalid."
    );
  }
  const expiresSeconds = request.expiresSeconds ?? 900;
  if (
    !Number.isInteger(expiresSeconds) ||
    expiresSeconds < 1 ||
    expiresSeconds > 3600
  ) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "Private upload URL expiry must be between 1 and 3600 seconds."
    );
  }
  normalizeUploadMetadata(request.metadata ?? {});
}

function normalizeUploadMetadata(
  metadata: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([rawKey, value]) => {
      const key = rawKey.toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(key)) {
        throw new ProviderResponseError(
          PROVIDER_ID,
          `OSS metadata key is invalid: ${rawKey}`
        );
      }
      if (
        typeof value !== "string" ||
        value.length > 1_024 ||
        /[\r\n]/.test(value)
      ) {
        throw new ProviderResponseError(
          PROVIDER_ID,
          `OSS metadata value is invalid: ${rawKey}`
        );
      }
      return [key, value];
    })
  );
}

function parseStoredObjectSize(headers: Record<string, unknown>): number {
  const raw = headerString(headers, "content-length");
  const size = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "OSS object metadata did not include a valid content length.",
      { retryable: true }
    );
  }
  return size;
}

function metadataFromHeaders(
  headers: Record<string, unknown>
): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (!key.startsWith("x-oss-meta-") || typeof rawValue !== "string") {
      continue;
    }
    metadata[key.slice("x-oss-meta-".length)] = rawValue;
  }
  return metadata;
}

function normalizeReturnedMetadata(
  metadata: Record<string, unknown>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
      .map(([key, value]) => [key.toLowerCase(), value])
  );
}

function headerString(
  headers: Record<string, unknown>,
  wantedKey: string
): string | undefined {
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === wantedKey
  );
  if (!match) {
    return undefined;
  }
  return typeof match[1] === "string" || typeof match[1] === "number"
    ? String(match[1])
    : undefined;
}

let singleton: AlibabaOssStorage | undefined;

export function getObjectStorage(): ObjectStorage {
  singleton ??= new AlibabaOssStorage();
  return singleton;
}
