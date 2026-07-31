import { describe, expect, it, vi } from "vitest";

import {
  HybridRetriever,
  PostgresHybridRetrievalRepository,
  reciprocalRankFusion
} from "./retrieval";

describe("reciprocalRankFusion", () => {
  it("rewards candidates found by both retrieval methods", () => {
    const fused = reciprocalRankFusion(
      [
        { item: { id: "a" }, rank: 1 },
        { item: { id: "b" }, rank: 2 }
      ],
      [
        { item: { id: "b" }, rank: 1 },
        { item: { id: "c" }, rank: 2 }
      ],
      (item) => item.id
    );

    expect(fused.map((entry) => entry.item.id)).toEqual(["b", "a", "c"]);
    expect(fused[0]).toMatchObject({
      vectorRank: 2,
      lexicalRank: 1
    });
  });
});

describe("PostgresHybridRetrievalRepository", () => {
  it("passes a 1024 vector and maps a published evidence row", async () => {
    const execute = vi.fn(async () => [
      {
        chunk_id: "chunk-1",
        document_id: "doc-1",
        version_id: "version-1",
        title: "Manual",
        content: "Evidence",
        section_path: ["Safety"],
        source_id: "source-1",
        publisher: "CERN",
        canonical_url: "https://cds.cern.ch/record/1",
        source_tier: "open_license",
        citation_metadata: {
          fetchedAt: "2026-07-31T00:00:00.000Z"
        },
        vector_rank: "1",
        lexical_rank: "2",
        score: "0.032"
      }
    ]);
    const repository = new PostgresHybridRetrievalRepository(execute);

    const result = await repository.search({
      query: "vacuum",
      embedding: Array.from({ length: 1024 }, () => 0)
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result[0]).toMatchObject({
      chunkId: "chunk-1",
      score: 0.032,
      vectorRank: 1,
      citation: {
        sourceId: "source-1",
        licenseClass: "open"
      }
    });
  });
});

describe("HybridRetriever", () => {
  it("embeds the normalized query before repository search", async () => {
    const embeddings = {
      id: "test",
      model: "test",
      dimensions: 1024,
      embed: vi.fn(async () => ({
        model: "test",
        dimensions: 1024,
        vectors: [Array.from({ length: 1024 }, () => 1)]
      }))
    };
    const repository = { search: vi.fn(async () => []) };
    const retriever = new HybridRetriever({ embeddings, repository });

    await retriever.retrieve("  泵选型  ");

    expect(embeddings.embed).toHaveBeenCalledWith(["泵选型"]);
    expect(repository.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "泵选型" })
    );
  });
});
