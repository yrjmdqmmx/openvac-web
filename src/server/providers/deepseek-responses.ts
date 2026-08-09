import {
  asRecord,
  createProviderDeadline,
  normalizeTrustedHttpsBaseUrl,
  optionalString,
  parseCommaSeparated,
  pickNumber,
  pickString,
  readJsonResponse,
  requireString
} from "./runtime";
import { ProviderResponseError } from "./errors";
import { parseSseJson } from "./deepseek";
import type {
  ResponsesFailure,
  ResponsesFunctionTool,
  ResponsesInputItem,
  ResponsesProvider,
  ResponsesStreamEvent,
  ResponsesStreamRequest,
  ResponsesTextFormat,
  ResponsesTool,
  ResponsesUsage
} from "./types";

const PROVIDER_ID = "deepseek-responses";
const MODEL = "deepseek-v4-flash";
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const SAFE_USER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const DEEPSEEK_RESPONSES_CAPABILITIES = {
  protocol: "responses",
  semanticTerminalEvents: true,
  reasoningItems: true,
  functionTools: true,
  parallelFunctionCalls: true,
  nativeWebSearch: true,
  structuredOutputs: true
} as const;

export interface DeepSeekResponsesProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  defaultMaxOutputTokens?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  allowedHosts?: string[];
}

