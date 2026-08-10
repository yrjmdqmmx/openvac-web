import { Readable } from "node:stream";

import { ConfigurationError, ProviderResponseError } from "./errors";
import {
  asRecord,
  loadOptionalModule,
  normalizeDomain,
  optionalString,
  parseCommaSeparated,
  pickString,
  requireConstructor,
  requireMethod,
  requireString,
  unwrapSdkBody
} from "./runtime";
import type {
  DocumentParser,
  DocumentParseJob,
  DocumentParseRequest,
  DocumentParseStatus,
  DocumentParseStatusResult,
  ParsedDocument,
  ParsedDocumentPage
} from "./types";

const PROVIDER_ID = "alibaba-docmind";
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_READ_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESULT_REQUESTS = 64;
const DEFAULT_MAX_LAYOUTS = 20_000;
const DEFAULT_MAX_PAGES = 500;
const DEFAULT_MAX_TEXT_BYTES = 5 * 1024 * 1024;

export interface DocMindOptions {
  accessKeyId?: string;
  accessKeySecret?: string;
  securityToken?: string;
  endpoint?: string;
  allowedDocumentHosts?: string[];
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  maxResultRequests?: number;
  maxLayouts?: number;
  maxPages?: number;
  maxTextBytes?: number;
}

export class AlibabaDocMindParser implements DocumentParser {
  readonly id = PROVIDER_ID;

  private readonly accessKeyId?: string;
  private readonly accessKeySecret?: string;
  private readonly securityToken?: string;
  private readonly endpoint: string;
  private readonly allowedDocumentHosts: ReadonlySet<string>;
  private readonly connectTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly maxResultRequests: number;
  private readonly maxLayouts: number;
  private readonly maxPages: number;
  private readonly maxTextBytes: number;

  constructor(options: DocMindOptions = {}) {
    this.accessKeyId = options.accessKeyId ?? process.env.ALIBABA_ACCESS_KEY_ID;
    this.accessKeySecret =
      options.accessKeySecret ?? process.env.ALIBABA_ACCESS_KEY_SECRET;
    this.securityToken =
      options.securityToken ?? process.env.ALIBABA_SECURITY_TOKEN;
    this.endpoint =
      optionalString(options.endpoint ?? process.env.ALIBABA_OCR_ENDPOINT) ??
      "docmind-api.cn-hangzhou.aliyuncs.com";
    this.allowedDocumentHosts = new Set(
      (
        options.allowedDocumentHosts ??
        parseCommaSeparated(process.env.ALIBABA_OCR_ALLOWED_DOCUMENT_HOSTS)
      ).map(normalizeDomain)
    );
    this.connectTimeoutMs = boundedPositiveInteger(
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      "connectTimeoutMs"
    );
    this.readTimeoutMs = boundedPositiveInteger(
      options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
      "readTimeoutMs"
    );
    this.maxResultRequests = boundedPositiveInteger(
      options.maxResultRequests ?? DEFAULT_MAX_RESULT_REQUESTS,
      "maxResultRequests"
    );
    this.maxLayouts = boundedPositiveInteger(
      options.maxLayouts ?? DEFAULT_MAX_LAYOUTS,
      "maxLayouts"
    );
    this.maxPages = boundedPositiveInteger(
      options.maxPages ?? DEFAULT_MAX_PAGES,
      "maxPages"
    );
    this.maxTextBytes = boundedPositiveInteger(
      options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
      "maxTextBytes"
    );
  }

