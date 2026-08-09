import { ProviderError, ProviderResponseError } from "./errors";
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
import type {
  ModelUsage,
  VisionCapabilities,
  VisionProvider,
  VisionRequest,
  VisionResult
} from "./types";

const PROVIDER_ID = "qwen-vl";
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3-vl-plus";
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
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
  model?: string;
  defaultMaxOutputTokens?: number;
  requestTimeoutMs?: number;
  maxImages?: number;
  maxImageBytes?: number;
  maxTotalImageBytes?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  allowedHosts?: string[];
}

export class QwenVlProvider implements VisionProvider {
  readonly id = PROVIDER_ID;
  readonly model: string;
  readonly capabilities: VisionCapabilities;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultMaxOutputTokens: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: QwenVlProviderOptions = {}) {
    this.apiKey =
      options.apiKey ??
      process.env.QWEN_VL_API_KEY ??
      process.env.DASHSCOPE_API_KEY;
    this.baseUrl = normalizeTrustedHttpsBaseUrl(
      PROVIDER_ID,
      options.baseUrl ?? process.env.QWEN_VL_BASE_URL ?? DEFAULT_BASE_URL,
      options.allowedHosts ??
        parseCommaSeparated(
          process.env.QWEN_VL_ALLOWED_HOSTS ?? "dashscope.aliyuncs.com"
        )
    );
    this.model =
      optionalString(options.model ?? process.env.QWEN_VL_MODEL) ??
      DEFAULT_MODEL;
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
      const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            ...(request.systemPrompt?.trim()
              ? [
                  {
                    role: "system",
                    content: request.systemPrompt.trim()
                  }
                ]
              : []),
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                ...request.images.map((image) => ({
                  type: "image_url",
                  image_url: {
                    url: `data:${image.mimeType};base64,${Buffer.from(
                      image.bytes
                    ).toString("base64")}`
                  }
                }))
              ]
            }
          ],
          max_tokens: maxOutputTokens,
          stream: false
        }),
        signal: deadline.signal
      });
      const body = await readJsonResponse(
        PROVIDER_ID,
        response,
        this.capabilities.maxResponseBytes
      );
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const message = asRecord(asRecord(choices[0]).message);
      const text = extractText(message.content);
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

let singleton: QwenVlProvider | undefined;

export function getVisionProvider(): VisionProvider {
  singleton ??= new QwenVlProvider();
  return singleton;
}