export class DeepSeekResponsesProvider implements ResponsesProvider {
  readonly id = PROVIDER_ID;
  readonly model: string;
  readonly capabilities = DEEPSEEK_RESPONSES_CAPABILITIES;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultMaxOutputTokens: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: DeepSeekResponsesProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
    this.baseUrl = normalizeTrustedHttpsBaseUrl(
      PROVIDER_ID,
      options.baseUrl ??
        process.env.DEEPSEEK_BASE_URL ??
        "https://api.deepseek.com",
      options.allowedHosts ??
        parseCommaSeparated(
          process.env.DEEPSEEK_ALLOWED_HOSTS ?? "api.deepseek.com"
        )
    );
    this.model =
      optionalString(options.model ?? process.env.DEEPSEEK_RESPONSES_MODEL) ??
      MODEL;
    if (this.model !== MODEL) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        `Responses traffic is restricted to ${MODEL}.`,
        { retryable: false }
      );
    }
    this.defaultMaxOutputTokens =
      options.defaultMaxOutputTokens ??
      Number(
        process.env.AGENT_AUTO_MAX_OUTPUT_TOKENS ?? DEFAULT_MAX_OUTPUT_TOKENS
      );
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
  }

  async *stream(
    request: ResponsesStreamRequest
  ): AsyncGenerator<ResponsesStreamEvent, void, undefined> {
    const apiKey = requireString(PROVIDER_ID, "DEEPSEEK_API_KEY", this.apiKey);
    assertSafeUser(request.user);
    const maxOutputTokens =
      request.maxOutputTokens ?? this.defaultMaxOutputTokens;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      throw new TypeError("maxOutputTokens must be a positive integer.");
    }

    const deadline = createProviderDeadline(
      PROVIDER_ID,
      this.requestTimeoutMs,
      request.signal
    );
    const startedAt = performance.now();

    try {
      const response = await this.fetchFn(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          input: request.input,
          ...(request.instructions
            ? { instructions: request.instructions }
            : {}),
          ...(request.tools?.length
            ? { tools: serializeTools(request.tools) }
            : {}),
          ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
          ...(request.reasoningEffort
            ? { reasoning: { effort: request.reasoningEffort } }
            : {}),
          ...(request.textFormat
            ? { text: { format: serializeTextFormat(request.textFormat) } }
            : {}),
          max_output_tokens: maxOutputTokens,
          user: request.user,
          stream: true
        }),
        signal: deadline.signal
      });

      if (!response.ok) {
        await readJsonResponse(PROVIDER_ID, response);
        return;
      }
      if (!response.body) {
        throw malformed("DeepSeek returned an empty Responses stream.");
      }

      const providerRequestId =
        response.headers.get("x-request-id") ??
        response.headers.get("request-id") ??
        undefined;
      let responseId: string | undefined;
      let lastSequence = -1;
      let receivedSemanticEvent = false;
      let firstEventLatencyMs: number | undefined;
      let outputText = "";
      const emittedCalls = new Set<string>();
      let streamedCompletedWebSearchCount = 0;

      for await (const rawEvent of parseSseJson(response.body)) {
        const event = asRecord(rawEvent);
        const eventType = pickString(event, ["type"]);
        if (!eventType) {
          continue;
        }

        const sequence = pickNumber(event, ["sequence_number"]);
        if (sequence !== undefined) {
          if (sequence === lastSequence) {
            continue;
          }
          if (sequence < lastSequence) {
            throw malformed(
              `DeepSeek Responses sequence moved backwards (${sequence} after ${lastSequence}).`
            );
          }
          lastSequence = sequence;
        }
        if (!receivedSemanticEvent) {
          receivedSemanticEvent = true;
          firstEventLatencyMs = Math.max(
            0,
            Math.round(performance.now() - startedAt)
          );
        }

        const responseRecord = asRecord(event.response);
        responseId = pickString(responseRecord, ["id"]) ?? responseId;

        if (eventType === "response.created") {
          if (!responseId) {
            throw malformed("DeepSeek response.created omitted response.id.");
          }
          yield { type: "response-created", responseId };
          continue;
        }

        if (eventType === "response.output_text.delta") {
          const delta = pickString(event, ["delta"]);
          if (delta) {
            outputText += delta;
            yield { type: "text-delta", text: delta };
          }
          continue;
        }

        if (eventType === "response.output_item.done") {
          const item = asRecord(event.item);
          if (pickString(item, ["type"]) === "function_call") {
            const callId = pickString(item, ["call_id"]);
            const name = pickString(item, ["name"]);
            const args = pickString(item, ["arguments"]);
            if (!callId || !name || args === undefined) {
              throw malformed(
                "DeepSeek returned an incomplete function_call item."
              );
            }
            if (!emittedCalls.has(callId)) {
              emittedCalls.add(callId);
              yield {
                type: "function-call",
                callId,
                name,
                arguments: args
              };
            }
          }
          continue;
        }

        const webStatus = webSearchStatus(eventType);
        if (webStatus) {
          if (webStatus === "completed") streamedCompletedWebSearchCount += 1;
          yield { type: "web-search-status", status: webStatus };
          continue;
        }

        const terminalStatus = terminalResponseStatus(eventType);
        if (terminalStatus) {
          if (!responseId) {
            throw malformed(`${eventType} omitted response.id.`);
          }
          const continuationItems = responseOutputItems(responseRecord);
          const terminalOutputText = extractOutputText(continuationItems);
          const webSources = extractWebSearchSources(continuationItems);
          const terminalCompletedWebSearchCount =
            completedWebSearchCallCount(continuationItems);
          const additionalCompletedWebSearchCount = Math.max(
            0,
            terminalCompletedWebSearchCount - streamedCompletedWebSearchCount
          );
          for (
            let index = 0;
            index < additionalCompletedWebSearchCount;
            index += 1
          ) {
            yield { type: "web-search-status", status: "completed" };
          }
          const incompleteRecord = asRecord(responseRecord.incomplete_details);
          const errorRecord = asRecord(responseRecord.error ?? event.error);
          if (terminalStatus === "completed" && webSources.length > 0) {
            yield { type: "web-search-sources", sources: webSources };
          }
          yield {
            type: "finish",
            status: terminalStatus,
            responseId,
            outputText: outputText || terminalOutputText,
            continuationItems,
            usage: parseResponsesUsage(responseRecord.usage),
            ...(terminalStatus === "incomplete"
              ? {
                  incomplete: {
                    reason: pickString(incompleteRecord, ["reason"])
                  }
                }
              : {}),
            ...(terminalStatus === "failed"
              ? { error: parseFailure(errorRecord) }
              : {}),
            providerRequestId,
            firstEventLatencyMs
          };
          return;
        }

        // Reasoning deltas and summaries are deliberately ignored. Complete
        // reasoning items are only returned through continuationItems above.
      }

      throw malformed(
        "DeepSeek Responses stream ended without a terminal semantic event."
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
}

function serializeTools(tools: ResponsesTool[]): ResponsesTool[] {
  return tools.map((tool) => {
    if (tool.type !== "function") return tool;
    // DeepSeek's standard Responses endpoint does not advertise the beta
    // strict-tool switch. Tool arguments are validated locally before any
    // execution, so never opt the standard endpoint into beta strict-schema
    // validation implicitly.
    const portable = { ...tool };
    delete portable.strict;
    return portable as ResponsesFunctionTool;
  });
}

function serializeTextFormat(format: ResponsesTextFormat): ResponsesTextFormat {
  if (format.type !== "json_schema") return format;
  // Structured output is still requested with the full schema. The provider
  // response is then validated again by the server-owned AnswerV3 schema.
  // `strict` is not part of DeepSeek's documented Responses text format.
  const portable = { ...format };
  delete portable.strict;
  return portable;
}

