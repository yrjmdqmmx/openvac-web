import { beforeEach, describe, expect, it, vi } from "vitest";

const quotaMocks = vi.hoisted(() => ({
  commit: vi.fn(async () => ({ status: "committed" })),
  release: vi.fn(async () => ({ status: "released" })),
  reserve: vi.fn(async () => ({
    idempotent: false,
    leaseId: "web-lease-1",
    status: "reserved"
  }))
}));

const fetchMocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  fetch: vi.fn()
}));

vi.mock("@/server/quota", () => ({
  commitQuota: quotaMocks.commit,
  releaseQuota: quotaMocks.release,
  reserveWebSearchQuota: quotaMocks.reserve
}));

vi.mock("@/server/knowledge/web-fetch", () => ({
  SafeWebFetcher: class {
    constructor(options: unknown) {
      fetchMocks.constructor(options);
    }

    fetch = fetchMocks.fetch;
  }
}));

import type {
  ResponsesProvider,
  ResponsesStreamEvent
} from "@/server/providers";

import { EvidenceRegistry } from "./evidence-registry";
import {
  WebEvidenceService,
  type WebDomainPolicy,
  type WebEvidenceResult
} from "./web-evidence";

const provider = {
  id: "deepseek-responses",
  model: "deepseek-v4-flash",
  capabilities: {},
  stream: async function* () {
    throw new Error("test supplies an explicit stream");
  }
} as unknown as ResponsesProvider;

const finish: Extract<ResponsesStreamEvent, { type: "finish" }> = {
  type: "finish",
  status: "completed",
  responseId: "resp-web-1",
  outputText: JSON.stringify({ candidates: [] }),
  continuationItems: [],
  completedWebSearchCalls: 1
};

function subject(events: ResponsesStreamEvent[]) {
  const service = new WebEvidenceService(
    provider,
    new EvidenceRegistry(),
    async function* () {
      yield* events;
    },
    async () => []
  );
  return service as unknown as {
    discoverNative(input: {
      question: string;
      userPartition: string;
      policies: WebDomainPolicy[];
    }): Promise<WebEvidenceResult>;
  };
}

function discover(
  events: ResponsesStreamEvent[],
  policies: Array<{
    domain: string;
    trustTier: "tier_a" | "tier_b";
    licenseClass: "metadata_only" | "open";
  }> = []
) {
  return subject(events).discoverNative({
    question: "最新真空泵公告",
    userPartition: "partition_1",
    policies
  });
}

