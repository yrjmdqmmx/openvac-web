import {
  CORE_RETRIEVAL_EVAL_CASES,
  evaluateCoreRetrieval
} from "../src/evals/core-retrieval";
import { sqlClient } from "../src/server/db";
import {
  HybridRetriever,
  PostgresHybridRetrievalRepository
} from "../src/server/knowledge/retrieval";
import { getEmbeddingProvider } from "../src/server/providers";

const live = process.argv.includes("--live");

if (!live) {
  console.log(
    JSON.stringify(
      {
        dataset: "openvac-core-retrieval-v1",
        cases: CORE_RETRIEVAL_EVAL_CASES.length,
        uniqueIds: new Set(CORE_RETRIEVAL_EVAL_CASES.map((item) => item.id))
          .size,
        mode: "structure-only"
      },
      null,
      2
    )
  );
} else {
  try {
    const repository = new PostgresHybridRetrievalRepository((query, values) =>
      sqlClient.unsafe(query, [...values] as never[])
    );
    const retriever = new HybridRetriever({
      embeddings: getEmbeddingProvider(),
      repository
    });
    const results = await evaluateCoreRetrieval((query) =>
      retriever.retrieve(query, { limit: 5 })
    );
    const hits = results.filter((result) => result.hit).length;
    const hitRate = hits / results.length;

    console.log(
      JSON.stringify(
        {
          dataset: "openvac-core-retrieval-v1",
          cases: results.length,
          hits,
          hitRate,
          requiredHitRate: 0.9,
          misses: results
            .filter((result) => !result.hit)
            .map((result) => result.id),
          mode: "live-top-5"
        },
        null,
        2
      )
    );
    if (hitRate < 0.9) process.exitCode = 1;
  } finally {
    await sqlClient.end({ timeout: 5 });
  }
}
