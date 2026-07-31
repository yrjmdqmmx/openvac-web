import { ProviderResponseError } from "./errors";
import {
  asRecord,
  loadOptionalModule,
  optionalString,
  pickString,
  requireString
} from "./runtime";
import type { ObjectStorage, PutObjectRequest, StoredObject } from "./types";

const PROVIDER_ID = "alibaba-oss";

interface OssClient {
  put(
    key: string,
    body: Buffer,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  get(key: string): Promise<unknown>;
  signatureUrlV4?: (
    method: string,
    expires: number,
    options: Record<string, unknown>,
    key: string
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
    const sdkModule = loadOptionalModule(PROVIDER_ID, "ali-oss");
    const Client = sdkModule.default ?? sdkModule;
    if (typeof Client !== "function") {
      throw new ProviderResponseError(
        PROVIDER_ID,
        "The installed ali-oss package does not expose a client constructor."
      );
    }
    this.client = new (
      Client as new (options: Record<string, unknown>) => OssClient
    )({
      region,
      bucket,
      endpoint: optionalString(this.options.endpoint),
      accessKeyId,
      accessKeySecret,
      stsToken: optionalString(this.options.securityToken),
      authorizationV4: true,
      secure: true
    });
    return this.client;
  }
}

function validateObjectKey(key: string): void {
  if (
    !key ||
    key.startsWith("/") ||
    key.includes("\0") ||
    key.split("/").includes("..")
  ) {
    throw new ProviderResponseError(PROVIDER_ID, "OSS object key is invalid.");
  }
}

let singleton: AlibabaOssStorage | undefined;

export function getObjectStorage(): ObjectStorage {
  singleton ??= new AlibabaOssStorage();
  return singleton;
}