describe("DeepSeek native web evidence", () => {
  beforeEach(() => {
    fetchMocks.constructor.mockReset();
    fetchMocks.fetch.mockReset();
  });

  it("accepts exactly one completed native web-search call", async () => {
    await expect(
      discover([
        { type: "web-search-status", status: "in_progress" },
        { type: "web-search-status", status: "completed" },
        finish
      ])
    ).resolves.toMatchObject({
      searched: true,
      provider: "deepseek-native",
      evidenceIds: [],
      verifiedLinks: []
    });
  });

  it.each([
    ["missing", [{ ...finish, completedWebSearchCalls: undefined }]],
    ["zero", [{ ...finish, completedWebSearchCalls: 0 }]],
    ["outside provider contract", [{ ...finish, completedWebSearchCalls: 10 }]]
  ])("rejects %s completed native web-search proof", async (_label, events) => {
    await expect(discover(events)).rejects.toThrow(
      "NATIVE_WEB_SEARCH_COUNT_INVALID"
    );
  });

  it.each([1, 2, 8, 9])(
    "accepts %i completed search calls proven by the terminal response",
    async (completedWebSearchCalls) => {
      await expect(
        discover([{ ...finish, completedWebSearchCalls }])
      ).resolves.toMatchObject({
        searched: true,
        provider: "deepseek-native"
      });
    }
  );

  it("does not report a search when the native call contract failed", async () => {
    const service = new WebEvidenceService(
      provider,
      new EvidenceRegistry(),
      async function* () {
        yield { ...finish, completedWebSearchCalls: 0 };
      },
      async () => []
    );

    await expect(
      service.search({
        question: "最新真空泵公告",
        userId: "user-1",
        userPartition: "partition_1",
        clientRequestId: "request-1"
      })
    ).resolves.toMatchObject({
      searched: false,
      provider: "none",
      evidenceIds: [],
      verifiedLinks: []
    });
  });

  it("does not carry one candidate's policy across a redirect to another domain", async () => {
    fetchMocks.fetch.mockResolvedValue({
      url: "https://manuals.example-b.com/pump",
      body: "A".repeat(120),
      fetchedAt: new Date("2026-08-09T00:00:00.000Z")
    });
    const candidateFinish: Extract<ResponsesStreamEvent, { type: "finish" }> = {
      ...finish,
      outputText: JSON.stringify({
        candidates: [
          {
            url: "https://trusted.example-a.com/pump",
            title: "Pump manual",
            summary: "Manufacturer source"
          }
        ]
      })
    };

    await expect(
      discover(
        [{ type: "web-search-status", status: "completed" }, candidateFinish],
        [
          {
            domain: "example-a.com",
            trustTier: "tier_a",
            licenseClass: "open"
          },
          {
            domain: "example-b.com",
            trustTier: "tier_b",
            licenseClass: "metadata_only"
          }
        ]
      )
    ).resolves.toMatchObject({ evidenceIds: [], verifiedLinks: [] });
    expect(fetchMocks.constructor).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDomains: ["example-a.com"] })
    );
  });

  it.each(["X-Amz-Signature", "X-Goog-Signature", "sig", "session_id"])(
    "does not publish a verified link whose final URL contains %s",
    async (sensitiveKey) => {
      fetchMocks.fetch.mockResolvedValue({
        url: `https://trusted.example-a.com/pump?${sensitiveKey}=secret`,
        body: "A".repeat(120),
        fetchedAt: new Date("2026-08-09T00:00:00.000Z")
      });
      const candidateFinish: Extract<ResponsesStreamEvent, { type: "finish" }> =
        {
          ...finish,
          outputText: JSON.stringify({
            candidates: [
              {
                url: "https://trusted.example-a.com/pump",
                title: "Pump manual",
                summary: "Manufacturer source"
              }
            ]
          })
        };

      await expect(
        discover(
          [{ type: "web-search-status", status: "completed" }, candidateFinish],
          [
            {
              domain: "example-a.com",
              trustTier: "tier_a",
              licenseClass: "open"
            }
          ]
        )
      ).resolves.toMatchObject({ evidenceIds: [], verifiedLinks: [] });
    }
  );

  it("binds a safely fetched authority page and tells DeepSeek the approved domains", async () => {
    let capturedInstructions = "";
    let capturedTextFormat: unknown;
    const registry = new EvidenceRegistry();
    fetchMocks.fetch.mockResolvedValue({
      url: "https://docs.example-a.com/pump",
      body: "Manufacturer foreline-pressure guidance. ".repeat(4),
      fetchedAt: new Date("2026-08-09T00:00:00.000Z")
    });
    const candidateFinish: Extract<ResponsesStreamEvent, { type: "finish" }> = {
      ...finish,
      outputText: JSON.stringify({
        candidates: [
          {
            url: "https://docs.example-a.com/pump",
            title: "Pump manual",
            summary: "Manufacturer source"
          }
        ]
      })
    };
    const service = new WebEvidenceService(
      provider,
      registry,
      async function* (request) {
        capturedInstructions = request.instructions ?? "";
        capturedTextFormat = request.textFormat;
        yield { type: "web-search-status", status: "completed" };
        yield candidateFinish;
      },
      async () => [
        {
          domain: "example-a.com",
          trustTier: "tier_a",
          licenseClass: "open"
        }
      ]
    );

    const result = await service.search({
      question: "查找厂家前级压力资料",
      userId: "user-1",
      userPartition: "partition-1",
      clientRequestId: "request-1"
    });

    expect(capturedInstructions).toContain("example-a.com");
    expect(capturedTextFormat).toBeUndefined();
    expect(result).toMatchObject({
      searched: true,
      provider: "deepseek-native",
      evidenceIds: ["E1"],
      verifiedLinks: [
        {
          linkId: "W1",
          evidenceIds: ["E1"],
          hostname: "docs.example-a.com"
        }
      ]
    });
    expect(registry.modelIndex()).toEqual([
      expect.objectContaining({
        evidenceId: "E1",
        linkId: "W1",
        linkHostname: "docs.example-a.com"
      })
    ]);
  });

  it.each(["incomplete", "failed"] as const)(
    "rejects a %s terminal discovery response",
    async (status) => {
      await expect(
        discover([
          { type: "web-search-status", status: "completed" },
          { ...finish, status }
        ])
      ).rejects.toThrow("NATIVE_WEB_DISCOVERY_FAILED");
    }
  );

  it("uses terminal URL citations when structured output is empty", async () => {
    fetchMocks.fetch.mockResolvedValue({
      url: "https://docs.example-a.com/pump",
      body: "Manufacturer foreline-pressure guidance. ".repeat(4),
      fetchedAt: new Date("2026-08-09T00:00:00.000Z")
    });
    const emptyFinish = { ...finish, outputText: "" };

    await expect(
      discover(
        [
          { type: "web-search-status", status: "completed" },
          {
            type: "web-search-sources",
            sources: [
              {
                url: "https://docs.example-a.com/pump",
                title: "Pump manual"
              }
            ]
          },
          emptyFinish
        ],
        [
          {
            domain: "example-a.com",
            trustTier: "tier_a",
            licenseClass: "open"
          }
        ]
      )
    ).resolves.toMatchObject({
      evidenceIds: ["E1"],
      verifiedLinks: [{ linkId: "W1", evidenceIds: ["E1"] }]
    });
  });

  it("extracts bounded HTTPS candidates from non-JSON provider text", async () => {
    fetchMocks.fetch.mockResolvedValue({
      url: "https://docs.example-a.com/pump",
      body: "Manufacturer foreline-pressure guidance. ".repeat(4),
      fetchedAt: new Date("2026-08-09T00:00:00.000Z")
    });
    const textFinish: Extract<ResponsesStreamEvent, { type: "finish" }> = {
      ...finish,
      outputText: [
        "Search results:",
        "[\u0001 Leybold   pump manual](https://docs.example-a.com/pump).",
        "Duplicate: https://docs.example-a.com/pump,",
        "Unapproved: https://outside.example.net/pump"
      ].join("\n")
    };

    await expect(
      discover(
        [textFinish],
        [
          {
            domain: "example-a.com",
            trustTier: "tier_a",
            licenseClass: "open"
          }
        ]
      )
    ).resolves.toMatchObject({
      evidenceIds: ["E1"],
      verifiedLinks: [
        {
          linkId: "W1",
          label: "docs.example-a.com",
          url: "https://docs.example-a.com/pump"
        }
      ]
    });
    expect(fetchMocks.fetch).toHaveBeenCalledTimes(1);
    expect(fetchMocks.fetch).toHaveBeenCalledWith(
      "https://docs.example-a.com/pump",
      undefined
    );
  });

  it("keeps provider annotations ahead of text fallback URLs", async () => {
    fetchMocks.fetch.mockImplementation(async (url: string) => ({
      url,
      body: "Manufacturer foreline-pressure guidance. ".repeat(4),
      fetchedAt: new Date("2026-08-09T00:00:00.000Z")
    }));
    const textFinish: Extract<ResponsesStreamEvent, { type: "finish" }> = {
      ...finish,
      outputText: Array.from(
        { length: 8 },
        (_, index) => `https://docs.example-a.com/text-result-${index + 1}`
      ).join("\n")
    };

    await expect(
      discover(
        [
          {
            type: "web-search-sources",
            sources: [
              {
                url: "https://docs.example-a.com/annotation",
                title: "Provider annotation"
              }
            ]
          },
          textFinish
        ],
        [
          {
            domain: "example-a.com",
            trustTier: "tier_a",
            licenseClass: "open"
          }
        ]
      )
    ).resolves.toMatchObject({
      verifiedLinks: [
        {
          url: "https://docs.example-a.com/annotation",
          label: "Provider annotation"
        }
      ]
    });
    expect(fetchMocks.fetch).toHaveBeenCalledTimes(1);
    expect(fetchMocks.fetch).toHaveBeenCalledWith(
      "https://docs.example-a.com/annotation",
      undefined
    );
  });

  it("keeps valid JSON candidates ahead of provider annotations", async () => {
    fetchMocks.fetch.mockImplementation(async (url: string) => ({
      url,
      body: "Manufacturer foreline-pressure guidance. ".repeat(4),
      fetchedAt: new Date("2026-08-09T00:00:00.000Z")
    }));
    const jsonFinish: Extract<ResponsesStreamEvent, { type: "finish" }> = {
      ...finish,
      outputText: JSON.stringify({
        candidates: [
          {
            url: "https://docs.example-a.com/json",
            title: "JSON candidate",
            summary: ""
          }
        ]
      })
    };

    await expect(
      discover(
        [
          {
            type: "web-search-sources",
            sources: [
              {
                url: "https://docs.example-a.com/annotation",
                title: "Provider annotation"
              }
            ]
          },
          jsonFinish
        ],
        [
          {
            domain: "example-a.com",
            trustTier: "tier_a",
            licenseClass: "open"
          }
        ]
      )
    ).resolves.toMatchObject({
      verifiedLinks: [
        { url: "https://docs.example-a.com/json", label: "JSON candidate" },
        {
          url: "https://docs.example-a.com/annotation",
          label: "Provider annotation"
        }
      ]
    });
    expect(fetchMocks.fetch).toHaveBeenNthCalledWith(
      1,
      "https://docs.example-a.com/json",
      undefined
    );
    expect(fetchMocks.fetch).toHaveBeenNthCalledWith(
      2,
      "https://docs.example-a.com/annotation",
      undefined
    );
  });

  it("preserves balanced URL parentheses while trimming sentence punctuation", async () => {
    fetchMocks.fetch.mockImplementation(async (url: string) => ({
      url,
      body: "Manufacturer foreline-pressure guidance. ".repeat(4),
      fetchedAt: new Date("2026-08-09T00:00:00.000Z")
    }));

    await expect(
      discover(
        [
          {
            ...finish,
            outputText: "[Manual](https://docs.example-a.com/a_(b)). 中文句号。"
          }
        ],
        [
          {
            domain: "example-a.com",
            trustTier: "tier_a",
            licenseClass: "open"
          }
        ]
      )
    ).resolves.toMatchObject({
      verifiedLinks: [{ url: "https://docs.example-a.com/a_(b)" }]
    });
    expect(fetchMocks.fetch).toHaveBeenCalledWith(
      "https://docs.example-a.com/a_(b)",
      undefined
    );
  });

  it("accepts a 2000-character URL and does not truncate a 2001-character token", async () => {
    const prefix = "https://docs.example-a.com/";
    const url2000 = `${prefix}${"a".repeat(2000 - prefix.length)}`;
    const url2001 = `${url2000}a`;
    fetchMocks.fetch.mockImplementation(async (url: string) => ({
      url,
      body: "Manufacturer foreline-pressure guidance. ".repeat(4),
      fetchedAt: new Date("2026-08-09T00:00:00.000Z")
    }));
    const policies = [
      {
        domain: "example-a.com",
        trustTier: "tier_a" as const,
        licenseClass: "open" as const
      }
    ];

    await expect(
      discover([{ ...finish, outputText: `[Manual](${url2000}).` }], policies)
    ).resolves.toMatchObject({ evidenceIds: ["E1"] });
    expect(fetchMocks.fetch).toHaveBeenCalledWith(url2000, undefined);

    fetchMocks.fetch.mockReset();
    await expect(
      discover([{ ...finish, outputText: url2001 }], policies)
    ).rejects.toThrow();
    expect(fetchMocks.fetch).not.toHaveBeenCalled();
  });

  it("does not accept a URL token truncated at the text scan boundary", async () => {
    const visiblePrefix = "https://docs.example-a.com/a";
    const outputText = `${"x".repeat(32768 - visiblePrefix.length)}${visiblePrefix}${"b".repeat(2000)}`;

    await expect(
      discover(
        [{ ...finish, outputText }],
        [
          {
            domain: "example-a.com",
            trustTier: "tier_a",
            licenseClass: "open"
          }
        ]
      )
    ).rejects.toThrow();
    expect(fetchMocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "JSON",
      [
        {
          ...finish,
          outputText: JSON.stringify({
            candidates: [
              {
                url: "https://docs.example-a.com/pump?api_key=secret",
                title: "Private JSON candidate",
                summary: ""
              }
            ]
          })
        }
      ]
    ],
    [
      "annotation",
      [
        {
          type: "web-search-sources" as const,
          sources: [
            {
              url: "https://docs.example-a.com/pump?credential=secret",
              title: "Private annotation"
            }
          ]
        },
        { ...finish, outputText: "" }
      ]
    ]
  ])("rejects sensitive %s candidates before fetch", async (_label, events) => {
    await expect(
      discover(events, [
        {
          domain: "example-a.com",
          trustTier: "tier_a",
          licenseClass: "open"
        }
      ])
    ).resolves.toMatchObject({ evidenceIds: [], verifiedLinks: [] });
    expect(fetchMocks.fetch).not.toHaveBeenCalled();
  });

  it("uses text fallback when malformed JSON annotations are not governable", async () => {
    fetchMocks.fetch.mockImplementation(async (url: string) => ({
      url,
      body: "Manufacturer foreline-pressure guidance. ".repeat(4),
      fetchedAt: new Date("2026-08-09T00:00:00.000Z")
    }));

    await expect(
      discover(
        [
          {
            type: "web-search-sources",
            sources: [
              {
                url: "https://outside.example.net/unapproved",
                title: "Unapproved annotation"
              }
            ]
          },
          {
            ...finish,
            outputText:
              "Not JSON, but use https://docs.example-a.com/governed-source"
          }
        ],
        [
          {
            domain: "example-a.com",
            trustTier: "tier_a",
            licenseClass: "open"
          }
        ]
      )
    ).resolves.toMatchObject({
      verifiedLinks: [{ url: "https://docs.example-a.com/governed-source" }]
    });
  });

  it("governs at most eight text candidates and fetches at most five", async () => {
    fetchMocks.fetch.mockImplementation(async (url: string) => ({
      url,
      body: "Manufacturer foreline-pressure guidance. ".repeat(4),
      fetchedAt: new Date("2026-08-09T00:00:00.000Z")
    }));
    const outputText = Array.from(
      { length: 9 },
      (_, index) => `https://docs.example-a.com/result-${index + 1}`
    ).join("\n");

    await expect(
      discover(
        [{ ...finish, outputText }],
        [
          {
            domain: "example-a.com",
            trustTier: "tier_a",
            licenseClass: "open"
          }
        ]
      )
    ).resolves.toMatchObject({
      evidenceIds: ["E1", "E2", "E3", "E4", "E5"]
    });
    expect(fetchMocks.fetch).toHaveBeenCalledTimes(5);
    expect(fetchMocks.fetch).not.toHaveBeenCalledWith(
      "https://docs.example-a.com/result-9",
      undefined
    );
  });

  it.each(["token", "sig", "X-Goog-Signature", "session_id"])(
    "rejects %s query URLs before the governed fetch",
    async (sensitiveKey) => {
      const textFinish: Extract<ResponsesStreamEvent, { type: "finish" }> = {
        ...finish,
        outputText: `https://docs.example-a.com/pump?${sensitiveKey}=short-lived-secret`
      };

      await expect(
        discover(
          [textFinish],
          [
            {
              domain: "example-a.com",
              trustTier: "tier_a",
              licenseClass: "open"
            }
          ]
        )
      ).rejects.toThrow();
      expect(fetchMocks.fetch).not.toHaveBeenCalled();
    }
  );

  it("fails closed when non-JSON provider text contains no HTTPS candidate", async () => {
    await expect(
      discover([{ ...finish, outputText: "No usable source was returned." }])
    ).rejects.toThrow();
    expect(fetchMocks.fetch).not.toHaveBeenCalled();
  });
});