  async submit(request: DocumentParseRequest): Promise<DocumentParseJob> {
    if ((!request.url && !request.bytes) || (request.url && request.bytes)) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        "Exactly one of document URL or document bytes is required."
      );
    }
    if (request.url) {
      if (request.urlTrust === "private-oss-v4") {
        assertTrustedPrivateOssUrl(request.url);
      } else {
        assertAllowedDocumentUrl(request.url, this.allowedDocumentHosts);
      }
    } else if (request.urlTrust) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        "DocMind URL trust requires a document URL."
      );
    }
    const filename = resolveFilename(request);

    const sdk = this.createSdk();
    const Request = requireConstructor(PROVIDER_ID, sdk.sdkModule, [
      request.bytes
        ? "SubmitDocParserJobAdvanceRequest"
        : "SubmitDocParserJobRequest"
    ]);
    const sdkRequest = new Request({
      fileUrl: request.url,
      fileName: filename,
      outputFormat: request.outputFormats ?? ["markdown", "visualLayoutInfo"],
      pageIndex: formatPageIndexes(request.pageIndexes),
      llmEnhancement: request.llmEnhancement ?? true,
      enhancementMode: "VLM",
      formulaEnhancement: true,
      ...(request.bytes
        ? { fileUrlObject: Readable.from(Buffer.from(request.bytes)) }
        : {})
    });

    const response = request.bytes
      ? await requireMethod(
          PROVIDER_ID,
          sdk.client,
          "submitDocParserJobAdvance"
        )(sdkRequest, sdk.runtime)
      : await requireMethod(
          PROVIDER_ID,
          sdk.client,
          "submitDocParserJob"
        )(sdkRequest, sdk.runtime);
    const body = unwrapSdkBody(response);
    const data = asRecord(body.data ?? body.Data);
    const jobId =
      pickString(data, ["id", "jobId", "dataId"]) ??
      pickString(body, ["id", "jobId", "dataId"]);

    if (!jobId) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        "DocMind accepted the request without returning a job identifier.",
        { retryable: true }
      );
    }
    return {
      jobId,
      requestId: pickString(body, ["requestId", "request_id"])
    };
  }

  async getStatus(jobId: string): Promise<DocumentParseStatusResult> {
    const sdk = this.createSdk();
    const Request = requireConstructor(PROVIDER_ID, sdk.sdkModule, [
      "QueryDocParserStatusRequest"
    ]);
    const response = await requireMethod(
      PROVIDER_ID,
      sdk.client,
      "queryDocParserStatus"
    )(new Request({ id: jobId }), sdk.runtime);
    const body = unwrapSdkBody(response);
    const data = asRecord(body.data ?? body.Data);
    const rawStatus =
      pickString(data, ["status", "taskStatus"]) ??
      pickString(body, ["status", "taskStatus"]);
    if (!rawStatus) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        "DocMind returned a status response without a recognized status.",
        { retryable: true }
      );
    }

    return {
      jobId,
      status: normalizeDocMindStatus(rawStatus),
      requestId: pickString(body, ["requestId", "request_id"]),
      errorMessage:
        pickString(data, ["errorMessage", "message"]) ??
        pickString(body, ["errorMessage", "message"])
    };
  }

  async getResult(jobId: string): Promise<ParsedDocument> {
    const sdk = this.createSdk();
    const Request = requireConstructor(PROVIDER_ID, sdk.sdkModule, [
      "GetDocParserResultRequest"
    ]);
    const getResult = requireMethod(
      PROVIDER_ID,
      sdk.client,
      "getDocParserResult"
    );
    const layoutStepSize = 500;
    const layouts: unknown[] = [];
    let lastBody: Record<string, unknown> = {};
    let textBytes = 0;
    let completed = false;

    for (
      let layoutNum = 0, requestCount = 0;
      requestCount < this.maxResultRequests;
      requestCount += 1
    ) {
      const response = await getResult(
        new Request({
          id: jobId,
          layoutNum,
          layoutStepSize
        }),
        sdk.runtime
      );
      const body = unwrapSdkBody(response);
      lastBody = body;
      const data = asRecord(body.data ?? body.Data);
      const page = Array.isArray(data.layouts)
        ? data.layouts
        : Array.isArray(body.layouts)
          ? body.layouts
          : [];
      if (layouts.length + page.length > this.maxLayouts) {
        throw new ProviderResponseError(
          PROVIDER_ID,
          `DocMind result exceeds the ${this.maxLayouts}-layout limit.`
        );
      }
      for (const layout of page) {
        const record = asRecord(layout);
        const markdown = extractLayoutText(record);
        textBytes += Buffer.byteLength(markdown, "utf8");
        if (textBytes > this.maxTextBytes) {
          throw new ProviderResponseError(
            PROVIDER_ID,
            `DocMind result exceeds the ${this.maxTextBytes}-byte text limit.`
          );
        }
        layouts.push({
          pageNum:
            typeof record.pageNum === "number" ? record.pageNum : undefined,
          index: typeof record.index === "number" ? record.index : undefined,
          markdown
        });
      }
      if (page.length < layoutStepSize) {
        completed = true;
        break;
      }
      layoutNum += page.length;
    }
    if (!completed) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        `DocMind result exceeded the ${this.maxResultRequests}-request pagination limit.`
      );
    }

    const pages = groupLayoutsByPage(layouts, this.maxPages);

    if (pages.length === 0) {
      const data = asRecord(lastBody.data ?? lastBody.Data);
      const markdown =
        pickString(data, ["markdown", "content"]) ??
        pickString(lastBody, ["markdown", "content"]);
      if (markdown) {
        if (Buffer.byteLength(markdown, "utf8") > this.maxTextBytes) {
          throw new ProviderResponseError(
            PROVIDER_ID,
            `DocMind result exceeds the ${this.maxTextBytes}-byte text limit.`
          );
        }
        pages.push({ markdown });
      }
    }

    return { jobId, pages };
  }

  private createSdk(): {
    sdkModule: Record<string, unknown>;
    client: unknown;
    runtime: unknown;
  } {
    const accessKeyId = requireString(
      PROVIDER_ID,
      "ALIBABA_ACCESS_KEY_ID",
      this.accessKeyId
    );
    const accessKeySecret = requireString(
      PROVIDER_ID,
      "ALIBABA_ACCESS_KEY_SECRET",
      this.accessKeySecret
    );
    const sdkModule = loadOptionalModule(
      PROVIDER_ID,
      "@alicloud/docmind-api20220711"
    );
    const teaUtil = loadOptionalModule(PROVIDER_ID, "@alicloud/tea-util");
    const Client = requireConstructor(PROVIDER_ID, sdkModule, ["default"]);
    const RuntimeOptions = requireConstructor(PROVIDER_ID, teaUtil, [
      "RuntimeOptions"
    ]);
    const config = {
      accessKeyId,
      accessKeySecret,
      securityToken: this.securityToken,
      endpoint: this.endpoint,
      type: this.securityToken ? "sts" : "access_key",
      regionId: "cn-hangzhou"
    };
    return {
      sdkModule,
      client: new Client(config),
      runtime: new RuntimeOptions({
        connectTimeout: this.connectTimeoutMs,
        readTimeout: this.readTimeoutMs,
        autoretry: false,
        maxAttempts: 1
      })
    };
  }
}

