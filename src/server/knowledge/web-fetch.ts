import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage, RequestOptions } from "node:http";

import { ProviderResponseError, ProviderTimeoutError } from "../providers";
import {
  createProviderDeadline,
  hostnameAllowed,
  normalizeDomain
} from "../providers/runtime";

const PROVIDER_ID = "safe-web-fetch";
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 12_000;
const DEFAULT_DNS_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_REDIRECTS = 3;
const ALLOWED_CONTENT_TYPES = new Set([
  "text/html",
  "text/plain",
  "application/xhtml+xml",
  "application/json"
]);

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type DnsResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type HttpsRequester = typeof httpsRequest;

export interface SafeWebFetcherOptions {
  allowedDomains: string[];
  maxBytes?: number;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  dnsTimeoutMs?: number;
  maxRedirects?: number;
  resolveDns?: DnsResolver;
  request?: HttpsRequester;
}

export interface SafeWebFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  fetchedAt: Date;
}

interface SingleRequestResult {
  status: number;
  contentType?: string;
  body?: Buffer;
  redirect?: string;
}

export class SafeWebFetcher {
  private readonly allowedDomains: string[];
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly dnsTimeoutMs: number;
  private readonly maxRedirects: number;
  private readonly resolveDns: DnsResolver;
  private readonly requester: HttpsRequester;

  constructor(options: SafeWebFetcherOptions) {
    this.allowedDomains = [
      ...new Set(options.allowedDomains.map(normalizeDomain).filter(Boolean))
    ];
    this.maxBytes = positiveInteger(
      options.maxBytes,
      DEFAULT_MAX_BYTES,
      "maxBytes"
    );
    this.timeoutMs = positiveInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      "timeoutMs"
    );
    this.totalTimeoutMs = positiveInteger(
      options.totalTimeoutMs,
      DEFAULT_TOTAL_TIMEOUT_MS,
      "totalTimeoutMs"
    );
    this.dnsTimeoutMs = positiveInteger(
      options.dnsTimeoutMs,
      DEFAULT_DNS_TIMEOUT_MS,
      "dnsTimeoutMs"
    );
    this.maxRedirects = nonNegativeInteger(
      options.maxRedirects,
      DEFAULT_MAX_REDIRECTS,
      "maxRedirects"
    );
    this.resolveDns = options.resolveDns ?? defaultResolver;
    this.requester = options.request ?? httpsRequest;
  }

  async fetch(
    input: string | URL,
    signal?: AbortSignal
  ): Promise<SafeWebFetchResult> {
    if (this.allowedDomains.length === 0) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        "Safe web fetch requires a non-empty domain whitelist."
      );
    }
    const deadline = createProviderDeadline(
      PROVIDER_ID,
      this.totalTimeoutMs,
      signal
    );

    try {
      let current = validateFetchUrl(input, this.allowedDomains);
      const visited = new Set<string>();

      for (
        let redirectCount = 0;
        redirectCount <= this.maxRedirects;
        redirectCount += 1
      ) {
        if (visited.has(current.href)) {
          throw new ProviderResponseError(
            PROVIDER_ID,
            "Redirect loop detected."
          );
        }
        visited.add(current.href);
        const addresses = await withTimeout(
          this.resolveDns(current.hostname),
          this.dnsTimeoutMs,
          "DNS resolution timed out.",
          deadline.signal
        );
        assertSafeResolvedAddresses(current.hostname, addresses);
        const selected = addresses[0];
        if (!selected) {
          throw new ProviderResponseError(
            PROVIDER_ID,
            "DNS returned no address.",
            { retryable: true }
          );
        }

        const response = await this.requestOnce(
          current,
          selected,
          deadline.signal
        );
        if (response.redirect) {
          if (redirectCount === this.maxRedirects) {
            throw new ProviderResponseError(
              PROVIDER_ID,
              `Redirect limit of ${this.maxRedirects} exceeded.`
            );
          }
          current = validateFetchUrl(
            new URL(response.redirect, current),
            this.allowedDomains
          );
          continue;
        }
        const body = response.body;
        const contentType = response.contentType;
        if (!body || !contentType) {
          throw new ProviderResponseError(
            PROVIDER_ID,
            "HTTPS response did not contain a readable body.",
            { retryable: true }
          );
        }
        return {
          url: current.href,
          status: response.status,
          contentType,
          body: new TextDecoder("utf-8").decode(body),
          bytes: body.byteLength,
          fetchedAt: new Date()
        };
      }

      throw new ProviderResponseError(
        PROVIDER_ID,
        "Web fetch did not reach a terminal response."
      );
    } catch (cause) {
      if (deadline.didTimeout()) {
        throw deadline.timeoutError;
      }
      throw cause;
    } finally {
      deadline.dispose();
    }
  }

  private requestOnce(
    url: URL,
    address: ResolvedAddress,
    signal?: AbortSignal
  ): Promise<SingleRequestResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        callback();
      };
      const options: RequestOptions = {
        method: "GET",
        headers: {
          Accept:
            "text/html,application/xhtml+xml,text/plain,application/json;q=0.8",
          "Accept-Encoding": "identity",
          "User-Agent": "OpenVacEvidenceFetcher/1.0"
        },
        agent: false,
        signal,
        lookup: createPinnedLookup(address)
      };
      const request = this.requester(
        url,
        options,
        (response: IncomingMessage) => {
          const status = response.statusCode ?? 0;
          const location = headerValue(response.headers.location);

          if (status >= 300 && status < 400 && location) {
            response.destroy();
            finish(() => resolve({ status, redirect: location }));
            return;
          }
          if (status < 200 || status >= 300) {
            response.destroy();
            finish(() =>
              reject(
                new ProviderResponseError(
                  PROVIDER_ID,
                  `Evidence URL returned HTTP ${status}.`,
                  {
                    status,
                    retryable: status >= 500
                  }
                )
              )
            );
            return;
          }
          const contentEncoding = headerValue(
            response.headers["content-encoding"]
          );
          if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
            response.destroy();
            finish(() =>
              reject(
                new ProviderResponseError(
                  PROVIDER_ID,
                  "Compressed responses are refused to enforce the byte limit."
                )
              )
            );
            return;
          }
          const contentType = normalizeContentType(
            headerValue(response.headers["content-type"])
          );
          if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
            response.destroy();
            finish(() =>
              reject(
                new ProviderResponseError(
                  PROVIDER_ID,
                  `Unsupported response content type: ${
                    contentType || "missing"
                  }.`
                )
              )
            );
            return;
          }
          const declaredLength = Number(
            headerValue(response.headers["content-length"])
          );
          if (
            Number.isFinite(declaredLength) &&
            declaredLength > this.maxBytes
          ) {
            response.destroy();
            finish(() =>
              reject(
                new ProviderResponseError(
                  PROVIDER_ID,
                  `Response exceeds the ${this.maxBytes}-byte limit.`
                )
              )
            );
            return;
          }

          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer | string) => {
            if (settled) {
              return;
            }
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.byteLength;
            if (bytes > this.maxBytes) {
              response.destroy();
              finish(() =>
                reject(
                  new ProviderResponseError(
                    PROVIDER_ID,
                    `Response exceeds the ${this.maxBytes}-byte limit.`
                  )
                )
              );
              return;
            }
            chunks.push(buffer);
          });
          response.on("end", () => {
            finish(() =>
              resolve({
                status,
                contentType,
                body: Buffer.concat(chunks, bytes)
              })
            );
          });
          response.on("error", (cause) => {
            finish(() =>
              reject(
                new ProviderResponseError(
                  PROVIDER_ID,
                  "HTTPS response stream failed.",
                  { retryable: true, cause }
                )
              )
            );
          });
        }
      );
      request.setTimeout(this.timeoutMs, () => {
        const error = new ProviderTimeoutError(
          PROVIDER_ID,
          `HTTPS request exceeded ${this.timeoutMs}ms.`
        );
        request.destroy(error);
      });
      request.on("error", (cause) => {
        finish(() => {
          if (cause instanceof ProviderTimeoutError) {
            reject(cause);
          } else {
            reject(
              new ProviderResponseError(
                PROVIDER_ID,
                signal?.aborted
                  ? "HTTPS request was cancelled."
                  : "HTTPS request failed.",
                {
                  retryable: !signal?.aborted,
                  cause
                }
              )
            );
          }
        });
      });
      request.end();
    });
  }
}

