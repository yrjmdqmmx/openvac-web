import { describe, expect, it, vi } from "vitest";

import { ConfigurationError, ProviderResponseError } from "./errors";
import { routeCapabilities } from "./index";
import { QwenVlProvider } from "./qwen-vl";

describe("QwenVlProvider", () => {
  it("sends bounded JPEG/PNG data URLs and returns only text and usage", async () => {
    let sentBody: Record<string, unknown> = {};
    const provider = new QwenVlProvider({
      apiKey: "test-key",
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
      model: "qwen3-vl-plus",
      max_tokens: 2048,
      stream: false
    });
  });

  it("validates the API key only when an analysis starts", async () => {
    const provider = new QwenVlProvider({ apiKey: "", fetch: vi.fn() });

    await expect(
      provider.analyze({
        prompt: "analyze",
        images: [{ mimeType: "image/png", bytes: Uint8Array.of(1) }]
      })
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("requires HTTPS on an explicitly trusted host", () => {
    expect(
      () =>
        new QwenVlProvider({
          apiKey: "test-key",
          baseUrl: "http://dashscope.aliyuncs.com/compatible-mode/v1"
        })
    ).toThrow(ConfigurationError);
    expect(
      () =>
        new QwenVlProvider({
          apiKey: "test-key",
          baseUrl: "https://untrusted.example/compatible-mode/v1"
        })
    ).toThrow(ConfigurationError);
  });

  it("rejects unsupported media types and oversized image input", async () => {
    const provider = new QwenVlProvider({
      apiKey: "test-key",
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
});

describe("routeCapabilities", () => {
  it("always keeps DeepSeek reasoning and routes media capabilities", () => {
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