export function normalizeDocMindStatus(value: string): DocumentParseStatus {
  const normalized = value.toLowerCase();
  if (
    ["success", "succeeded", "finish", "finished", "completed"].includes(
      normalized
    )
  ) {
    return "succeeded";
  }
  if (
    ["fail", "failed", "error", "cancelled", "canceled"].includes(normalized)
  ) {
    return "failed";
  }
  if (["running", "processing"].includes(normalized)) {
    return "processing";
  }
  if (["pending", "queued", "waiting"].includes(normalized)) {
    return "pending";
  }
  throw new ProviderResponseError(
    PROVIDER_ID,
    `DocMind returned an unknown task status: ${value.slice(0, 80)}.`
  );
}

function groupLayoutsByPage(
  layouts: unknown[],
  maxPages: number
): ParsedDocumentPage[] {
  const ordered = layouts
    .map((layout, order) => ({ layout: asRecord(layout), order }))
    .sort((left, right) => {
      const leftIndex =
        typeof left.layout.index === "number" ? left.layout.index : left.order;
      const rightIndex =
        typeof right.layout.index === "number"
          ? right.layout.index
          : right.order;
      return leftIndex - rightIndex;
    });
  const grouped = new Map<
    number,
    { markdown: string[]; layouts: Record<string, unknown>[] }
  >();

  for (const { layout } of ordered) {
    const zeroBasedPage =
      typeof layout.pageNum === "number" ? layout.pageNum : 0;
    const pageNumber = zeroBasedPage + 1;
    const current = grouped.get(pageNumber) ?? {
      markdown: [],
      layouts: []
    };
    const markdown = pickString(layout, [
      "llmResult",
      "markdownContent",
      "markdown",
      "content",
      "text"
    ]);
    if (markdown) {
      current.markdown.push(markdown.trim());
    }
    current.layouts.push({
      index: layout.index,
      pageNum: layout.pageNum
    });
    grouped.set(pageNumber, current);
    if (grouped.size > maxPages) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        `DocMind result exceeds the ${maxPages}-page limit.`
      );
    }
  }

  return [...grouped.entries()].map(([pageNumber, page]) => ({
    pageNumber,
    markdown: page.markdown.filter(Boolean).join("\n\n"),
    visualLayoutInfo: page.layouts
  }));
}