export function createPinnedLookup(
  address: ResolvedAddress
): NonNullable<RequestOptions["lookup"]> {
  return (_hostname, options, callback): void => {
    if (options.all) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

export function validateFetchUrl(
  input: string | URL,
  allowedDomains: readonly string[]
): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch (cause) {
    throw new ProviderResponseError(PROVIDER_ID, "Evidence URL is invalid.", {
      cause
    });
  }
  if (url.href.length > 2048) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "Evidence URL exceeds 2048 characters."
    );
  }
  if (url.protocol !== "https:") {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "Only HTTPS evidence URLs are allowed."
    );
  }
  if (url.username || url.password) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "Credentials in evidence URLs are forbidden."
    );
  }
  if (url.port && url.port !== "443") {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "Only the default HTTPS port is allowed."
    );
  }
  const normalizedDomains = allowedDomains.map(normalizeDomain).filter(Boolean);
  if (!hostnameAllowed(url.hostname, normalizedDomains)) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "Evidence URL is outside the authoritative-domain whitelist."
    );
  }
  url.hash = "";
  return url;
}

export function assertSafeResolvedAddresses(
  hostname: string,
  addresses: readonly ResolvedAddress[]
): void {
  if (addresses.length === 0) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      `DNS returned no address for ${hostname}.`,
      { retryable: true }
    );
  }
  for (const result of addresses) {
    if (
      (result.family !== 4 && result.family !== 6) ||
      isIP(result.address) !== result.family ||
      !isPublicIpAddress(result.address)
    ) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        `DNS for ${hostname} resolved to a private or reserved address.`
      );
    }
  }
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToNumber(address);
    return !IPV4_BLOCKS.some(([base, prefix]) =>
      inIpv4Cidr(value, base, prefix)
    );
  }
  if (family === 6) {
    const value = ipv6ToBigInt(address);
    if (value === undefined) {
      return false;
    }
    const high96 = value >> 32n;
    if (high96 === 0n || high96 === 0xffffn) {
      const ipv4 = Number(value & 0xffffffffn);
      return !IPV4_BLOCKS.some(([base, prefix]) =>
        inIpv4Cidr(ipv4, base, prefix)
      );
    }
    return !IPV6_BLOCKS.some(([base, prefix]) =>
      inIpv6Cidr(value, base, prefix)
    );
  }
  return false;
}

