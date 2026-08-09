import { describe, expect, it, vi } from "vitest";

import { DeepSeekResponsesProvider } from "./deepseek-responses";
import { ConfigurationError } from "./errors";
import { createDeepSeekUserPartition } from "./user-partition";

describe("DeepSeekResponsesProvider", () => {
  it("maps the Responses request and consumes semantic SSE through completed", async () => {
    let sentBody: Record<string, unknown> = {};
    const body = streamFromStrings([
      event("response.created", 0, { response: { id: "resp-1" } }),
      event("response.reasoning_text.delta", 1, {
        delta: "private chain of thought"
      }),
      event("response.output_text.delta", 2, { delta: "结构化结论" }),
      event("response.output_item.done", 3, {
        item: {
          type: "function_call",
          call_id: "call-1",
          name: "search_knowledge",
          arguments: '{"query":"真空"}'
        }
      }),
      event("response.web_search_call.completed", 4),
      event("response.completed", 5, {
        response: {
          id: "resp-1",
          output: [
            {
              type: "reasoning",
              id: "reason-1",
              content: [{ type: "reasoning_text", text: "private" }]
            },
            {
              type: "function_call",
              call_id: "call-1",
              name: "search_knowledge",
              arguments: '{"query":"真空"}'
            },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "结构化结论" }]
            }
          ],
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens: 30,
            output_tokens_details: { reasoning_tokens: 20 },
            total_tokens: 130
          }
        }
      })
    ]);
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(body, {
          headers: { "x-request-id": "provider-req-1" }
        });
      }
    );
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        instructions: "Return JSON.",
        input: "问题",
        tools: [
          {
            type: "function",
            name: "search_knowledge",
            description: "Search",
            parameters: { type: "object" },
            strict: true
          },
          { type: "web_search" }
        ],
        toolChoice: "auto",
        reasoningEffort: "high",
        textFormat: {
          type: "json_schema",
          name: "answer_v2",
          schema: { type: "object" },
          strict: true
        },
        maxOutputTokens: 8192,
        user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
      })
    );

    expect(events.slice(0, 4)).toEqual([
      { type: "response-created", responseId: "resp-1" },
      { type: "text-delta", text: "结构化结论" },
      {
        type: "function-call",
        callId: "call-1",
        name: "search_knowledge",
        arguments: '{"query":"真空"}'
      },
      { type: "web-search-status", status: "completed" }
    ]);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "text-delta",
        text: "private chain of thought"
      })
    );
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      status: "completed",
      responseId: "resp-1",
      outputText: "结构化结论",
      providerRequestId: "provider-req-1",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 30,
        reasoningTokens: 20,
        totalTokens: 130
      }
    });
    expect(sentBody).toMatchObject({
      model: "deepseek-v4-flash",
      input: "问题",
      instructions: "Return JSON.",
      tool_choice: "auto",
      reasoning: { effort: "high" },
      text: {
        format: {
          type: "json_schema",
          name: "answer_v2",
          schema: { type: "object" }
        }
      },
      max_output_tokens: 8192,
      stream: true
    });
    expect(sentBody).not.toHaveProperty("text.format.strict");
    expect(sentBody).not.toHaveProperty("tools.0.strict");
  });

  it.each([
    [
      "response.incomplete",
      "incomplete",
      { incomplete_details: { reason: "max_output_tokens" } }
    ],
    [
      "response.failed",
      "failed",
      { error: { code: "server_error", message: "failed upstream" } }
    ]
  ] as const)(
    "maps %s as an explicit terminal status",
    async (type, status, extra) => {
      const provider = new DeepSeekResponsesProvider({
        apiKey: "test-key",
        fetch: vi.fn(
          async () =>
            new Response(
              streamFromStrings([
                event("response.created", 0, { response: { id: "resp-end" } }),
                event(type, 1, {
                  response: { id: "resp-end", output: [], ...extra }
                })
              ])
            )
        )
      });

      const events = await collect(
        provider.stream({ input: "test", user: "ov1_safe-user" })
      );

      expect(events.at(-1)).toMatchObject({
        type: "finish",
        status,
        responseId: "resp-end"
      });
    }
  );

  it("extracts bounded HTTPS sources from search items and URL citations", async () => {
    const body = streamFromStrings([
      event("response.created", 0, { response: { id: "resp-web" } }),
      event("response.completed", 1, {
        response: {
          id: "resp-web",
          output: [
            {
              type: "web_search_call",
              status: "completed",
              action: {
                type: "search",
                sources: [
                  {
                    url: "https://www.pfeiffer-vacuum.com/manual",
                    title: "Pfeiffer manual"
                  }
                ]
              }
            },
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://www.leybold.com/manual",
                      title: "Leybold manual"
                    },
                    {
                      type: "url_citation",
                      url: "http://unsafe.example/manual",
                      title: "Unsafe"
                    }
                  ]
                }
              ]
            }
          ]
        }
      })
    ]);
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(body))
    });

    const events = await collect(
      provider.stream({
        input: "Find a manual",
        tools: [{ type: "web_search" }],
        toolChoice: { type: "web_search" },
        user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
      })
    );

    expect(events.at(-1)).toMatchObject({
      type: "finish",
      completedWebSearchCalls: 1
    });
    expect(events).toContainEqual({
      type: "web-search-sources",
      sources: [
        {
          url: "https://www.pfeiffer-vacuum.com/manual",
          title: "Pfeiffer manual"
        },
        {
          url: "https://www.leybold.com/manual",
          title: "Leybold manual"
        }
      ]
    });
  });

  it.each(["failed", undefined] as const)(
    "does not infer search completion from a terminal item with status %s",
    async (status) => {
      const body = streamFromStrings([
        event("response.created", 0, { response: { id: "resp-web-failed" } }),
        event("response.completed", 1, {
          response: {
            id: "resp-web-failed",
            output: [
              {
                type: "web_search_call",
                ...(status ? { status } : {}),
                action: {
                  sources: [
                    {
                      url: "https://www.leybold.com/manual",
                      title: "Leybold manual"
                    }
                  ]
                }
              }
            ]
          }
        })
      ]);
      const provider = new DeepSeekResponsesProvider({
        apiKey: "test-key",
        fetch: vi.fn(async () => new Response(body))
      });

      const events = await collect(
        provider.stream({
          input: "Find a manual",
          tools: [{ type: "web_search" }],
          toolChoice: { type: "web_search" },
          user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
        })
      );

      expect(events).not.toContainEqual({
        type: "web-search-status",
        status: "completed"
      });
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "web-search-sources" })
      );
    }
  );

  it("uses native URL annotations as proof only for a completed forced-web response", async () => {
    const body = streamFromStrings([
      event("response.created", 0, { response: { id: "resp-web-annotation" } }),
      event("response.completed", 1, {
        response: {
          id: "resp-web-annotation",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://www.leybold.com/manual",
                      title: "Leybold manual"
                    }
                  ]
                }
              ]
            }
          ]
        }
      })
    ]);
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(body))
    });

    const events = await collect(
      provider.stream({
        input: "Find manuals",
        tools: [{ type: "web_search" }],
        toolChoice: { type: "web_search" },
        user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
      })
    );

    expect(events).toContainEqual({
      type: "web-search-sources",
      sources: [
        {
          url: "https://www.leybold.com/manual",
          title: "Leybold manual"
        }
      ]
    });
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      completedWebSearchCalls: 1
    });
  });

  it("does not let URL annotations override an explicit failed web-search call", async () => {
    const body = streamFromStrings([
      event("response.created", 0, {
        response: { id: "resp-web-failed-annotation" }
      }),
      event("response.completed", 1, {
        response: {
          id: "resp-web-failed-annotation",
          output: [
            {
              type: "web_search_call",
              id: "search-failed-1",
              status: "failed"
            },
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://www.leybold.com/manual",
                      title: "Leybold manual"
                    }
                  ]
                }
              ]
            }
          ]
        }
      })
    ]);
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(body))
    });

    const events = await collect(
      provider.stream({
        input: "Find manuals",
        tools: [{ type: "web_search" }],
        toolChoice: { type: "web_search" },
        user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
      })
    );

    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "web-search-sources" })
    );
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      completedWebSearchCalls: 0
    });
  });

  it.each([
    ["streamed status", "response.web_search_call.completed"],
    ["completed output item", "response.output_item.done"]
  ] as const)(
    "lets terminal failure override an earlier same-id %s proof",
    async (_label, proofEventType) => {
      const proofEvent =
        proofEventType === "response.output_item.done"
          ? event(proofEventType, 1, {
              item: {
                type: "web_search_call",
                id: "search-conflict-1",
                status: "completed",
                action: {
                  sources: [
                    {
                      url: "https://www.leybold.com/old",
                      title: "Old result"
                    }
                  ]
                }
              }
            })
          : event(proofEventType, 1, { item_id: "search-conflict-1" });
      const body = streamFromStrings([
        event("response.created", 0, {
          response: { id: "resp-web-conflict" }
        }),
        proofEvent,
        event("response.completed", 2, {
          response: {
            id: "resp-web-conflict",
            output: [
              {
                type: "web_search_call",
                id: "search-conflict-1",
                status: "failed"
              },
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "",
                    annotations: [
                      {
                        type: "url_citation",
                        url: "https://www.leybold.com/manual",
                        title: "Leybold manual"
                      }
                    ]
                  }
                ]
              }
            ]
          }
        })
      ]);
      const provider = new DeepSeekResponsesProvider({
        apiKey: "test-key",
        fetch: vi.fn(async () => new Response(body))
      });

      const events = await collect(
        provider.stream({
          input: "Find manuals",
          tools: [{ type: "web_search" }],
          toolChoice: { type: "web_search" },
          user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
        })
      );

      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "web-search-sources" })
      );
      expect(events.at(-1)).toMatchObject({
        type: "finish",
        completedWebSearchCalls: 0
      });
    }
  );

  it.each(["failed", "incomplete", "cancelled"] as const)(
    "lets a same-id %s event override an earlier completion event",
    async (status) => {
      const body = streamFromStrings([
        event("response.created", 0, {
          response: { id: "resp-web-event-conflict" }
        }),
        event("response.web_search_call.completed", 1, {
          item_id: "search-event-conflict-1"
        }),
        event(`response.web_search_call.${status}`, 2, {
          item_id: "search-event-conflict-1"
        }),
        event("response.completed", 3, {
          response: { id: "resp-web-event-conflict", output: [] }
        })
      ]);
      const provider = new DeepSeekResponsesProvider({
        apiKey: "test-key",
        fetch: vi.fn(async () => new Response(body))
      });

      const events = await collect(
        provider.stream({
          input: "Find manuals",
          tools: [{ type: "web_search" }],
          toolChoice: { type: "web_search" },
          user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
        })
      );

      expect(events.at(-1)).toMatchObject({
        type: "finish",
        completedWebSearchCalls: 0
      });
    }
  );

  it("lets an anonymous terminal failure override anonymous streamed completion", async () => {
    const body = streamFromStrings([
      event("response.created", 0, {
        response: { id: "resp-web-anonymous-conflict" }
      }),
      event("response.output_item.done", 1, {
        item: {
          type: "web_search_call",
          status: "completed",
          action: {
            sources: [
              {
                url: "https://www.leybold.com/old",
                title: "Old result"
              }
            ]
          }
        }
      }),
      event("response.completed", 2, {
        response: {
          id: "resp-web-anonymous-conflict",
          output: [{ type: "web_search_call", status: "failed" }]
        }
      })
    ]);
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(body))
    });

    const events = await collect(
      provider.stream({
        input: "Find manuals",
        tools: [{ type: "web_search" }],
        toolChoice: { type: "web_search" },
        user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
      })
    );

    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "web-search-sources" })
    );
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      completedWebSearchCalls: 0
    });
  });

  it("lets anonymous terminal failure override anonymous terminal completion", async () => {
    const body = streamFromStrings([
      event("response.created", 0, {
        response: { id: "resp-web-anonymous-terminal-conflict" }
      }),
      event("response.completed", 1, {
        response: {
          id: "resp-web-anonymous-terminal-conflict",
          output: [
            {
              type: "web_search_call",
              status: "completed",
              action: {
                sources: [
                  {
                    url: "https://www.leybold.com/old",
                    title: "Old result"
                  }
                ]
              }
            },
            { type: "web_search_call", status: "failed" }
          ]
        }
      })
    ]);
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(body))
    });

    const events = await collect(
      provider.stream({
        input: "Find manuals",
        tools: [{ type: "web_search" }],
        toolChoice: { type: "web_search" },
        user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
      })
    );

    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "web-search-sources" })
    );
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      completedWebSearchCalls: 0
    });
  });

  it("lets anonymous failed event override anonymous terminal completion", async () => {
    const body = streamFromStrings([
      event("response.created", 0, {
        response: { id: "resp-web-anonymous-event-conflict" }
      }),
      event("response.web_search_call.failed", 1),
      event("response.completed", 2, {
        response: {
          id: "resp-web-anonymous-event-conflict",
          output: [
            {
              type: "web_search_call",
              status: "completed",
              action: {
                sources: [
                  {
                    url: "https://www.leybold.com/old",
                    title: "Old result"
                  }
                ]
              }
            }
          ]
        }
      })
    ]);
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(body))
    });

    const events = await collect(
      provider.stream({
        input: "Find manuals",
        tools: [{ type: "web_search" }],
        toolChoice: { type: "web_search" },
        user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
      })
    );

    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "web-search-sources" })
    );
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      completedWebSearchCalls: 0
    });
  });

  it("does not publish terminal sources from an invalidated call id", async () => {
    const body = streamFromStrings([
      event("response.created", 0, {
        response: { id: "resp-web-terminal-conflict" }
      }),
      event("response.completed", 1, {
        response: {
          id: "resp-web-terminal-conflict",
          output: [
            {
              type: "web_search_call",
              id: "search-a",
              status: "completed",
              action: {
                sources: [
                  {
                    url: "https://www.leybold.com/invalidated",
                    title: "Invalidated result"
                  }
                ]
              }
            },
            { type: "web_search_call", id: "search-a", status: "failed" },
            {
              type: "web_search_call",
              id: "search-b",
              status: "completed",
              action: {
                sources: [
                  {
                    url: "https://www.pfeiffer-vacuum.com/valid",
                    title: "Valid result"
                  }
                ]
              }
            }
          ]
        }
      })
    ]);
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(body))
    });

    const events = await collect(
      provider.stream({
        input: "Find manuals",
        tools: [{ type: "web_search" }],
        toolChoice: { type: "web_search" },
        user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
      })
    );

    expect(events).toContainEqual({
      type: "web-search-sources",
      sources: [
        {
          url: "https://www.pfeiffer-vacuum.com/valid",
          title: "Valid result"
        }
      ]
    });
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      completedWebSearchCalls: 1
    });
  });

  it("does not treat URL annotations as search proof without forced web search", async () => {
    const body = streamFromStrings([
      event("response.created", 0, { response: { id: "resp-web-unforced" } }),
      event("response.completed", 1, {
        response: {
          id: "resp-web-unforced",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://www.leybold.com/manual",
                      title: "Leybold manual"
                    }
                  ]
                }
              ]
            }
          ]
        }
      })
    ]);
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(body))
    });

    const events = await collect(
      provider.stream({
        input: "Find manuals",
        tools: [{ type: "web_search" }],
        toolChoice: "auto",
        user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
      })
    );

    expect(events.at(-1)).toMatchObject({
      type: "finish",
      completedWebSearchCalls: 0
    });
  });

  it.each([2, 9])(
    "normalizes streamed and terminal completion proofs to %i calls",
    async (terminalCount) => {
      const body = streamFromStrings([
        event("response.created", 0, { response: { id: "resp-web-count" } }),
        event("response.web_search_call.completed", 1, {
          item_id: "search-1"
        }),
        event("response.completed", 2, {
          response: {
            id: "resp-web-count",
            output: Array.from({ length: terminalCount }, (_, index) => ({
              type: "web_search_call",
              id: `search-${index + 1}`,
              status: "completed",
              action: { sources: [] }
            }))
          }
        })
      ]);
      const provider = new DeepSeekResponsesProvider({
        apiKey: "test-key",
        fetch: vi.fn(async () => new Response(body))
      });

      const events = await collect(
        provider.stream({
          input: "Find manuals",
          tools: [{ type: "web_search" }],
          toolChoice: { type: "web_search" },
          user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
        })
      );

      expect(events.at(-1)).toMatchObject({
        type: "finish",
        completedWebSearchCalls: terminalCount
      });
    }
  );

  it("deduplicates repeated streamed and terminal completion proofs by call id", async () => {
    const body = streamFromStrings([
      event("response.created", 0, { response: { id: "resp-web-dedupe" } }),
      event("response.web_search_call.completed", 1, {
        item_id: "search-1"
      }),
      event("response.web_search_call.completed", 2, {
        item_id: "search-1"
      }),
      event("response.completed", 3, {
        response: {
          id: "resp-web-dedupe",
          output: [
            {
              type: "web_search_call",
              id: "search-1",
              status: "completed",
              action: { sources: [] }
            },
            {
              type: "web_search_call",
              id: "search-1",
              status: "completed",
              action: { sources: [] }
            }
          ]
        }
      })
    ]);
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(body))
    });

    const events = await collect(
      provider.stream({
        input: "Find manuals",
        tools: [{ type: "web_search" }],
        toolChoice: { type: "web_search" },
        user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
      })
    );

    expect(events.at(-1)).toMatchObject({
      type: "finish",
      completedWebSearchCalls: 1
    });
  });

  it("accepts a completed web search proved only by output_item.done", async () => {
    const body = streamFromStrings([
      event("response.created", 0, { response: { id: "resp-web-done" } }),
      event("response.output_item.done", 1, {
        item: {
          type: "web_search_call",
          id: "search-done-1",
          status: "completed",
          action: {
            sources: [
              {
                url: "https://www.leybold.com/manual",
                title: "Leybold manual"
              }
            ]
          }
        }
      }),
      event("response.completed", 2, {
        response: { id: "resp-web-done", output: [] }
      })
    ]);
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response(body))
    });

    const events = await collect(
      provider.stream({
        input: "Find manuals",
        tools: [{ type: "web_search" }],
        toolChoice: { type: "web_search" },
        user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
      })
    );

    expect(events).toContainEqual({
      type: "web-search-sources",
      sources: [
        {
          url: "https://www.leybold.com/manual",
          title: "Leybold manual"
        }
      ]
    });
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      completedWebSearchCalls: 1
    });
  });

  it("drops duplicate events and rejects a backwards sequence", async () => {
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(
        async () =>
          new Response(
            streamFromStrings([
              event("response.created", 0, { response: { id: "resp-seq" } }),
              event("response.output_text.delta", 1, { delta: "once" }),
              event("response.output_text.delta", 1, { delta: "duplicate" }),
              event("response.output_text.delta", 0, { delta: "backwards" })
            ])
          )
      )
    });

    await expect(
      collect(provider.stream({ input: "test", user: "ov1_safe-user" }))
    ).rejects.toMatchObject({
      name: "ProviderResponseError",
      retryable: true
    });
  });

  it("fails closed when the terminal semantic event is missing", async () => {
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(
        async () =>
          new Response(
            streamFromStrings([
              event("response.created", 0, { response: { id: "resp-cut" } })
            ])
          )
      )
    });

    await expect(
      collect(provider.stream({ input: "test", user: "ov1_safe-user" }))
    ).rejects.toMatchObject({
      name: "ProviderResponseError",
      retryable: true
    });
  });

  it("ignores keep-alives and emits parallel function calls once", async () => {
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(
        async () =>
          new Response(
            streamFromStrings([
              ": keep-alive\n\n",
              event("response.created", 0, { response: { id: "resp-tools" } }),
              event("response.output_item.done", 1, {
                item: {
                  type: "function_call",
                  call_id: "call-a",
                  name: "calculate_throughput",
                  arguments: "{}"
                }
              }),
              ": ping\n\n",
              event("response.output_item.done", 2, {
                item: {
                  type: "function_call",
                  call_id: "call-b",
                  name: "classify_flow_regime",
                  arguments: "{}"
                }
              }),
              event("response.completed", 3, {
                response: { id: "resp-tools", output: [] }
              })
            ])
          )
      )
    });

    const events = await collect(
      provider.stream({ input: "test", user: "ov1_safe-user" })
    );
    expect(events.filter((event) => event.type === "function-call")).toEqual([
      expect.objectContaining({ callId: "call-a" }),
      expect.objectContaining({ callId: "call-b" })
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      status: "completed"
    });
  });

  it.each([
    "http://api.deepseek.com",
    "https://api.deepseek.com.evil.example",
    "https://user:password@api.deepseek.com"
  ])("rejects an untrusted base URL: %s", (baseUrl) => {
    expect(
      () =>
        new DeepSeekResponsesProvider({
          apiKey: "test-key",
          baseUrl,
          allowedHosts: ["api.deepseek.com"]
        })
    ).toThrow(ConfigurationError);
  });
});

describe("createDeepSeekUserPartition", () => {
  it("is stable, versioned, and does not disclose the account subject", () => {
    const secret = "s".repeat(32);
    const value = createDeepSeekUserPartition("user@example.com", secret);

    expect(value).toBe(createDeepSeekUserPartition("user@example.com", secret));
    expect(value).not.toContain("user");
    expect(value).not.toContain("example");
    expect(value).toMatch(/^ov1_[A-Za-z0-9_-]{43}$/);
    expect(createDeepSeekUserPartition("other@example.com", secret)).not.toBe(
      value
    );
  });

  it("requires a strong partition secret", () => {
    expect(() => createDeepSeekUserPartition("internal-id", "short")).toThrow(
      ConfigurationError
    );
  });
});

function event(
  type: string,
  sequenceNumber: number,
  fields: Record<string, unknown> = {}
): string {
  return `data: ${JSON.stringify({
    type,
    sequence_number: sequenceNumber,
    ...fields
  })}\n\n`;
}

function streamFromStrings(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
