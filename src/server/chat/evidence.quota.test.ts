import { beforeEach, describe, expect, it, vi } from "vitest";

const evidenceMocks = vi.hoisted(() => ({
  commitQuota: vi.fn(),
  releaseQuota: vi.fn(),
  reserveWebSearchQuota: vi.fn(),
  retrieveLocal: vi.fn(),
  retrievePatentMetadataReferences: vi.fn(),
  search: vi.fn(),
  sqlUnsafe: vi.fn()
}));

vi.mock("@/server/db", () => ({
  sqlClient: { unsafe: evidenceMocks.sqlUnsafe }
}));

vi.mock("@/server/knowledge/metadata-reference", () => ({
  retrievePatentMetadataReferences:
    evidenceMocks.retrievePatentMetadataReferences
}));

vi.mock("@/server/knowledge/retrieval", () => ({
  HybridRetriever: class {
    retrieve(...args: unknown[]) {
      return evidenceMocks.retrieveLocal(...args);
    }
  },
  PostgresHybridRetrievalRepository: class {}
}));

vi.mock("@/server/knowledge/lexical", () => ({
  extractLexicalTerms: vi.fn(() => []),
  POSTGRES_LEXICAL_RETRIEVAL_SQL: ""
}));

vi.mock("@/server/providers", () => ({
  getEmbeddingProvider: vi.fn(() => ({})),
  getWebSearchProvider: vi.fn(() => ({ search: evidenceMocks.search }))
}));

vi.mock("@/server/quota", () => ({
  commitQuota: evidenceMocks.commitQuota,
  QuotaExceededError: class QuotaExceededError extends Error {},
  releaseQuota: evidenceMocks.releaseQuota,
  reserveWebSearchQuota: evidenceMocks.reserveWebSearchQuota
}));

import { collectEvidence } from "./evidence";

describe("web-search quota commit boundary", () => {
  beforeEach(() => {
    vi.stubEnv("ALIBABA_WEB_SEARCH_ENABLED", "true");
    evidenceMocks.commitQuota.mockReset();
    evidenceMocks.releaseQuota.mockReset();
    evidenceMocks.reserveWebSearchQuota.mockReset();
    evidenceMocks.retrieveLocal.mockReset();
    evidenceMocks.retrievePatentMetadataReferences.mockReset();
    evidenceMocks.search.mockReset();
    evidenceMocks.sqlUnsafe.mockReset();

    evidenceMocks.retrievePatentMetadataReferences.mockResolvedValue([]);
    evidenceMocks.retrieveLocal.mockResolvedValue([]);
    evidenceMocks.reserveWebSearchQuota.mockResolvedValue({
      idempotent: false,
      leaseId: "web-lease-1",
      status: "reserved"
    });
    evidenceMocks.releaseQuota.mockResolvedValue({
      leaseId: "web-lease-1",
      status: "released"
    });
  });

  it("does not call the paid provider when the reservation was released before commit", async () => {
    evidenceMocks.commitQuota.mockResolvedValue({
      leaseId: "web-lease-1",
      status: "released"
    });

    await expect(
      collectEvidence({
        question: "目前最新的真空泵型号是什么？",
        userId: "user-1",
        clientRequestId: "request-1"
      })
    ).resolves.toMatchObject({ webSearched: false });

    expect(evidenceMocks.search).not.toHaveBeenCalled();
    expect(evidenceMocks.releaseQuota).toHaveBeenCalledWith({
      leaseId: "web-lease-1",
      userId: "user-1",
      reason: "search_failed_or_unverified"
    });
  });

  it("calls the provider after the reservation is confirmed committed", async () => {
    evidenceMocks.commitQuota.mockResolvedValue({
      leaseId: "web-lease-1",
      status: "committed"
    });
    evidenceMocks.search.mockResolvedValue({
      searched: false,
      searchCalls: 1,
      sources: []
    });

    await collectEvidence({
      question: "目前最新的真空泵型号是什么？",
      userId: "user-1",
      clientRequestId: "request-1"
    });

    expect(evidenceMocks.search).toHaveBeenCalledTimes(1);
    expect(evidenceMocks.releaseQuota).not.toHaveBeenCalled();
  });

  it("passes the legacy collection signal into local query embedding", async () => {
    vi.stubEnv("ALIBABA_WEB_SEARCH_ENABLED", "false");
    const controller = new AbortController();

    await collectEvidence({
      question: "真空泵选型",
      userId: "user-1",
      clientRequestId: "request-1",
      signal: controller.signal
    });

    const embeddingSignal = evidenceMocks.retrieveLocal.mock
      .calls[0]?.[2] as AbortSignal;
    expect(embeddingSignal).toEqual(expect.any(AbortSignal));
    expect(embeddingSignal.aborted).toBe(false);

    controller.abort();

    expect(embeddingSignal.aborted).toBe(true);
  });
});
