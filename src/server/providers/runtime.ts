import { createRequire } from "node:module";

import {
  ConfigurationError,
  ProviderResponseError,
  ProviderTimeoutError
} from "./errors";

export type UnknownRecord = Record<string, unknown>;

export const DEFAULT_JSON_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

export interface ProviderDeadline {
  signal: AbortSignal;
  timeoutError: ProviderTimeoutError;
  didTimeout(): boolean;
  dispose(): void;
}

export function createProviderDeadline(
  provider: string,
  timeoutMs: number,
  parentSignal?: AbortSignal
): ProviderDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Provider timeout must be a positive integer.");
  }

  const controller = new AbortController();
  const timeoutError = new ProviderTimeoutError(
    provider,
    `${provider} request exceeded ${timeoutMs}ms.`
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: parentSignal
      ? AbortSignal.any([parentSignal, controller.signal])
      : controller.signal,
    timeoutError,
    didTimeout: () => timedOut,
    dispose: () => clearTimeout(timer)
  };
}

export function asRecord(value: unknown): UnknownRecord {
  if (typeof value === "object" && value !== null) {
    return value as UnknownRecord;
  }
  return {};
}

export function optionalString(
  value: string | undefined,
  fallback?: string
): string | undefined {
  const normalized = value?.trim();
  return normalized || fallback;
}

export function requireString(
  provider: string,
  label: string,
  value: string | undefined
): string {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new ConfigurationError(
      provider,
      `${label} is required before ${provider} can be used.`
    );
  }
  return normalized;
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeTrustedHttpsBaseUrl(
  provider: string,
  value: string,
  allowedHosts: readonly string[]
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new ConfigurationError(
      provider,
      `${provider} base URL must be an absolute HTTPS URL.`,
      cause
    );
  }

  const normalizedAllowedHosts = allowedHosts
    .map(normalizeDomain)
    .filter(Boolean);
  if (
    url.protocol !== "https:" ||
    Boolean(url.username || url.password) ||
    (url.port !== "" && url.port !== "443") ||
    !normalizedAllowedHosts.includes(url.hostname.toLowerCase())
  ) {
    throw new ConfigurationError(
      provider,
      `${provider} base URL must use HTTPS on an explicitly trusted host.`
    );
  }
  if (url.search || url.hash) {
    throw new ConfigurationError(
      provider,
      `${provider} base URL must not contain a query string or fragment.`
    );
  }

  return normalizeBaseUrl(url.toString());
}

export function parseCommaSeparated(value: string | undefined): string[] {
  return (value ?? "").split(",").map(normalizeDomain).filter(Boolean);
}

export function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  try {
    const hostname = trimmed.includes("://")
      ? new URL(trimmed).hostname
      : trimmed;
    return hostname.replace(/^\.+|\.+$/g, "");
  } catch {
    return "";
  }
}

export function hostnameAllowed(
  hostname: string,
  allowedDomains: readonly string[]
): boolean {
  const normalized = normalizeDomain(hostname);
  return allowedDomains.some(
    (allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`)
  );
}

export async function readJsonResponse(
  provider: string,
  response: Response,
  maxBytes = DEFAULT_JSON_RESPONSE_MAX_BYTES
): Promise<UnknownRecord> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("JSON response byte limit must be a positive integer.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(
      await readBoundedResponseText(provider, response, maxBytes)
    );
  } catch (cause) {
    if (cause instanceof ProviderResponseError) {
      throw cause;
    }
    throw new ProviderResponseError(
      provider,
      `${provider} returned a non-JSON response (${response.status}).`,
      {
        status: response.status,
        retryable: isRetryableProviderStatus(response.status),
        cause
      }
    );
  }

  if (!response.ok) {
    const record = asRecord(payload);
    const nestedError = asRecord(record.error);
    const message =
      pickString(nestedError, ["message"]) ??
      pickString(record, ["message", "code"]) ??
      `HTTP ${response.status}`;
    throw new ProviderResponseError(
      provider,
      `${provider} request failed: ${message}`,
      {
        status: response.status,
        retryable: isRetryableProviderStatus(response.status)
      }
    );
  }

  return asRecord(payload);
}

async function readBoundedResponseText(
  provider: string,
  response: Response,
  maxBytes: number
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw responseTooLarge(provider, response.status, maxBytes);
    }
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw responseTooLarge(provider, response.status, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function responseTooLarge(
  provider: string,
  status: number,
  maxBytes: number
): ProviderResponseError {
  return new ProviderResponseError(
    provider,
    `${provider} response exceeds the ${maxBytes}-byte limit.`,
    { status, retryable: isRetryableProviderStatus(status) }
  );
}

export function isRetryableProviderStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function pickString(
  record: UnknownRecord,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function pickNumber(
  record: UnknownRecord,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function loadOptionalModule(
  provider: string,
  specifier: string
): UnknownRecord {
  try {
    const localRequire = createRequire(import.meta.url);
    const loaded: unknown = localRequire(specifier);
    if (typeof loaded === "function") {
      return { default: loaded };
    }
    return asRecord(loaded);
  } catch (cause) {
    throw new ConfigurationError(
      provider,
      `${provider} requires the optional package "${specifier}". Install it in the runtime image before enabling this provider.`,
      cause
    );
  }
}

export function moduleDefault(module: UnknownRecord): unknown {
  return module.default ?? module;
}

export function requireConstructor(
  provider: string,
  module: UnknownRecord,
  names: string[]
): new (value?: UnknownRecord) => unknown {
  for (const name of names) {
    const value = name === "default" ? moduleDefault(module) : module[name];
    if (typeof value === "function") {
      return value as new (input?: UnknownRecord) => unknown;
    }
  }
  throw new ConfigurationError(
    provider,
    `The installed ${provider} SDK does not expose ${names.join(" or ")}.`
  );
}

export function requireMethod(
  provider: string,
  target: unknown,
  name: string
): (...args: unknown[]) => Promise<unknown> {
  const method = asRecord(target)[name];
  if (typeof method !== "function") {
    throw new ConfigurationError(
      provider,
      `The installed ${provider} SDK does not expose ${name}().`
    );
  }
  return method.bind(target) as (...args: unknown[]) => Promise<unknown>;
}

export function unwrapSdkBody(response: unknown): UnknownRecord {
  const record = asRecord(response);
  return asRecord(record.body ?? response);
}
