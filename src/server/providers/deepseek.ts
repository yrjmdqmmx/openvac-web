import {
  asRecord,
  createProviderDeadline,
  normalizeBaseUrl,
  optionalString,
  pickNumber,
  pickString,
  readJsonResponse,
  requireString
} from "./runtime";
import {
  type ModelProvider,
  type ModelStreamEvent,
  type ModelStreamRequest,
  type ModelUsage
} from "./types";
import { ProviderResponseError } from "./errors";

const PROVIDER_ID = "deepseek";
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_SSE_EVENT_MAX_BYTES = 256 * 1024;
const DEFAULT_SSE_STREAM_MAX_BYTES = 4 * 1024 * 1024;

export interface DeepSeekProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  thinkingMode?: "enabled" | "disabled";
  defaultMaxOutputTokens?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

export class DeepSeekModelProvider implements ModelProvider {
  readonly id = PROVIDER_ID;
  readonly model: string;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly thinkingMode: "enabled" | "disabled";
  private readonly defaultMaxOutputTokens: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: DeepSeekProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ??
        process.env.DEEPSEEK_BASE_URL ??
        "https://api.deepseek.com"
    );
    this.model =
      optionalString(options.model ?? process.env.DEEPSEEK_MODEL) ??
      "deepseek-v4-flash";
    this.thinkingMode =
      options.thinkingMode ??
      (process.env.DEEPSEEK_THINKING_MODE === "enabled"
        ? "enabled"
        : "disabled");
    this.defaultMaxOutputTokens =
      options.defaultMaxOutputTokens ??
      Number(process.env.MODEL_MAX_OUTPUT_TOKENS ?? 4096);
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
  }

  async *stream(
    request: ModelStreamRequest
  ): AsyncGenerator<ModelStreamEvent, void, undefined> {
    const apiKey = requireString(PROVIDER_ID, "DEEPSEEK_API_KEY", this.apiKey);
    const deadline = createProviderDeadline(
      PROVIDER_ID,
      this.requestTimeoutMs,
      request.signal
    );

    try {
      const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.name ? { name: message.name } : {}),
            ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {})
          })),
          ...(request.tools?.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters
                  }
                })),
                tool_choice: "auto"
              }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
          thinking: { type: this.thinkingMode },
          ...(this.thinkingMode === "disabled" &&
          request.temperature !== undefined
            ? { temperature: request.temperature }
            : {}),
          max_tokens: request.maxOutputTokens ?? this.defaultMaxOutputTokens
        }),
        signal: deadline.signal
      });

      if (!response.ok) {
        await readJsonResponse(PROVIDER_ID, response);
        return;
      }
      if (!response.body) {
        throw new ProviderResponseError(
          PROVIDER_ID,
          "DeepSeek returned an empty streaming response.",
          { retryable: true }
        );
      }

      const providerRequestId =
        response.headers.get("x-request-id") ??
        response.headers.get("request-id") ??
        undefined;
      let finishReason: string | undefined;
      let usage: ModelUsage | undefined;

      for await (const event of parseSseJson(response.body)) {
        const record = asRecord(event);
        const error = asRecord(record.error);
        if (Object.keys(error).length > 0) {
          throw new ProviderResponseError(
            PROVIDER_ID,
            `DeepSeek stream failed: ${
              pickString(error, ["message", "code"]) ?? "unknown error"
            }`,
            { retryable: true }
          );
        }

        const usageRecord = asRecord(record.usage);
        if (Object.keys(usageRecord).length > 0) {
          usage = {
            inputTokens: pickNumber(usageRecord, [
              "prompt_tokens",
              "input_tokens"
            ]),
            outputTokens: pickNumber(usageRecord, [
              "completion_tokens",
              "output_tokens"
            ]),
            totalTokens: pickNumber(usageRecord, ["total_tokens"])
          };
        }

        const choices = Array.isArray(record.choices) ? record.choices : [];
        for (const rawChoice of choices) {
          const choice = asRecord(rawChoice);
          const delta = asRecord(choice.delta);

          // DeepSeek may emit private chain-of-thought in reasoning_content.
          // Deliberately neither expose nor accumulate that field.
          const text = pickString(delta, ["content"]);
          if (text) {
            yield { type: "text-delta", text };
          }

          const toolCalls = Array.isArray(delta.tool_calls)
            ? delta.tool_calls
            : [];
          for (const rawToolCall of toolCalls) {
            const toolCall = asRecord(rawToolCall);
            const fn = asRecord(toolCall.function);
            const index = pickNumber(toolCall, ["index"]) ?? 0;
            yield {
              type: "tool-call-delta",
              index,
              id: pickString(toolCall, ["id"]),
              name: pickString(fn, ["name"]),
              argumentsDelta: pickString(fn, ["arguments"])
            };
          }

          finishReason = pickString(choice, ["finish_reason"]) ?? finishReason;
        }
      }

      if (!finishReason) {
        throw new ProviderResponseError(
          PROVIDER_ID,
          "DeepSeek stream ended without a finish reason.",
          { retryable: true }
        );
      }
      yield { type: "finish", finishReason, usage, providerRequestId };
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

