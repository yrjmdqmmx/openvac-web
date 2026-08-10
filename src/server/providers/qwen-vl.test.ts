import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConfigurationError,
  ProviderResponseError,
  ProviderTimeoutError
} from "./errors";
import { routeCapabilities } from "./index";
import { QwenVlProvider } from "./qwen-vl";

const WORKSPACE_ID = "workspace-test";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("QwenVlProvider", () => {
  it("sends bounded JPEG/PNG data URLs and returns only text and usage", async () => {
    let sentBody: Record<string, unknown> = {};
    const provider = new QwenVlProvider({
      apiKey: "test-key",
      workspaceId: WORKSPACE_ID,
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          id: "provider-response-id",
          choices: [
            {
              message: {
                role: "assistant",
                content: [{ type: "text", text: "  观察结论  " }],
                reasoning_content: "private provider reasoning"
              },
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
            provider_detail: { image_tokens: 4 }
          },
          provider_metadata: { trace: "must-not-leak" }
        });
      })
    });

    const result = await provider.analyze({
      prompt: "识别真空仪表",
      images: [
        { mimeType: "image/jpeg", bytes: Uint8Array.from([0xff, 0xd8]) },
        { mimeType: "image/png", bytes: Uint8Array.from([0x89, 0x50]) }
      ]
    });

    expect(result).toEqual({
      text: "观察结论",
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 }
    });
    expect(JSON.stringify(result)).not.toContain("provider");
    expect(JSON.stringify(result)).not.toContain("private");

    const messages = sentBody.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "识别真空仪表" });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,/9g=" }
    });
    expect(content[2]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVA=" }
    });
    expect(sentBody).toMatchObject({
      model: "qwen3.8-max",
      max_completion_tokens: 2048,
      reasoning_effort: "none",
      preserve_thinking: false,
      vl_high_resolution_images: false,
      stream: false
    });
    expect(sentBody).not.toHaveProperty("max_tokens");
    expect(sentBody).not.toHaveProperty("enable_thinking");
  });

  it("validates the API key only when an analysis starts", async () => {
    vi.stubEnv("QWEN_VL_API_KEY", "");
    vi.stubEnv("DASHSCOPE_API_KEY", "");
    const provider = new QwenVlProvider({
      apiKey: "",
      workspaceId: WORKSPACE_ID,
      fetch: vi.fn()
    });

    await expect(
      provider.analyze({
        prompt: "analyze",
        images: [{ mimeType: "image/png", bytes: Uint8Array.of(1) }]
      })
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("treats an empty QWEN key as absent and falls back to DASHSCOPE_API_KEY", async () => {
    vi.stubEnv("QWEN_VL_API_KEY", "");
    vi.stubEnv("DASHSCOPE_API_KEY", "fallback-key");
    let authorization = "";
    const provider = new QwenVlProvider({
      workspaceId: WORKSPACE_ID,
      fetch: vi.fn(async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
      })
    });

    await provider.analyze({
      prompt: "analyze",
      images: [{ mimeType: "image/png", bytes: Uint8Array.of(1) }]
    });
    expect(authorization).toBe("Bearer fallback-key");
  });

  it("derives the Beijing workspace endpoint and never needs the global host", async () => {
    let requestedUrl = "";
    const provider = new QwenVlProvider({
      apiKey: "test-key",
      workspaceId: WORKSPACE_ID,
      fetch: vi.fn(async (input) => {
        requestedUrl = String(input);
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      })
    });

    await provider.analyze({
      prompt: "analyze",
      images: [{ mimeType: "image/png", bytes: Uint8Array.of(1) }]
    });
    expect(requestedUrl).toBe(
      "https://workspace-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions"
    );
    expect(requestedUrl).not.toContain("dashscope.aliyuncs.com");
  });

  it("migrates legacy global endpoint environment values without a server edit", async () => {
    vi.stubEnv("DASHSCOPE_WORKSPACE_ID", WORKSPACE_ID);
    vi.stubEnv(
      "QWEN_VL_BASE_URL",
      "https://dashscope.aliyuncs.com/compatible-mode/v1"
    );
    vi.stubEnv("QWEN_VL_ALLOWED_HOSTS", "dashscope.aliyuncs.com");
    vi.stubEnv("QWEN_VL_MODEL", "qwen3-vl-plus");
    let requestedUrl = "";
    const provider = new QwenVlProvider({
      apiKey: "test-key",
      fetch: vi.fn(async (input) => {
        requestedUrl = String(input);
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      })
    });

    await provider.analyze({
      prompt: "analyze",
      images: [{ mimeType: "image/png", bytes: Uint8Array.of(1) }]
    });
    expect(requestedUrl).toContain(
      "workspace-test.cn-beijing.maas.aliyuncs.com"
    );
    expect(requestedUrl).not.toContain("dashscope.aliyuncs.com");
    expect(provider.model).toBe("qwen3.8-max");
  });

  it("streams audited latency and usage without exposing reasoning", async () => {
    let sentBody: Record<string, unknown> = {};
    const provider = new QwenVlProvider({
      apiKey: "test-key",
      workspaceId: WORKSPACE_ID,
      fetch: vi.fn(async (_input, init) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"观察"}}]}',
            "",
            'data: {"choices":[{"delta":{"content":"结论"},"finish_reason":"stop"}]}',
            "",
            'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
            "",
            "data: [DONE]",
            ""
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } }
        );
      })
    });

    const result = await provider.analyzeWithTelemetry({
      prompt: "识别",
      images: [{ mimeType: "image/png", bytes: Uint8Array.of(1) }]
    });

    expect(result).toMatchObject({
      text: "观察结论",
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 }
    });
    expect(result.firstTokenLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(
      result.firstTokenLatencyMs
    );
    expect(sentBody).toMatchObject({
      model: "qwen3.8-max",
      reasoning_effort: "none",
      preserve_thinking: false,
      stream: true,
      stream_options: { include_usage: true }
    });
    expect(sentBody).not.toHaveProperty("enable_thinking");
  });

  it("uses the documented qwen3.8 reasoning effort for audited thinking comparisons", async () => {
    let sentBody: Record<string, unknown> = {};
    const provider = new QwenVlProvider({
      apiKey: "test-key",
      workspaceId: WORKSPACE_ID,
      enableThinking: true,
      fetch: vi.fn(async (_input, init) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      })
    });

    await provider.analyze({
      prompt: "complex diagram",
      images: [{ mimeType: "image/png", bytes: Uint8Array.of(1) }]
    });
    expect(sentBody).toMatchObject({
      model: "qwen3.8-max",
      reasoning_effort: "xhigh",
      preserve_thinking: false
    });
    expect(sentBody).not.toHaveProperty("enable_thinking");
  });

  it("keeps the legacy token parameter only for the comparison baseline", async () => {
    let sentBody: Record<string, unknown> = {};
    const provider = new QwenVlProvider({
      apiKey: "test-key",
      workspaceId: WORKSPACE_ID,
      model: "qwen3-vl-plus",
      fetch: vi.fn(async (_input, init) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      })
    });

    await provider.analyze({
      prompt: "baseline",
      images: [{ mimeType: "image/png", bytes: Uint8Array.of(1) }]
    });
    expect(sentBody).toMatchObject({
      model: "qwen3-vl-plus",
      max_tokens: 2048,
      enable_thinking: false
    });
    expect(sentBody).not.toHaveProperty("max_completion_tokens");
    expect(sentBody).not.toHaveProperty("preserve_thinking");
    expect(sentBody).not.toHaveProperty("reasoning_effort");
  });

  it("requires HTTPS on the exact Beijing workspace host", async () => {
    for (const baseUrl of [
      "http://workspace-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "https://untrusted.example/compatible-mode/v1"
    ]) {
      const provider = new QwenVlProvider({
        apiKey: "test-key",
        workspaceId: WORKSPACE_ID,
        baseUrl,
        allowedHosts: ["workspace-test.cn-beijing.maas.aliyuncs.com"],
        fetch: vi.fn()
      });
      await expect(
        provider.analyze({
          prompt: "analyze",
          images: [{ mimeType: "image/png", bytes: Uint8Array.of(1) }]
        })
      ).rejects.toBeInstanceOf(ConfigurationError);
    }
  });

  it("rejects unsupported media types and oversized image input", async () => {
    const provider = new QwenVlProvider({
      apiKey: "test-key",
      workspaceId: WORKSPACE_ID,
      maxImageBytes: 2,
      maxTotalImageBytes: 3,
      fetch: vi.fn()
    });

    await expect(
      provider.analyze({
        prompt: "analyze",
        images: [
          {
            mimeType: "image/gif" as "image/png",
            bytes: Uint8Array.of(1)
          }
        ]
      })
    ).rejects.toBeInstanceOf(ProviderResponseError);
    await expect(
      provider.analyze({
        prompt: "analyze",
        images: [{ mimeType: "image/png", bytes: Uint8Array.of(1, 2, 3) }]
      })
    ).rejects.toBeInstanceOf(ProviderResponseError);
    await expect(
      provider.analyze({
        prompt: "analyze",
        images: [
          { mimeType: "image/png", bytes: Uint8Array.of(1, 2) },
          { mimeType: "image/jpeg", bytes: Uint8Array.of(3, 4) }
        ]
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining("total limit")
    });
  });

  it("bounds the provider response body", async () => {
    const provider = new QwenVlProvider({
      apiKey: "test-key",
      workspaceId: WORKSPACE_ID,
      maxResponseBytes: 32,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "x".repeat(80) } }]
            })
          )
      )
    });

    await expect(
      provider.analyze({
        prompt: "analyze",
        images: [{ mimeType: "image/png", bytes: Uint8Array.of(1) }]
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining("32-byte limit")
    });
  });

  it("normalizes an unclassified transport failure as retryable without exposing it", async () => {
    const provider = new QwenVlProvider({
      apiKey: "test-key",
      workspaceId: WORKSPACE_ID,
      fetch: vi.fn(async () => {
        throw new TypeError("private network detail request-id=secret");
      })
    });

    const error = await provider
      .analyze({
        prompt: "analyze",
        images: [{ mimeType: "image/png", bytes: Uint8Array.of(1) }]
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      provider: "qwen-vl",
      retryable: true,
      status: undefined,
      message:
        "Qwen-VL transport failed before a provider response was available."
    });
    expect(error).toBeInstanceOf(ProviderResponseError);
    expect(String(error)).not.toMatch(/private|request-id|secret/iu);
  });

  it("preserves provider timeouts for the caller to classify", async () => {
    const timeout = new ProviderTimeoutError("qwen-vl", "fixed timeout");
    const provider = new QwenVlProvider({
      apiKey: "test-key",
      workspaceId: WORKSPACE_ID,
      fetch: vi.fn(async () => {
        throw timeout;
      })
    });

    await expect(
      provider.analyze({
        prompt: "analyze",
        images: [{ mimeType: "image/png", bytes: Uint8Array.of(1) }]
      })
    ).rejects.toBe(timeout);
  });
});

describe("routeCapabilities", () => {
  it("always keeps DeepSeek reasoning and routes media capabilities", () => {
    vi.stubEnv("DASHSCOPE_WORKSPACE_ID", WORKSPACE_ID);
    const textOnly = routeCapabilities({
      hasImages: false,
      hasDocuments: false
    });
    expect(textOnly.reasoningProvider.id).toBe("deepseek-responses");
    expect(textOnly.visionProvider).toBeUndefined();
    expect(textOnly.documentParser).toBeUndefined();

    const multimodal = routeCapabilities({
      hasImages: true,
      hasDocuments: true
    });
    expect(multimodal.reasoningProvider.id).toBe("deepseek-responses");
    expect(multimodal.visionProvider?.id).toBe("qwen-vl");
    expect(multimodal.documentParser?.id).toBe("alibaba-docmind");
  });
});
