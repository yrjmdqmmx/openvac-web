import { ProviderError, ProviderResponseError } from "./errors";
import { parseSseJson } from "./deepseek";
import {
  asRecord,
  createProviderDeadline,
  optionalString,
  parseCommaSeparated,
  pickNumber,
  pickString,
  readJsonResponse,
  requireString,
  resolveBailianBeijingCompatibleEndpoint
} from "./runtime";
import type {
  ModelUsage,
  VisionCapabilities,
  VisionProvider,
  VisionRequest,
  VisionResult
} from "./types";

const PROVIDER_ID = "qwen-vl";
const DEFAULT_MODEL = "qwen3.8-max";
const LEGACY_GLOBAL_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const LEGACY_GLOBAL_HOST = "dashscope.aliyuncs.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 150_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_THINKING_BUDGET_TOKENS = 4096;
const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const IMAGE_MIME_TYPES = ["image/jpeg", "image/png"] as const;

export const QWEN_VL_CAPABILITIES = {
  protocol: "openai-chat-completions",
  imageMimeTypes: IMAGE_MIME_TYPES,
  maxImages: DEFAULT_MAX_IMAGES,
  maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
  maxTotalImageBytes: DEFAULT_MAX_TOTAL_IMAGE_BYTES,
  maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  providerMetadataExposed: false
} as const satisfies VisionCapabilities;

export interface QwenVlProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  workspaceId?: string;
  model?: string;
  enableThinking?: boolean;
  thinkingBudgetTokens?: number;
  highResolutionImages?: boolean;
  defaultMaxOutputTokens?: number;
  requestTimeoutMs?: number;
  maxImages?: number;
  maxImageBytes?: number;
  maxTotalImageBytes?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  allowedHosts?: string[];
}

export interface QwenVlTelemetryResult extends VisionResult {
  firstTokenLatencyMs: number;
  totalDurationMs: number;
}

export class QwenVlOutputTruncatedError extends ProviderResponseError {
  constructor() {
    super(PROVIDER_ID, "Qwen-VL output reached its configured token limit.");
    this.name = "QwenVlOutputTruncatedError";
  }
}

export class QwenVlProvider implements VisionProvider {
  readonly id = PROVIDER_ID;
  readonly model: string;
  readonly capabilities: VisionCapabilities;

  private readonly apiKey?: string;
  private readonly configuredBaseUrl?: string;
  private readonly workspaceId?: string;
  private readonly allowedHosts: readonly string[];
  private readonly defaultMaxOutputTokens: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly enableThinking: boolean;
  readonly thinkingBudgetTokens: number;
  private readonly highResolutionImages: boolean;

  constructor(options: QwenVlProviderOptions = {}) {
    this.apiKey =
      optionalString(options.apiKey) ??
      optionalString(process.env.QWEN_VL_API_KEY) ??
      optionalString(process.env.DASHSCOPE_API_KEY);
    const configuredBaseUrl = optionalString(process.env.QWEN_VL_BASE_URL);
    const configuredAllowedHosts = parseCommaSeparated(
      process.env.QWEN_VL_ALLOWED_HOSTS
    ).filter((host) => host !== LEGACY_GLOBAL_HOST);
    this.configuredBaseUrl =
      optionalString(options.baseUrl) ??
      (configuredBaseUrl?.replace(/\/+$/u, "") === LEGACY_GLOBAL_BASE_URL
        ? undefined
        : configuredBaseUrl);
    this.workspaceId =
      optionalString(options.workspaceId) ??
      optionalString(process.env.DASHSCOPE_WORKSPACE_ID);
    this.allowedHosts = options.allowedHosts ?? configuredAllowedHosts;
    this.model = optionalString(options.model) ?? configuredQwenVlModel();
    this.defaultMaxOutputTokens = positiveInteger(
      options.defaultMaxOutputTokens ??
        Number(
          process.env.QWEN_VL_MAX_OUTPUT_TOKENS ?? DEFAULT_MAX_OUTPUT_TOKENS
        ),
      "defaultMaxOutputTokens"
    );
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs"
    );
    this.fetchFn = options.fetch ?? fetch;
    this.enableThinking =
      options.enableThinking ??
      booleanEnvironment("QWEN_VL_ENABLE_THINKING", true);
    this.thinkingBudgetTokens = positiveInteger(
      options.thinkingBudgetTokens ??
        Number(
          process.env.QWEN_VL_THINKING_BUDGET ?? DEFAULT_THINKING_BUDGET_TOKENS
        ),
      "thinkingBudgetTokens"
    );
    this.highResolutionImages =
      options.highResolutionImages ??
      booleanEnvironment("QWEN_VL_HIGH_RESOLUTION_IMAGES", false);

