import { describe, expect, it, vi } from "vitest";

import { AlibabaEmbeddingProvider } from "./alibaba-embedding";
import { DeepSeekModelProvider, parseSseJson } from "./deepseek";
import {
  ConfigurationError,
  ProviderResponseError,
  ProviderTimeoutError
} from "./errors";
import { AlibabaDirectMailProvider, getEmailProvider } from "./directmail";
import { readJsonResponse } from "./runtime";

describe("DeepSeekModelProvider", () => {
  it("streams answer text while discarding reasoning_content", async () => {
    const body = streamFromStrings([
      'data: {"choices":[{"delta":{"reasoning_content":"private thought"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"结论"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"more private","tool_calls":[{"index":0,"function":{"arguments":"\\"pump\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n"
    ]);
    let sentBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(body, {
          headers: { "x-request-id": "deepseek-request-1" }
        });
      }
    );
    const provider = new DeepSeekModelProvider({
      apiKey: "test-key",
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        messages: [{ role: "user", content: "问题" }]
      })
    );

    expect(events).toEqual([
      { type: "text-delta", text: "结论" },
      {
        type: "tool-call-delta",
        index: 0,
        id: "call-1",
        name: "lookup",
        argumentsDelta: '{"q":'
      },
      {
        type: "tool-call-delta",
        index: 0,
        id: undefined,
        name: undefined,
        argumentsDelta: '"pump"}'
      },
      {
        type: "finish",
        finishReason: "tool_calls",
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5
        },
        providerRequestId: "deepseek-request-1"
      }
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(sentBody.model).toBe("deepseek-v4-flash");
    expect(sentBody.thinking).toEqual({ type: "disabled" });
    expect(sentBody.temperature).toBeUndefined();
  });

  it("does not validate secrets during construction", async () => {
    const provider = new DeepSeekModelProvider({
      apiKey: "",
      fetch: vi.fn()
    });
    await expect(
      collect(
        provider.stream({
          messages: [{ role: "user", content: "test" }]
        })
      )
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("treats a truncated stream as retryable failure", async () => {
    const provider = new DeepSeekModelProvider({
      apiKey: "test-key",
      fetch: vi.fn(
        async () =>
          new Response(
            streamFromStrings([
              'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
            ])
          )
      )
    });

    await expect(
      collect(
        provider.stream({
          messages: [{ role: "user", content: "test" }]
        })
      )
    ).rejects.toMatchObject({
      name: "ProviderResponseError",
      retryable: true
    });
  });

  it("rejects a delimiter-free SSE buffer that exceeds the event limit", async () => {
    await expect(
      collect(
        parseSseJson(streamFromStrings([`data: ${"x".repeat(128)}`]), {
          maxEventBytes: 64,
          maxStreamBytes: 1024
        })
      )
    ).rejects.toMatchObject({
      name: "ProviderResponseError",
      retryable: true
    });
  });

  it("rejects a delimited SSE event that exceeds the event limit", async () => {
    await expect(
      collect(
        parseSseJson(
          streamFromStrings([`data: {"value":"${"x".repeat(128)}"}\n\n`]),
          {
            maxEventBytes: 64,
            maxStreamBytes: 1024
          }
        )
      )
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("rejects an SSE stream that exceeds its total byte limit", async () => {
    await expect(
      collect(
        parseSseJson(
          streamFromStrings([
            'data: {"value":"first"}\n\n',
            'data: {"value":"second"}\n\n'
          ]),
          {
            maxEventBytes: 128,
            maxStreamBytes: 32
          }
        )
      )
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });
});

describe("AlibabaEmbeddingProvider", () => {
  it("splits requests into batches of at most ten and preserves order", async () => {
    const batches: string[][] = [];
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          input: string[];
          dimensions: number;
        };
        batches.push(body.input);
        return Response.json({
          data: body.input
            .map((text, index) => ({
              index,
              embedding: [Number(text.slice(1)), body.dimensions, index]
            }))
            .reverse(),
          usage: { prompt_tokens: body.input.length }
        });
      }
    );
    const provider = new AlibabaEmbeddingProvider({
      apiKey: "test-key",
      dimensions: 3,
      fetch: fetchMock
    });
    const texts = Array.from({ length: 23 }, (_value, index) => `t${index}`);

    const result = await provider.embed(texts);

    expect(batches.map((batch) => batch.length)).toEqual([10, 10, 3]);
    expect(result.vectors.map((vector) => vector[0])).toEqual(
      Array.from({ length: 23 }, (_value, index) => index)
    );
    expect(result.usage?.promptTokens).toBe(23);
  });
});

describe("provider construction", () => {
  it("constructs the DirectMail provider with its runtime SDK linked", () => {
    expect(() => new AlibabaDirectMailProvider({})).not.toThrow();
    expect(getEmailProvider()).toHaveProperty(
      "sendTransactional",
      expect.any(Function)
    );
  });
});

describe("provider response resource limits", () => {
  it("rejects a streamed JSON body larger than its byte limit", async () => {
    const response = new Response(
      streamFromStrings(['{"value":"', "0123456789", '"}'])
    );

    await expect(
      readJsonResponse("test-provider", response, 16)
    ).rejects.toMatchObject({
      name: "ProviderResponseError",
      message: expect.stringContaining("16-byte limit")
    });
  });

  it("rejects an oversized declared JSON response before parsing", async () => {
    const response = new Response('{"value":"ok"}', {
      headers: { "content-length": "65" }
    });

    await expect(
      readJsonResponse("test-provider", response, 64)
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("preserves valid JSON responses below the byte limit", async () => {
    await expect(
      readJsonResponse("test-provider", new Response('{"value":"ok"}'), 64)
    ).resolves.toEqual({ value: "ok" });
  });
});

describe("provider wall-clock deadlines", () => {
  it("bounds a DeepSeek stream request", async () => {
    const provider = new DeepSeekModelProvider({
      apiKey: "test-key",
      requestTimeoutMs: 10,
      fetch: vi.fn(abortAwareNeverFetch)
    });

    await expect(
      collect(
        provider.stream({
          messages: [{ role: "user", content: "test" }]
        })
      )
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it("keeps the DeepSeek deadline active while reading the response body", async () => {
    const provider = new DeepSeekModelProvider({
      apiKey: "test-key",
      requestTimeoutMs: 10,
      fetch: vi.fn(async (_input, init) => {
        const signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener(
                "abort",
                () => controller.error(signal.reason),
                { once: true }
              );
            }
          })
        );
      })
    });

    await expect(
      collect(
        provider.stream({
          messages: [{ role: "user", content: "test" }]
        })
      )
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it("bounds an embedding request", async () => {
    const provider = new AlibabaEmbeddingProvider({
      apiKey: "test-key",
      dimensions: 3,
      requestTimeoutMs: 10,
      fetch: vi.fn(abortAwareNeverFetch)
    });

    await expect(provider.embed(["test"])).rejects.toBeInstanceOf(
      ProviderTimeoutError
    );
  });
});

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) {
    result.push(value);
  }
  return result;
}

function streamFromStrings(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

function abortAwareNeverFetch(
  _input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true
    });
  });
}
