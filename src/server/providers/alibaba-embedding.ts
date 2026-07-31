import { ProviderResponseError } from "./errors";
import {
  asRecord,
  createProviderDeadline,
  normalizeBaseUrl,
  optionalString,
  pickNumber,
  readJsonResponse,
  requireString
} from "./runtime";
import type { EmbeddingProvider, EmbeddingResult } from "./types";

const PROVIDER_ID = "alibaba-text-embedding";
const MAX_BATCH_SIZE = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface AlibabaEmbeddingOptions {
  apiKey?: string;
  baseUrl?: string;
  workspaceId?: string;
  model?: string;
  dimensions?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

export class AlibabaEmbeddingProvider implements EmbeddingProvider {
  readonly id = PROVIDER_ID;
  readonly model: string;
  readonly dimensions: number;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: AlibabaEmbeddingOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY;
    this.model =
      optionalString(options.model ?? process.env.ALIBABA_EMBEDDING_MODEL) ??
      "text-embedding-v4";
    this.dimensions =
      options.dimensions ??
      Number(process.env.ALIBABA_EMBEDDING_DIMENSIONS ?? 1024);
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ??
        process.env.DASHSCOPE_COMPATIBLE_BASE_URL ??
        compatibleBaseUrl(
          options.workspaceId ?? process.env.DASHSCOPE_WORKSPACE_ID
        )
    );
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return {
        model: this.model,
        dimensions: this.dimensions,
        vectors: []
      };
    }
    if (
      !Number.isInteger(this.dimensions) ||
      this.dimensions <= 0 ||
      this.dimensions > 4096
    ) {
      throw new ProviderResponseError(
        PROVIDER_ID,
        `Invalid embedding dimension ${this.dimensions}.`
      );
    }

    const apiKey = requireString(PROVIDER_ID, "DASHSCOPE_API_KEY", this.apiKey);
    const deadline = createProviderDeadline(
      PROVIDER_ID,
      this.requestTimeoutMs,
      signal
    );
    const vectors: number[][] = [];
    let promptTokens = 0;
    let totalTokens = 0;

    try {
      for (let offset = 0; offset < texts.length; offset += MAX_BATCH_SIZE) {
        const batch = texts.slice(offset, offset + MAX_BATCH_SIZE);
        const response = await this.fetchFn(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: this.model,
            input: batch,
            dimensions: this.dimensions,
            encoding_format: "float"
          }),
          signal: deadline.signal
        });
        const payload = await readJsonResponse(PROVIDER_ID, response);
        const data = Array.isArray(payload.data) ? payload.data : [];

        if (data.length !== batch.length) {
          throw new ProviderResponseError(
            PROVIDER_ID,
            `Embedding response contained ${data.length} vectors for ${batch.length} inputs.`,
            { retryable: true }
          );
        }

        const ordered: unknown[] = Array.from({ length: batch.length });
        for (const [fallbackIndex, entry] of data.entries()) {
          const record = asRecord(entry);
          const index = pickNumber(record, ["index"]) ?? fallbackIndex;
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= batch.length ||
            ordered[index] !== undefined
          ) {
            throw new ProviderResponseError(
              PROVIDER_ID,
              "Embedding response contained an invalid or duplicate input index.",
              { retryable: true }
            );
          }
          ordered[index] = record.embedding;
        }

        for (const vector of ordered) {
          if (
            !Array.isArray(vector) ||
            vector.length !== this.dimensions ||
            vector.some(
              (value) => typeof value !== "number" || !Number.isFinite(value)
            )
          ) {
            throw new ProviderResponseError(
              PROVIDER_ID,
              `Embedding vector did not contain exactly ${this.dimensions} finite numbers.`,
              { retryable: true }
            );
          }
          vectors.push(vector as number[]);
        }

        const usage = asRecord(payload.usage);
        promptTokens += pickNumber(usage, ["prompt_tokens"]) ?? 0;
        totalTokens += pickNumber(usage, ["total_tokens"]) ?? 0;
      }
    } catch (cause) {
      if (deadline.didTimeout()) {
        throw deadline.timeoutError;
      }
      throw cause;
    } finally {
      deadline.dispose();
    }

    return {
      model: this.model,
      dimensions: this.dimensions,
      vectors,
      usage:
        promptTokens > 0 || totalTokens > 0
          ? { promptTokens, totalTokens }
          : undefined
    };
  }
}

function compatibleBaseUrl(workspaceId?: string): string {
  const normalized = optionalString(workspaceId);
  if (normalized) {
    return `https://${normalized}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`;
  }
  return "https://dashscope.aliyuncs.com/compatible-mode/v1";
}

let singleton: AlibabaEmbeddingProvider | undefined;

export function getEmbeddingProvider(): EmbeddingProvider {
  singleton ??= new AlibabaEmbeddingProvider();
  return singleton;
}