    const maxImages = positiveInteger(
      options.maxImages ?? DEFAULT_MAX_IMAGES,
      "maxImages"
    );
    const maxImageBytes = positiveInteger(
      options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      "maxImageBytes"
    );
    const maxTotalImageBytes = positiveInteger(
      options.maxTotalImageBytes ?? DEFAULT_MAX_TOTAL_IMAGE_BYTES,
      "maxTotalImageBytes"
    );
    const maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes"
    );
    this.capabilities = {
      ...QWEN_VL_CAPABILITIES,
      maxImages,
      maxImageBytes,
      maxTotalImageBytes,
      maxResponseBytes
    };
  }

  async analyze(request: VisionRequest): Promise<VisionResult> {
    const apiKey = requireString(
      PROVIDER_ID,
      "QWEN_VL_API_KEY or DASHSCOPE_API_KEY",
      this.apiKey
    );
    const prompt = request.prompt.trim();
    if (!prompt) {
      throw new TypeError("Vision prompt must not be empty.");
    }
    assertImages(request, this.capabilities);
    const maxOutputTokens = positiveInteger(
      request.maxOutputTokens ?? this.defaultMaxOutputTokens,
      "maxOutputTokens"
    );
    const deadline = createProviderDeadline(
      PROVIDER_ID,
      this.requestTimeoutMs,
      request.signal
    );

    try {
      const response = await this.fetchFn(
        `${this.resolveBaseUrl()}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(
            this.requestBody(request, prompt, maxOutputTokens, false)
          ),
          signal: deadline.signal
        }
      );
      const body = await readJsonResponse(
        PROVIDER_ID,
        response,
        this.capabilities.maxResponseBytes
      );
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const choice = asRecord(choices[0]);
      const message = asRecord(choice.message);
      const text = extractText(message.content);
      if (pickString(choice, ["finish_reason"]) === "length") {
        throw new QwenVlOutputTruncatedError();
      }
      if (!text) {
        throw new ProviderResponseError(
          PROVIDER_ID,
          "Qwen-VL response omitted analysis text.",
          { retryable: true }
        );
      }

      return {
        text,
        usage: parseUsage(body.usage)
      };
    } catch (cause) {
      if (deadline.didTimeout()) {
        throw deadline.timeoutError;
      }
      if (cause instanceof ProviderError || request.signal?.aborted) {
        throw cause;
      }
      throw new ProviderResponseError(
        PROVIDER_ID,
        "Qwen-VL transport failed before a provider response was available.",
        { retryable: true, cause }
      );
    } finally {
      deadline.dispose();
    }
  }

  /** Audited streaming path used by the staging visual benchmark only. */
  async analyzeWithTelemetry(
    request: VisionRequest
  ): Promise<QwenVlTelemetryResult> {
    const apiKey = requireString(
      PROVIDER_ID,
      "QWEN_VL_API_KEY or DASHSCOPE_API_KEY",
      this.apiKey
    );
    const prompt = request.prompt.trim();
    if (!prompt) throw new TypeError("Vision prompt must not be empty.");
    assertImages(request, this.capabilities);
    const maxOutputTokens = positiveInteger(
      request.maxOutputTokens ?? this.defaultMaxOutputTokens,
      "maxOutputTokens"
    );
    const deadline = createProviderDeadline(
      PROVIDER_ID,
      this.requestTimeoutMs,
      request.signal
    );
    const startedAt = performance.now();

    try {
      const response = await this.fetchFn(
        `${this.resolveBaseUrl()}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(
            this.requestBody(request, prompt, maxOutputTokens, true)
          ),
          signal: deadline.signal
        }
      );
      if (!response.ok) {
        await readJsonResponse(
          PROVIDER_ID,
          response,
          this.capabilities.maxResponseBytes
        );
      }
      if (!response.body) {
        throw new ProviderResponseError(
          PROVIDER_ID,
          "Qwen-VL returned an empty streaming response.",
          { retryable: true }
        );
      }

      let text = "";
      let firstTokenLatencyMs: number | undefined;
      let finishReason: string | undefined;
      let usage: ModelUsage | undefined;
      for await (const event of parseSseJson(response.body, {
        maxEventBytes: 256 * 1024,
        maxStreamBytes: this.capabilities.maxResponseBytes
      })) {
        const record = asRecord(event);
        const usageRecord = asRecord(record.usage);
        if (Object.keys(usageRecord).length > 0) {
          usage = parseUsage(usageRecord);
        }
        const choices = Array.isArray(record.choices) ? record.choices : [];
        for (const rawChoice of choices) {
          const choice = asRecord(rawChoice);
          const delta = asRecord(choice.delta);
          const fragment = extractText(delta.content);
          if (fragment) {
            firstTokenLatencyMs ??= Math.max(
              0,
              Math.round(performance.now() - startedAt)
            );
            text += fragment;
          }
          finishReason = pickString(choice, ["finish_reason"]) ?? finishReason;
        }
      }

      if (finishReason === "length") {
        throw new QwenVlOutputTruncatedError();
      }
      if (!text.trim() || !finishReason || firstTokenLatencyMs === undefined) {
        throw new ProviderResponseError(
          PROVIDER_ID,
          "Qwen-VL streaming response was incomplete.",
          { retryable: true }
        );
      }
      return {
        text: text.trim(),
        usage,
        firstTokenLatencyMs,
        totalDurationMs: Math.max(0, Math.round(performance.now() - startedAt))
      };
    } catch (cause) {
      if (deadline.didTimeout()) throw deadline.timeoutError;
      if (cause instanceof ProviderError || request.signal?.aborted)
        throw cause;
      throw new ProviderResponseError(
        PROVIDER_ID,
        "Qwen-VL streaming transport failed before a provider response was available.",
        { retryable: true, cause }
      );
    } finally {
      deadline.dispose();
    }
  }

  private requestBody(
    request: VisionRequest,
    prompt: string,
    maxOutputTokens: number,
    stream: boolean
  ): Record<string, unknown> {
    const isQwen38Max = this.model === "qwen3.8-max";
    return {
      model: this.model,
      messages: [
        ...(request.systemPrompt?.trim()
          ? [{ role: "system", content: request.systemPrompt.trim() }]
          : []),
        {
          role: "user",
          content: [
            ...request.images.map((image) => ({
              type: "image_url",
              image_url: {
                url: `data:${image.mimeType};base64,${Buffer.from(
                  image.bytes
                ).toString("base64")}`
              }
            })),
            { type: "text", text: prompt }
          ]
        }
      ],
      ...(this.model === "qwen3-vl-plus"
        ? { max_tokens: maxOutputTokens }
        : {
            max_completion_tokens: this.enableThinking
              ? positiveInteger(
                  this.thinkingBudgetTokens + maxOutputTokens,
                  "maxCompletionTokens"
                )
              : maxOutputTokens
          }),
      ...(isQwen38Max
        ? this.enableThinking
          ? {
              enable_thinking: true,
              thinking_budget: this.thinkingBudgetTokens,
              preserve_thinking: false
            }
          : { enable_thinking: false, preserve_thinking: false }
        : { enable_thinking: this.enableThinking }),
      vl_high_resolution_images: this.highResolutionImages,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {})
    };
  }

  private resolveBaseUrl(): string {
    return resolveBailianBeijingCompatibleEndpoint(PROVIDER_ID, {
      baseUrl: this.configuredBaseUrl,
      workspaceId: requireString(
        PROVIDER_ID,
        "DASHSCOPE_WORKSPACE_ID",
        this.workspaceId
      ),
      allowedHosts: this.allowedHosts
    }).baseUrl;
  }
}