export interface SseParseLimits {
  maxEventBytes?: number;
  maxStreamBytes?: number;
}

export async function* parseSseJson(
  stream: ReadableStream<Uint8Array>,
  limits: SseParseLimits = {}
): AsyncGenerator<unknown, void, undefined> {
  const maxEventBytes = positiveLimit(
    limits.maxEventBytes,
    DEFAULT_SSE_EVENT_MAX_BYTES,
    "maxEventBytes"
  );
  const maxStreamBytes = positiveLimit(
    limits.maxStreamBytes,
    DEFAULT_SSE_STREAM_MAX_BYTES,
    "maxStreamBytes"
  );
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamBytes = 0;
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      streamBytes += value?.byteLength ?? 0;
      if (streamBytes > maxStreamBytes) {
        throw sseLimitError(`stream exceeds ${maxStreamBytes} bytes`);
      }
      buffer += decoder.decode(value, { stream: !done });
      const normalized = buffer.replace(/\r\n/g, "\n");
      const blocks = normalized.split("\n\n");
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        assertSseEventSize(block, maxEventBytes);
        const value = parseSseBlock(block);
        if (value === SSE_DONE) {
          completed = true;
          return;
        }
        if (value !== undefined) {
          yield value;
        }
      }
      assertSseEventSize(buffer, maxEventBytes);

      if (done) {
        break;
      }
    }

    assertSseEventSize(buffer, maxEventBytes);
    const finalValue = parseSseBlock(buffer);
    if (finalValue !== undefined && finalValue !== SSE_DONE) {
      yield finalValue;
    }
    completed = true;
  } finally {
    if (!completed) {
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

const SSE_DONE = Symbol("sse-done");

function parseSseBlock(block: string): unknown | typeof SSE_DONE | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();

  if (!data) {
    return undefined;
  }
  if (data === "[DONE]") {
    return SSE_DONE;
  }

  try {
    return JSON.parse(data) as unknown;
  } catch (cause) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      "DeepSeek returned malformed SSE JSON.",
      { retryable: true, cause }
    );
  }
}

function assertSseEventSize(block: string, maxBytes: number): void {
  if (Buffer.byteLength(block, "utf8") > maxBytes) {
    throw sseLimitError(`event exceeds ${maxBytes} bytes`);
  }
}

function sseLimitError(detail: string): ProviderResponseError {
  return new ProviderResponseError(PROVIDER_ID, `DeepSeek SSE ${detail}.`, {
    retryable: true
  });
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return resolved;
}

let singleton: DeepSeekModelProvider | undefined;

export function getModelProvider(): ModelProvider {
  singleton ??= new DeepSeekModelProvider();
  return singleton;
}
