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
  continuationItems: []
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
    ["zero", [finish]],
    [
      "multiple",
      [
        { type: "web-search-status", status: "completed" } as const,
        { type: "web-search-status", status: "completed" } as const,
        finish
      ]
    ]
  ])("rejects %s completed native web-search calls", async (_label, events) => {
    await expect(discover(events)).rejects.toThrow(
      "NATIVE_WEB_SEARCH_COUNT_INVALID"
    );
  });

  it("does not report a search when the native call contract failed", async () => {
    const service = new WebEvidenceService(
      provider,
      new EvidenceRegistry(),
      async function* () {
        yield finish;
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

  it("does not publish a verified link whose final URL contains a secret", async () => {
    fetchMocks.fetch.mockResolvedValue({
      url: "https://trusted.example-a.com/pump?X-Amz-Signature=secret",
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
          }
        ]
      )
    ).resolves.toMatchObject({ evidenceIds: [], verifiedLinks: [] });
  });
});
