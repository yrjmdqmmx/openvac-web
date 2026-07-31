import { ConfigurationError, ProviderResponseError } from "./errors";
import {
  asRecord,
  createProviderDeadline,
  hostnameAllowed,
  normalizeBaseUrl,
  normalizeDomain,
  optionalString,
  parseCommaSeparated,
  pickNumber,
  pickString,
  readJsonResponse,
  requireString
} from "./runtime";
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource
} from "./types";

const PROVIDER_ID = "alibaba-web-search";
const MAX_ASSIGNED_SITES = 25;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface AlibabaWebSearchOptions {
  apiKey?: string;
  endpoint?: string;
  workspaceId?: string;
  model?: string;
  enabled?: boolean;
  allowedDomains?: string[];
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

export class AlibabaWebSearchProvider implements WebSearchProvider {
  readonly id = PROVIDER_ID;

  private readonly apiKey?: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly enabled: boolean;
  private readonly allowedDomains: string[];
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: AlibabaWebSearchOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY;
    this.endpoint = normalizeBaseUrl(
      options.endpoint ??
        process.env.DASHSCOPE_NATIVE_ENDPOINT ??
        nativeEndpoint(
          options.workspaceId ?? process.env.DASHSCOPE_WORKSPACE_ID
        )
    );
    this.model =
      optionalString(options.model ?? process.env.ALIBABA_WEB_SEARCH_MODEL) ??
      "qwen-plus";
    this.enabled =
      options.enabled ?? process.env.ALIBABA_WEB_SEARCH_ENABLED === "true";
    this.allowedDomains = [
      ...new Set(
        (
          options.allowedDomains ??
          parseCommaSeparated(process.env.ALIBABA_WEB_SEARCH_ALLOWED_DOMAINS)
        )
          .map(normalizeDomain)
          .filter(Boolean)
      )
    ];
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult> {
    if (!this.enabled) {
      throw new ConfigurationError(
        PROVIDER_ID,
        "Alibaba web search is disabled. Set ALIBABA_WEB_SEARCH_ENABLED=true after configuring its budget."
      );
    }
    const query = request.query.trim();
    if (!query) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        "A non-empty search query is required."
      );
    }
    const apiKey = requireString(PROVIDER_ID, "DASHSCOPE_API_KEY", this.apiKey);
    const domains = this.resolveDomains(request.allowedDomains);
    if (domains.length === 0) {
      throw new ConfigurationError(
        PROVIDER_ID,
        "At least one authoritative search domain must be configured."
      );
    }

    const deadline = createProviderDeadline(
      PROVIDER_ID,
      this.requestTimeoutMs,
      request.signal
    );

    try {
      const response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          input: {
            messages: [{ role: "user", content: query }]
          },
          parameters: {
            result_format: "message",
            enable_search: true,
            search_options: {
              search_strategy: "turbo",
              enable_source: true,
              forced_search: request.forced ?? true,
              assigned_site_list: domains
            }
          }
        }),
        signal: deadline.signal
      });
      const payload = await readJsonResponse(PROVIDER_ID, response);
      const output = asRecord(payload.output);
      const searchInfo = asRecord(output.search_info);
      const searchResults = Array.isArray(searchInfo.search_results)
        ? searchInfo.search_results
        : [];
      const usage = asRecord(payload.usage);
      const plugins = asRecord(usage.plugins);
      const searchUsage = asRecord(plugins.search);
      const searchCalls = pickNumber(searchUsage, ["count"]) ?? 0;

      if (
        Object.keys(searchInfo).length === 0 ||
        ((request.forced ?? true) && searchCalls < 1)
      ) {
        throw new ProviderResponseError(
          PROVIDER_ID,
          "DashScope did not confirm a web search in search_info/usage.",
          { retryable: true }
        );
      }

      const sources = searchResults
        .map((item, fallbackIndex) =>
          parseSearchSource(item, fallbackIndex, domains)
        )
        .filter((item): item is WebSearchSource => item !== undefined);

      if ((request.forced ?? true) && sources.length === 0) {
        throw new ProviderResponseError(
          PROVIDER_ID,
          "DashScope returned no source inside the authoritative-domain whitelist.",
          { retryable: true }
        );
      }

      return {
        requestId: pickString(payload, ["request_id", "requestId"]),
        synthesis: readAssistantContent(output),
        searched: searchCalls > 0,
        searchCalls,
        sources
      };
    } catch (cause) {
      if (deadline.didTimeout()) {
        throw deadline.timeoutError;
      }
      throw cause;
    } finally {
      deadline.dispose();
    }
  }

  private resolveDomains(requested?: string[]): string[] {
    if (!requested?.length) {
      return this.allowedDomains.slice(0, MAX_ASSIGNED_SITES);
    }
    const normalized = requested.map(normalizeDomain).filter(Boolean);
    return [
      ...new Set(
        normalized.filter((domain) =>
          hostnameAllowed(domain, this.allowedDomains)
        )
      )
    ].slice(0, MAX_ASSIGNED_SITES);
  }
}

function parseSearchSource(
  value: unknown,
  fallbackIndex: number,
  allowedDomains: string[]
): WebSearchSource | undefined {
  const record = asRecord(value);
  const url = pickString(record, ["url"]);
  const title = pickString(record, ["title"]);
  if (!url || !title) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    !hostnameAllowed(parsed.hostname, allowedDomains)
  ) {
    return undefined;
  }

  return {
    index: pickNumber(record, ["index"]) ?? fallbackIndex + 1,
    title,
    url: parsed.toString(),
    siteName: pickString(record, ["site_name", "siteName"]),
    icon: pickString(record, ["icon"])
  };
}

function readAssistantContent(output: Record<string, unknown>): string {
  const choices = Array.isArray(output.choices) ? output.choices : [];
  for (const item of choices) {
    const message = asRecord(asRecord(item).message);
    const content = pickString(message, ["content"]);
    if (content) {
      return content;
    }
  }
  return "";
}

function nativeEndpoint(workspaceId?: string): string {
  const normalized = optionalString(workspaceId);
  if (normalized) {
    return `https://${normalized}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/text-generation/generation`;
  }
  return "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation";
}

let singleton: AlibabaWebSearchProvider | undefined;

export function getWebSearchProvider(): WebSearchProvider {
  singleton ??= new AlibabaWebSearchProvider();
  return singleton;
}
