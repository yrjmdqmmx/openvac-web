import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const retrievalMocks = vi.hoisted(() => ({
  embed: vi.fn(),
  retrievePatentMetadataReferences: vi.fn(),
  sqlUnsafe: vi.fn()
}));

vi.mock("@/server/db", () => ({
  sqlClient: { unsafe: retrievalMocks.sqlUnsafe }
}));

vi.mock("@/server/knowledge/lexical", () => ({
  extractLexicalTerms: vi.fn(() => ["真空泵"]),
  POSTGRES_LEXICAL_RETRIEVAL_SQL: "LEXICAL_RETRIEVAL"
}));

vi.mock("@/server/knowledge/metadata-reference", () => ({
  retrievePatentMetadataReferences:
    retrievalMocks.retrievePatentMetadataReferences
}));

vi.mock("@/server/providers", () => ({
  getEmbeddingProvider: vi.fn(() => ({
    id: "test-embedding",
    model: "test-embedding",
    dimensions: 1024,
    embed: retrievalMocks.embed
  })),
  getWebSearchProvider: vi.fn()
}));

import { collectLocalEvidence } from "./evidence";

describe("local query embedding deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllEnvs();
    retrievalMocks.embed.mockReset();
    retrievalMocks.retrievePatentMetadataReferences.mockReset();
    retrievalMocks.sqlUnsafe.mockReset();
    retrievalMocks.retrievePatentMetadataReferences.mockResolvedValue([]);
    retrievalMocks.sqlUnsafe.mockResolvedValue([lexicalRow]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("falls back to lexical retrieval after the default eight-second deadline", async () => {
    let embeddingSignal: AbortSignal | undefined;
    retrievalMocks.embed.mockImplementation(
      (_texts: string[], signal?: AbortSignal) => {
        embeddingSignal = signal;
        return rejectWhenAborted(signal);
      }
    );

    const pending = collectLocalEvidence("真空泵选型");
    await vi.advanceTimersByTimeAsync(7_999);

    expect(embeddingSignal?.aborted).toBe(false);
    expect(retrievalMocks.sqlUnsafe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      local: { mode: "lexical" },
      evidence: [{ excerpt: "词法降级证据" }]
    });
    expect(embeddingSignal?.aborted).toBe(true);
    expect(retrievalMocks.sqlUnsafe).toHaveBeenCalledWith("LEXICAL_RETRIEVAL", [
      ["真空泵"]
    ]);
  });

  it("caps a configured query embedding deadline at fifteen seconds", async () => {
    vi.stubEnv("AGENT_QUERY_EMBEDDING_TIMEOUT_MS", "60000");
    let embeddingSignal: AbortSignal | undefined;
    retrievalMocks.embed.mockImplementation(
      (_texts: string[], signal?: AbortSignal) => {
        embeddingSignal = signal;
        return rejectWhenAborted(signal);
      }
    );

    const pending = collectLocalEvidence("真空泵选型");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(embeddingSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({
      local: { mode: "lexical" }
    });
    expect(embeddingSignal?.aborted).toBe(true);
  });

  it("inherits caller abort and still fails open to lexical retrieval", async () => {
    const controller = new AbortController();
    let embeddingSignal: AbortSignal | undefined;
    retrievalMocks.embed.mockImplementation(
      (_texts: string[], signal?: AbortSignal) => {
        embeddingSignal = signal;
        return rejectWhenAborted(signal);
      }
    );

    const pending = collectLocalEvidence("真空泵选型", controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(embeddingSignal?.aborted).toBe(false);

    controller.abort();

    await expect(pending).resolves.toMatchObject({
      local: { mode: "lexical" }
    });
    expect(embeddingSignal?.aborted).toBe(true);
  });

  it("keeps successful hybrid retrieval unchanged before the deadline", async () => {
    retrievalMocks.embed.mockResolvedValue({
      model: "test-embedding",
      dimensions: 1024,
      vectors: [Array.from({ length: 1024 }, () => 0)]
    });
    retrievalMocks.sqlUnsafe.mockResolvedValueOnce([hybridRow]);

    await expect(collectLocalEvidence("真空泵选型")).resolves.toMatchObject({
      local: { mode: "hybrid", bestScore: 0.032 },
      evidence: [{ excerpt: "混合检索证据" }]
    });
    expect(retrievalMocks.embed).toHaveBeenCalledWith(
      ["真空泵选型"],
      expect.any(AbortSignal)
    );
    expect(retrievalMocks.sqlUnsafe).toHaveBeenCalledTimes(1);
  });
});

function rejectWhenAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) {
      reject(new Error("missing embedding abort signal"));
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

const lexicalRow = {
  chunk_id: "lexical-chunk",
  document_id: "lexical-document",
  version_id: "lexical-version",
  title: "真空泵手册",
  content: "词法降级证据",
  section_path: ["选型"],
  source_id: "source-lexical",
  publisher: "OpenVac",
  canonical_url: "https://example.com/lexical",
  source_tier: "open_license",
  citation_metadata: { fetchedAt: "2026-08-09T00:00:00.000Z" },
  score: "0.02"
};

const hybridRow = {
  chunk_id: "hybrid-chunk",
  document_id: "hybrid-document",
  version_id: "hybrid-version",
  title: "真空泵手册",
  content: "混合检索证据",
  section_path: ["选型"],
  source_id: "source-hybrid",
  publisher: "OpenVac",
  canonical_url: "https://example.com/hybrid",
  source_tier: "open_license",
  citation_metadata: { fetchedAt: "2026-08-09T00:00:00.000Z" },
  vector_rank: "1",
  lexical_rank: "2",
  score: "0.032"
};