export function assertAllowedDocumentUrl(
  value: string,
  allowedHosts: ReadonlySet<string>
): void {
  const url = parseSafeHttpsDocumentUrl(value);
  const hostname = normalizeDomain(url.hostname);
  if (!hostname || !allowedHosts.has(hostname)) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "DocMind document URL is outside the configured HTTPS host allowlist."
    );
  }
}

export function assertTrustedPrivateOssUrl(value: string): void {
  const url = parseSafeHttpsDocumentUrl(value);
  const hostname = normalizeDomain(url.hostname);
  const isAlibabaOss =
    /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.oss-[a-z0-9-]+\.aliyuncs\.com$/u.test(
      hostname
    ) && !hostname.includes("-internal.");
  const queryKeys = new Set(
    [...url.searchParams.keys()].map((key) => key.toLowerCase())
  );
  const expires = Number(url.searchParams.get("x-oss-expires"));
  const hasV4Signature = [
    "x-oss-credential",
    "x-oss-date",
    "x-oss-expires",
    "x-oss-signature",
    "x-oss-signature-version"
  ].every((key) => queryKeys.has(key));
  if (
    !isAlibabaOss ||
    !hasV4Signature ||
    url.searchParams.get("x-oss-signature-version") !== "OSS4-HMAC-SHA256" ||
    !Number.isInteger(expires) ||
    expires < 1 ||
    expires > 15 * 60
  ) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "DocMind private object URL is not a signed Alibaba OSS HTTPS URL."
    );
  }
}

function parseSafeHttpsDocumentUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "DocMind document URL is invalid.",
      { cause }
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !normalizeDomain(url.hostname)
  ) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "DocMind document URL is outside the configured HTTPS host allowlist."
    );
  }
  return url;
}

function extractLayoutText(layout: Record<string, unknown>): string {
  return (
    pickString(layout, [
      "llmResult",
      "markdownContent",
      "markdown",
      "content",
      "text"
    ]) ?? ""
  ).trim();
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function resolveFilename(request: DocumentParseRequest): string {
  const configured = optionalString(request.filename);
  if (configured) {
    return configured;
  }
  if (request.url) {
    const pathname = new URL(request.url).pathname;
    const candidate = decodeURIComponent(pathname.split("/").at(-1) ?? "");
    if (candidate.includes(".")) {
      return candidate;
    }
  }
  throw new ProviderResponseError(
    PROVIDER_ID,
    "DocMind requires a filename with an extension."
  );
}

function formatPageIndexes(pageIndexes?: number[]): string | undefined {
  if (!pageIndexes?.length) {
    return undefined;
  }
  const sorted = [...new Set(pageIndexes)].sort((left, right) => left - right);
  if (
    sorted.some(
      (page, index) =>
        !Number.isInteger(page) ||
        page < 1 ||
        (index > 0 && page !== (sorted[index - 1] ?? 0) + 1)
    )
  ) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "DocMind pageIndexes must be one contiguous range of positive page numbers."
    );
  }
  return `${sorted[0]}-${sorted.at(-1)}`;
}

let singleton: AlibabaDocMindParser | undefined;

export function getDocumentParser(): DocumentParser {
  singleton ??= new AlibabaDocMindParser();
  return singleton;
}

export function assertDocMindConfigured(
  parser: DocumentParser
): asserts parser is AlibabaDocMindParser {
  if (!(parser instanceof AlibabaDocMindParser)) {
    throw new ConfigurationError(
      PROVIDER_ID,
      "Unexpected document parser implementation."
    );
  }
}
