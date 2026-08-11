import { describe, expect, it, vi } from "vitest";

import { DeepSeekResponsesProvider } from "./deepseek-responses";
import { ConfigurationError } from "./errors";
import type { ResponsesStreamRequest } from "./types";
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
              id: "fc-call-1",
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
    const finish = events.at(-1);
    expect(
      finish?.type === "finish"
        ? finish.continuationItems.filter(
            (item) => item.type === "function_call" && item.call_id === "call-1"
          )
        : []
    ).toHaveLength(1);
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

  it("emits a function call that appears only in the terminal response", async () => {
    const body = streamFromStrings([
      event("response.created", 0, { response: { id: "resp-terminal-call" } }),
      event("response.completed", 1, {
        response: {
          id: "resp-terminal-call",
          output: [
            {
              type: "function_call",
              call_id: "call-terminal-pumpdown",
              name: "estimate_pumpdown_time",
              arguments:
                '{"volume":{"value":100,"unit":"L"},"pumpingSpeed":{"value":10,"unit":"L/s"},"initialPressure":{"value":100,"unit":"Pa"},"targetPressure":{"value":1,"unit":"Pa"},"outputUnit":"s"}'
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
        input: "Calculate pumpdown time",
        user: "ov1_abcdefghijklmnopqrstuvwxyz0123456789_-"
      })
    );

    expect(events).toContainEqual({
      type: "function-call",
      callId: "call-terminal-pumpdown",
      name: "estimate_pumpdown_time",
      arguments:
        '{"volume":{"value":100,"unit":"L"},"pumpingSpeed":{"value":10,"unit":"L/s"},"initialPressure":{"value":100,"unit":"Pa"},"targetPressure":{"value":1,"unit":"Pa"},"outputUnit":"s"}'
    });
    expect(
      events.filter(
        (event) =>
          event.type === "function-call" &&
          event.callId === "call-terminal-pumpdown"
      )
    ).toHaveLength(1);
  });

  it("maps a forced function to one required tool without structured text", async () => {
    let sentBody: Record<string, unknown> = {};
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          streamFromStrings([
            event("response.created", 0, {
              response: { id: "resp-forced" }
            }),
            event("response.completed", 1, {
              response: { id: "resp-forced", output: [] }
            })
          ])
        );
      })
    });

    await collect(
      provider.stream({
        input: "Calculate",
        tools: [
          {
            type: "function",
            name: "estimate_pumpdown_time",
            description: "Calculate pumpdown time",
            parameters: {
              type: "object",
              additionalProperties: false,
              required: [
                "volume",
                "pumpingSpeed",
                "initialPressure",
                "targetPressure"
              ],
              properties: {
                volume: { type: "object" },
                pumpingSpeed: { type: "object" },
                initialPressure: { type: "object" },
                targetPressure: { type: "object" },
                gasLoad: { type: "object" },
                outputUnit: { enum: ["s", "min", "h"] }
              }
            },
            strict: true
          },
          {
            type: "function",
            name: "search_knowledge",
            description: "Search",
            parameters: { type: "object" },
            strict: true
          }
        ],
        toolChoice: { type: "function", name: "estimate_pumpdown_time" },
        reasoningEffort: "high",
        textFormat: {
          type: "json_schema",
          name: "answer_v3",
          schema: { type: "object" },
          strict: true
        },
        user: "ov1_safe-user"
      })
    );

    expect(sentBody).toMatchObject({
      tool_choice: "required",
      tools: [
        {
          type: "function",
          name: "estimate_pumpdown_time",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: [
              "volume",
              "pumpingSpeed",
              "initialPressure",
              "targetPressure"
            ],
            properties: {
              volume: {
                type: "object",
                required: ["value", "unit"],
                properties: {
                  value: { type: "number" },
                  unit: { type: "string", enum: expect.arrayContaining(["L"]) }
                }
              },
              pumpingSpeed: {
                type: "object",
                properties: {
                  unit: {
                    type: "string",
                    enum: expect.arrayContaining(["L/s"])
                  }
                }
              },
              initialPressure: {
                type: "object",
                properties: {
                  unit: {
                    type: "string",
                    enum: expect.arrayContaining(["Pa"])
                  }
                }
              },
              targetPressure: {
                type: "object",
                properties: {
                  unit: {
                    type: "string",
                    enum: expect.arrayContaining(["Pa"])
                  }
                }
              }
            }
          }
        }
      ],
      reasoning: { effort: "none" }
    });
    expect(sentBody).not.toHaveProperty("text");
    expect(sentBody).not.toHaveProperty("tools.0.strict");
    expect(sentBody).not.toHaveProperty(
      "tools.0.parameters.properties.gasLoad"
    );
    expect(sentBody).not.toHaveProperty(
      "tools.0.parameters.properties.outputUnit"
    );
  });

  it("routes a fresh artifact JSON repair through one beta strict tool call", async () => {
    let sentUrl = "";
    let sentRedirect: RequestRedirect | undefined;
    let sentBody: Record<string, unknown> = {};
    const argumentsJson = JSON.stringify({
      schemaVersion: "openvac.artifact.v1",
      kind: "diagnosis_report",
      title: "诊断记录",
      formats: ["md"],
      summary: "基于当前输入生成的简洁诊断记录。",
      sections: [{ heading: "结论", paragraphs: ["先核对测量条件再执行。"] }],
      tables: []
    });
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        sentUrl = String(url);
        sentRedirect = init?.redirect;
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "chatcmpl-strict-artifact",
            choices: [
              {
                finish_reason: "tool_calls",
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-strict-artifact",
                      type: "function",
                      function: {
                        name: "create_artifact",
                        arguments: argumentsJson
                      }
                    }
                  ]
                }
              }
            ],
            usage: {
              prompt_tokens: 700,
              prompt_cache_hit_tokens: 100,
              prompt_cache_miss_tokens: 600,
              completion_tokens: 300,
              completion_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 1_000
            }
          }),
          { headers: { "x-request-id": "strict-provider-request" } }
        );
      })
    });

    const events = await collect(
      provider.stream({
        instructions:
          "上一次 create_artifact 参数不是合法 JSON。重新生成一个简洁、完整的调用。",
        input: [
          { type: "message", role: "user", content: "生成诊断报告" },
          {
            type: "message",
            role: "assistant",
            content: "clean-prior-diagnosis"
          },
          {
            type: "function_call",
            call_id: "private-old-call",
            name: "create_artifact",
            arguments: "{private-malformed-arguments"
          },
          {
            type: "function_call_output",
            call_id: "private-old-call",
            output: "private-old-output"
          },
          { type: "reasoning", id: "private-reasoning" }
        ],
        tools: [
          {
            type: "function",
            name: "create_artifact",
            description: "Create one complete artifact.",
            strict: true,
            parameters: {
              type: "object",
              additionalProperties: false,
              required: [
                "schemaVersion",
                "kind",
                "title",
                "formats",
                "summary",
                "sections",
                "tables"
              ],
              properties: {
                schemaVersion: {
                  type: "string",
                  const: "openvac.artifact.v1"
                },
                kind: {
                  type: "string",
                  enum: ["diagnosis_report", "parameter_table"]
                },
                title: { type: "string", minLength: 1, maxLength: 120 },
                formats: {
                  type: "array",
                  minItems: 1,
                  maxItems: 4,
                  uniqueItems: true,
                  items: { enum: ["md", "docx", "pdf", "csv"] }
                },
                summary: { type: "string", minLength: 1, maxLength: 600 },
                sections: {
                  type: "array",
                  maxItems: 4,
                  items: { type: "string" }
                },
                tables: {
                  type: "array",
                  maxItems: 2,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["columns", "rows"],
                    properties: {
                      title: { type: "string", maxLength: 120 },
                      columns: { type: "array", items: { type: "string" } },
                      rows: {
                        type: "array",
                        items: {
                          type: "array",
                          items: { type: "string", maxLength: 160 }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          {
            type: "function",
            name: "search_knowledge",
            description: "Search knowledge.",
            parameters: { type: "object" }
          }
        ],
        toolChoice: { type: "function", name: "create_artifact" },
        maxOutputTokens: 8_192,
        safeInvocationPhase: "artifact_fresh_json_repair",
        user: "ov1_safe-user"
      })
    );

    expect(sentUrl).toBe("https://api.deepseek.com/beta/chat/completions");
    expect(sentRedirect).toBe("error");
    expect(sentBody).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "disabled" },
      max_tokens: 8_192,
      user_id: "ov1_safe-user",
      stream: false,
      tool_choice: {
        type: "function",
        function: { name: "create_artifact" }
      },
      tools: [
        {
          type: "function",
          function: {
            name: "create_artifact",
            strict: true,
            parameters: {
              type: "object",
              required: [
                "schemaVersion",
                "kind",
                "title",
                "formats",
                "summary",
                "sections",
                "tables"
              ],
              additionalProperties: false,
              properties: {
                schemaVersion: {
                  type: "string",
                  enum: ["openvac.artifact.v1"]
                },
                formats: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["md", "docx", "pdf", "csv"]
                  }
                },
                tables: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["title", "columns", "rows"],
                    additionalProperties: false
                  }
                }
              }
            }
          }
        }
      ]
    });
    expect(sentBody).not.toHaveProperty(
      "tools.0.function.parameters.properties.title.minLength"
    );
    expect(sentBody).not.toHaveProperty(
      "tools.0.function.parameters.properties.title.maxLength"
    );
    expect(sentBody).not.toHaveProperty(
      "tools.0.function.parameters.properties.formats.minItems"
    );
    expect(sentBody).not.toHaveProperty(
      "tools.0.function.parameters.properties.formats.maxItems"
    );
    expect(sentBody).not.toHaveProperty(
      "tools.0.function.parameters.properties.formats.uniqueItems"
    );
    const serializedMessages = JSON.stringify(sentBody.messages);
    expect(serializedMessages).toContain("上一次 create_artifact");
    expect(serializedMessages).toContain("生成诊断报告");
    expect(serializedMessages).toContain("clean-prior-diagnosis");
    expect(serializedMessages).not.toMatch(
      /private-old-call|private-malformed|private-old-output|private-reasoning/iu
    );
    expect(events).toContainEqual({
      type: "function-call",
      callId: "call-strict-artifact",
      name: "create_artifact",
      arguments: argumentsJson
    });
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      status: "completed",
      responseId: "chatcmpl-strict-artifact",
      continuationItems: [
        {
          type: "function_call",
          call_id: "call-strict-artifact",
          name: "create_artifact",
          arguments: argumentsJson
        }
      ],
      providerRequestId: "strict-provider-request",
      usage: {
        inputTokens: 700,
        cachedInputTokens: 100,
        outputTokens: 300,
        reasoningTokens: 0,
        totalTokens: 1_000
      }
    });
  });

  it("preserves usage and an incomplete terminal when strict output hits the token limit", async () => {
    const provider = strictArtifactRepairProvider({
      finishReason: "length",
      usage: {
        prompt_tokens: 120,
        prompt_cache_hit_tokens: 20,
        prompt_cache_miss_tokens: 100,
        completion_tokens: 80,
        total_tokens: 200
      }
    });

    const events = await collect(
      provider.stream(strictArtifactRepairRequest())
    );

    expect(events.at(-1)).toMatchObject({
      type: "finish",
      status: "incomplete",
      incomplete: { reason: "max_output_tokens" },
      continuationItems: [],
      usage: {
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 80,
        totalTokens: 200
      }
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "function-call" })
    );
  });

  it.each(["stop", "content_filter"])(
    "fails closed without retry for a strict %s terminal",
    async (finishReason) => {
      const provider = strictArtifactRepairProvider({ finishReason });

      await expect(
        collect(provider.stream(strictArtifactRepairRequest()))
      ).rejects.toMatchObject({
        name: "ProviderResponseError",
        retryable: false
      });
    }
  );

  it("marks a strict provider resource terminal retryable", async () => {
    const provider = strictArtifactRepairProvider({
      finishReason: "insufficient_system_resource"
    });

    await expect(
      collect(provider.stream(strictArtifactRepairRequest()))
    ).rejects.toMatchObject({
      name: "ProviderResponseError",
      status: 200,
      retryable: true
    });
  });

  it("marks a truncated HTTP 200 strict response retryable without changing its status", async () => {
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async () => new Response('{"id":"truncated"'))
    });

    await expect(
      collect(provider.stream(strictArtifactRepairRequest()))
    ).rejects.toMatchObject({
      name: "ProviderResponseError",
      status: 200,
      retryable: true
    });
  });

  it("restores high structured output from a fresh trusted calculation input", async () => {
    const sentBodies: Array<Record<string, unknown>> = [];
    const responses = [
      streamFromStrings([
        event("response.created", 0, { response: { id: "resp-tool-first" } }),
        event("response.completed", 1, {
          response: {
            id: "resp-tool-first",
            output: [
              {
                type: "function_call",
                id: "fc-pumpdown",
                call_id: "call-pumpdown",
                name: "estimate_pumpdown_time",
                arguments:
                  '{"volume":{"value":100,"unit":"L"},"pumpingSpeed":{"value":10,"unit":"L/s"},"initialPressure":{"value":100,"unit":"Pa"},"targetPressure":{"value":1,"unit":"Pa"}}'
              }
            ]
          }
        })
      ]),
      streamFromStrings([
        event("response.created", 0, { response: { id: "resp-tool-final" } }),
        event("response.completed", 1, {
          response: {
            id: "resp-tool-final",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: '{"ok":true}' }]
              }
            ]
          }
        })
      ])
    ];
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        sentBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>
        );
        const response = responses[sentBodies.length - 1];
        if (!response) throw new Error("Unexpected provider request.");
        return new Response(response);
      })
    });
    const tool = {
      type: "function" as const,
      name: "estimate_pumpdown_time",
      description: "Calculate pumpdown time",
      parameters: { type: "object" },
      strict: true
    };
    const userMessage = {
      type: "message",
      role: "user",
      content: "Calculate pumpdown time"
    };

    const firstEvents = await collect(
      provider.stream({
        input: [userMessage],
        tools: [tool],
        toolChoice: { type: "function", name: tool.name },
        reasoningEffort: "high",
        textFormat: {
          type: "json_schema",
          name: "answer_v3",
          schema: { type: "object" },
          strict: true
        },
        user: "ov1_safe-user"
      })
    );
    const firstCall = firstEvents.find(
      (event) => event.type === "function-call"
    );
    if (!firstCall || firstCall.type !== "function-call") {
      throw new Error("Forced tool fixture did not finish with one call.");
    }

    await collect(
      provider.stream({
        input: [
          userMessage,
          {
            type: "message",
            role: "system",
            content:
              '{"schemaVersion":"openvac.trusted-calculation-context.v1","dataOnly":true,"requiredCalculationIds":["calc_00000000000000000000"]}'
          }
        ],
        toolChoice: "none",
        reasoningEffort: "high",
        textFormat: {
          type: "json_schema",
          name: "answer_v3",
          schema: { type: "object" },
          strict: true
        },
        user: "ov1_safe-user"
      })
    );

    expect(sentBodies[0]).toMatchObject({
      tool_choice: "required",
      reasoning: { effort: "none" }
    });
    expect(sentBodies[0]).not.toHaveProperty("text");
    expect(sentBodies[1]).toMatchObject({
      tool_choice: "none",
      reasoning: { effort: "high" },
      text: {
        format: {
          type: "json_schema",
          name: "answer_v3",
          schema: { type: "object" }
        }
      }
    });
    expect(sentBodies[1]).not.toHaveProperty("tools");
    expect(sentBodies[1]).not.toHaveProperty("input.1.call_id");
    expect(JSON.stringify(sentBodies[1].input)).not.toMatch(
      /function_call|reasoning/u
    );
  });

  it("rejects an unresolved forced function before fetch", async () => {
    const fetchMock = vi.fn();
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: fetchMock
    });

    await expect(
      collect(
        provider.stream({
          input: "Calculate",
          tools: [],
          toolChoice: { type: "function", name: "missing_tool" },
          user: "ov1_safe-user"
        })
      )
    ).rejects.toMatchObject({
      name: "ProviderResponseError",
      retryable: false
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "response.incomplete",
      "incomplete",
      {
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "function_call", name: "partial" }]
      }
    ],
    [
      "response.failed",
      "failed",
      {
        error: { code: "server_error", message: "failed upstream" },
        output: [{ type: "function_call", call_id: "partial" }]
      }
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
                  response: { id: "resp-end", ...extra }
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
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "function-call" })
      );
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
                type: "open_page",
                url: "https://www.leybold.com/invalidated"
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

  it("extracts open-page action URLs and source URL aliases", async () => {
    const body = streamFromStrings([
      event("response.created", 0, { response: { id: "resp-web-actions" } }),
      event("response.completed", 1, {
        response: {
          id: "resp-web-actions",
          output: [
            {
              type: "web_search_call",
              id: "search-open-page",
              status: "completed",
              action: {
                type: "open_page",
                url: "https://www.leybold.com/manual"
              }
            },
            {
              type: "web_search_call",
              id: "search-source-alias",
              status: "completed",
              action: {
                type: "search",
                sources: [
                  {
                    uri: "https://www.pfeiffer-vacuum.com/manual",
                    name: "Pfeiffer manual"
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
          url: "https://www.leybold.com/manual",
          title: "www.leybold.com"
        },
        {
          url: "https://www.pfeiffer-vacuum.com/manual",
          title: "Pfeiffer manual"
        }
      ]
    });
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      completedWebSearchCalls: 2
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
                output_index: 0,
                item: {
                  type: "reasoning",
                  id: "reason-tools",
                  status: "completed",
                  content: [{ type: "reasoning_text", text: "private" }]
                }
              }),
              event("response.output_item.done", 2, {
                output_index: 1,
                item: {
                  type: "function_call",
                  call_id: "call-a",
                  name: "calculate_throughput",
                  arguments: "{}"
                }
              }),
              ": ping\n\n",
              event("response.output_item.done", 3, {
                output_index: 2,
                item: {
                  type: "function_call",
                  call_id: "call-b",
                  name: "classify_flow_regime",
                  arguments: "{}"
                }
              }),
              event("response.completed", 4, {
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
    const finish = events.at(-1);
    expect(finish?.type === "finish" ? finish.continuationItems : []).toEqual([
      expect.objectContaining({ type: "reasoning", id: "reason-tools" }),
      expect.objectContaining({ type: "function_call", call_id: "call-a" }),
      expect.objectContaining({ type: "function_call", call_id: "call-b" })
    ]);
  });

  it("rejects orphan function outputs locally before an outbound request", async () => {
    const fetchMock = vi.fn();
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: fetchMock
    });

    await expect(
      collect(
        provider.stream({
          input: [
            {
              type: "function_call_output",
              call_id: "call-orphan",
              output: '{"ok":true}'
            }
          ],
          toolChoice: "none",
          user: "ov1_safe-user"
        })
      )
    ).rejects.toMatchObject({
      name: "ProviderResponseError",
      retryable: false
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed instead of truncating excess continuation items", async () => {
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(
        async () =>
          new Response(
            streamFromStrings([
              event("response.created", 0, { response: { id: "resp-many" } }),
              event("response.completed", 1, {
                response: {
                  id: "resp-many",
                  output: Array.from({ length: 257 }, (_, index) => ({
                    type: "message",
                    id: `msg-${index}`,
                    role: "assistant",
                    content: [{ type: "output_text", text: "bounded" }]
                  }))
                }
              })
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

  it("fails closed when streamed and terminal calls disagree", async () => {
    const provider = new DeepSeekResponsesProvider({
      apiKey: "test-key",
      fetch: vi.fn(
        async () =>
          new Response(
            streamFromStrings([
              event("response.created", 0, {
                response: { id: "resp-conflict" }
              }),
              event("response.output_item.done", 1, {
                output_index: 0,
                item: {
                  type: "function_call",
                  call_id: "call-conflict",
                  name: "estimate_pumpdown_time",
                  arguments: "{}"
                }
              }),
              event("response.completed", 2, {
                response: {
                  id: "resp-conflict",
                  output: [
                    {
                      type: "function_call",
                      id: "fc-conflict",
                      call_id: "call-conflict",
                      name: "estimate_pumpdown_time",
                      arguments: '{"changed":true}'
                    }
                  ]
                }
              })
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

function strictArtifactRepairRequest(): ResponsesStreamRequest {
  return {
    instructions: "Repair the artifact as one valid JSON tool call.",
    input: [{ type: "message", role: "user", content: "Create a report." }],
    tools: [
      {
        type: "function",
        name: "create_artifact",
        description: "Create one artifact.",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: { title: { type: "string", minLength: 1 } }
        }
      }
    ],
    toolChoice: { type: "function", name: "create_artifact" },
    maxOutputTokens: 8_192,
    safeInvocationPhase: "artifact_fresh_json_repair",
    user: "ov1_safe-user"
  };
}

function strictArtifactRepairProvider(input: {
  finishReason: string;
  usage?: Record<string, unknown>;
}): DeepSeekResponsesProvider {
  return new DeepSeekResponsesProvider({
    apiKey: "test-key",
    fetch: vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: `chatcmpl-${input.finishReason}`,
            choices: [
              {
                finish_reason: input.finishReason,
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: []
                }
              }
            ],
            ...(input.usage ? { usage: input.usage } : {})
          })
        )
    )
  });
}

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