function assertSafeUser(user: string): void {
  if (!SAFE_USER_PATTERN.test(user)) {
    throw new TypeError(
      "Responses user must be a versioned, non-identifying safe token."
    );
  }
}

function terminalResponseStatus(
  eventType: string
): "completed" | "incomplete" | "failed" | undefined {
  if (eventType === "response.completed") return "completed";
  if (eventType === "response.incomplete") return "incomplete";
  if (eventType === "response.failed") return "failed";
  return undefined;
}

function webSearchStatus(
  eventType: string
): "in_progress" | "searching" | "completed" | undefined {
  if (eventType === "response.web_search_call.in_progress") {
    return "in_progress";
  }
  if (eventType === "response.web_search_call.searching") {
    return "searching";
  }
  if (eventType === "response.web_search_call.completed") {
    return "completed";
  }
  return undefined;
}

function responseOutputItems(
  response: Record<string, unknown>
): ResponsesInputItem[] {
  if (!Array.isArray(response.output)) {
    return [];
  }
  return response.output.flatMap((value) => {
    const item = asRecord(value);
    return typeof item.type === "string" ? [item as ResponsesInputItem] : [];
  });
}

function extractOutputText(items: ResponsesInputItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const value of item.content) {
      const content = asRecord(value);
      if (pickString(content, ["type"]) === "output_text") {
        const text = pickString(content, ["text"]);
        if (text) parts.push(text);
      }
    }
  }
  return parts.join("");
}

function extractWebSearchSources(
  items: ResponsesInputItem[]
): Array<{ url: string; title: string }> {
  const sources: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  const addSources = (values: unknown[]): boolean => {
    for (const candidate of values) {
      const source = asRecord(candidate);
      const url = pickString(source, ["url"]);
      if (!url || url.length > 2_048 || seen.has(url)) continue;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        continue;
      }
      if (parsed.protocol !== "https:") continue;
      const title = pickString(source, ["title"])?.trim();
      sources.push({
        url,
        title: title && title.length <= 300 ? title : parsed.hostname
      });
      seen.add(url);
      if (sources.length === 16) return true;
    }
    return false;
  };
  for (const item of items) {
    if (item.type === "web_search_call") {
      if (pickString(item, ["status"]) !== "completed") continue;
      const action = asRecord(item.action);
      const actionSources = Array.isArray(action.sources) ? action.sources : [];
      const itemSources = Array.isArray(item.sources) ? item.sources : [];
      if (addSources([...actionSources, ...itemSources])) return sources;
      continue;
    }
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const value of item.content) {
      const content = asRecord(value);
      if (!Array.isArray(content.annotations)) continue;
      if (
        addSources(
          content.annotations.filter(
            (candidate) =>
              pickString(asRecord(candidate), ["type"]) === "url_citation"
          )
        )
      )
        return sources;
    }
  }
  return sources;
}

function completedWebSearchCallCount(items: ResponsesInputItem[]): number {
  return items.filter((item) => {
    if (item.type !== "web_search_call") return false;
    return pickString(item, ["status"]) === "completed";
  }).length;
}

function parseResponsesUsage(value: unknown): ResponsesUsage | undefined {
  const usage = asRecord(value);
  if (Object.keys(usage).length === 0) return undefined;
  const inputDetails = asRecord(usage.input_tokens_details);
  const outputDetails = asRecord(usage.output_tokens_details);
  return {
    inputTokens: pickNumber(usage, ["input_tokens"]),
    cachedInputTokens: pickNumber(inputDetails, ["cached_tokens"]),
    outputTokens: pickNumber(usage, ["output_tokens"]),
    reasoningTokens: pickNumber(outputDetails, ["reasoning_tokens"]),
    totalTokens: pickNumber(usage, ["total_tokens"])
  };
}

function parseFailure(error: Record<string, unknown>): ResponsesFailure {
  return {
    code: pickString(error, ["code"]),
    message:
      pickString(error, ["message", "code"]) ??
      "DeepSeek Responses request failed."
  };
}

function malformed(message: string): ProviderResponseError {
  return new ProviderResponseError(PROVIDER_ID, message, { retryable: true });
}

let singleton: DeepSeekResponsesProvider | undefined;

export function getResponsesProvider(): ResponsesProvider {
  singleton ??= new DeepSeekResponsesProvider();
  return singleton;
}