const IPV4_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [ipv4ToNumber("0.0.0.0"), 8],
  [ipv4ToNumber("10.0.0.0"), 8],
  [ipv4ToNumber("100.64.0.0"), 10],
  [ipv4ToNumber("127.0.0.0"), 8],
  [ipv4ToNumber("169.254.0.0"), 16],
  [ipv4ToNumber("172.16.0.0"), 12],
  [ipv4ToNumber("192.0.0.0"), 24],
  [ipv4ToNumber("192.0.2.0"), 24],
  [ipv4ToNumber("192.88.99.0"), 24],
  [ipv4ToNumber("192.168.0.0"), 16],
  [ipv4ToNumber("198.18.0.0"), 15],
  [ipv4ToNumber("198.51.100.0"), 24],
  [ipv4ToNumber("203.0.113.0"), 24],
  [ipv4ToNumber("224.0.0.0"), 3]
];

const IPV6_BLOCKS: ReadonlyArray<readonly [bigint, number]> = [
  [ipv6Required("::"), 128],
  [ipv6Required("::1"), 128],
  [ipv6Required("64:ff9b::"), 96],
  [ipv6Required("64:ff9b:1::"), 48],
  [ipv6Required("100::"), 64],
  [ipv6Required("2001::"), 32],
  [ipv6Required("2001:10::"), 28],
  [ipv6Required("2001:20::"), 28],
  [ipv6Required("2001:db8::"), 32],
  [ipv6Required("2002::"), 16],
  [ipv6Required("fc00::"), 7],
  [ipv6Required("fe80::"), 10],
  [ipv6Required("ff00::"), 8]
];

function ipv4ToNumber(address: string): number {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    throw new Error(`Invalid IPv4 address: ${address}`);
  }
  return (
    ((octets[0] ?? 0) * 2 ** 24 +
      (octets[1] ?? 0) * 2 ** 16 +
      (octets[2] ?? 0) * 2 ** 8 +
      (octets[3] ?? 0)) >>>
    0
  );
}

function inIpv4Cidr(value: number, base: number, prefix: number): boolean {
  const divisor = 2 ** (32 - prefix);
  return Math.floor(value / divisor) === Math.floor(base / divisor);
}

function ipv6Required(address: string): bigint {
  const parsed = ipv6ToBigInt(address);
  if (parsed === undefined) {
    throw new Error(`Invalid IPv6 address: ${address}`);
  }
  return parsed;
}

function ipv6ToBigInt(address: string): bigint | undefined {
  let normalized = address.toLowerCase().split("%")[0] ?? "";
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon < 0) {
      return undefined;
    }
    let ipv4: number;
    try {
      ipv4 = ipv4ToNumber(normalized.slice(lastColon + 1));
    } catch {
      return undefined;
    }
    normalized = `${normalized.slice(0, lastColon)}:${(
      (ipv4 >>> 16) &
      0xffff
    ).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  if ((normalized.match(/::/g) ?? []).length > 1) {
    return undefined;
  }
  const [leftRaw, rightRaw] = normalized.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const hadCompression = normalized.includes("::");
  if (
    (!hadCompression && left.length !== 8) ||
    (hadCompression && left.length + right.length >= 8)
  ) {
    return undefined;
  }
  const missing = 8 - left.length - right.length;
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))
  ) {
    return undefined;
  }
  return groups.reduce(
    (result, group) => (result << 16n) + BigInt(Number.parseInt(group, 16)),
    0n
  );
}

function inIpv6Cidr(value: bigint, base: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return value >> shift === base >> shift;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeContentType(value: string | undefined): string | undefined {
  return value?.split(";")[0]?.trim().toLowerCase();
}

async function defaultResolver(hostname: string): Promise<ResolvedAddress[]> {
  if (isIP(hostname)) {
    return [{ address: hostname, family: isIP(hostname) }];
  }
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => reject(signal?.reason));
    };
    const timer = setTimeout(() => {
      finish(() => reject(new ProviderTimeoutError(PROVIDER_ID, message)));
    }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        finish(() => resolve(value));
      },
      (error: unknown) => {
        finish(() => reject(error));
      }
    );
  });
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return resolved;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return resolved;
}