function assertImages(
  request: VisionRequest,
  capabilities: VisionCapabilities
): void {
  if (
    request.images.length === 0 ||
    request.images.length > capabilities.maxImages
  ) {
    throw new ProviderResponseError(
      PROVIDER_ID,
      `Qwen-VL accepts between 1 and ${capabilities.maxImages} images.`
    );
  }

  let totalBytes = 0;
  for (const image of request.images) {
    if (!capabilities.imageMimeTypes.includes(image.mimeType)) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        "Qwen-VL accepts JPEG and PNG images only."
      );
    }
    if (!(image.bytes instanceof Uint8Array)) {
      throw new TypeError("Vision image bytes must be a Uint8Array.");
    }
    if (
      image.bytes.byteLength === 0 ||
      image.bytes.byteLength > capabilities.maxImageBytes
    ) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        `Each Qwen-VL image must be between 1 and ${capabilities.maxImageBytes} bytes.`
      );
    }
    totalBytes += image.bytes.byteLength;
    if (totalBytes > capabilities.maxTotalImageBytes) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        `Qwen-VL image input exceeds the ${capabilities.maxTotalImageBytes}-byte total limit.`
      );
    }
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      return pickString(record, ["text"]) ?? "";
    })
    .join("")
    .trim();
}

function parseUsage(value: unknown): ModelUsage | undefined {
  const usage = asRecord(value);
  if (Object.keys(usage).length === 0) return undefined;
  return {
    inputTokens: pickNumber(usage, ["prompt_tokens", "input_tokens"]),
    outputTokens: pickNumber(usage, ["completion_tokens", "output_tokens"]),
    totalTokens: pickNumber(usage, ["total_tokens"])
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function booleanEnvironment(name: string, fallback: boolean): boolean {
  const value = optionalString(process.env[name]);
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be true or false.`);
}

let singleton: QwenVlProvider | undefined;

export function configuredQwenVlModel(): string {
  const configured = optionalString(process.env.QWEN_VL_MODEL);
  return !configured || configured === "qwen3-vl-plus"
    ? DEFAULT_MODEL
    : configured;
}

export function getVisionProvider(): VisionProvider {
  singleton ??= new QwenVlProvider();
  return singleton;
}
