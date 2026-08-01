import { describe, expect, it, vi } from "vitest";

import { classifyVacuumRisk } from "@/server/agent/risk";
import type { GroundingEvidence } from "@/server/agent";
import type { RetrievalCandidate } from "@/server/knowledge/retrieval";

import {
  evaluateOpenVacV1Live,
  inspectCorpusReadiness,
  parseV1CorpusStateRow,
  POSTGRES_V1_CORPUS_STATE_SQL,
  type V1CorpusState,
  type V1SourceIdentity
} from "./live-v1";
import { OPENVAC_V1_EVAL_CASES, type EvalCase } from "./v1";

const IDENTITIES: V1SourceIdentity[] = [
  {
    sourceKey: "cern-vacuum-systems-2024",
    canonicalUrl: "https://cds.cern.ch/record/2929324?ln=en",
    ingestionMode: "full_text"
  },
  {
    sourceKey: "cern-vacuum-superconducting-devices-2014",
    canonicalUrl: "https://cds.cern.ch/record/1974068",
    ingestionMode: "full_text"
  },
  {
    sourceKey: "hse-safe-maintenance",
    canonicalUrl:
      "https://www.hse.gov.uk/work-equipment-machinery/maintenance.htm",
    ingestionMode: "full_text"
  },
  {
    sourceKey: "hse-dsear",
    canonicalUrl: "https://www.hse.gov.uk/fireandexplosion/dsear.htm",
    ingestionMode: "full_text"
  },
  {
    sourceKey: "hse-oxygen-safety",
    canonicalUrl: "https://www.hse.gov.uk/pubns/indg459.htm",
    ingestionMode: "full_text"
  },
  {
    sourceKey: "patent-us7674096b2",
    canonicalUrl: "https://patentcenter.uspto.gov/applications/10947899",
    ingestionMode: "metadata_only"
  },
  {
    sourceKey: "patent-cn221568833u",
    canonicalUrl: "https://patents.google.com/patent/CN221568833U/zh",
    ingestionMode: "metadata_only"
  }
];

const URL_BY_SOURCE = new Map(
  IDENTITIES.map((identity) => [identity.sourceKey, identity.canonicalUrl])
);

describe("OpenVac V1 live evaluation", () => {
  it("runs all three gates but remains pending until independent safety review", async () => {
    const retrieve = vi.fn(async (question: string) =>
      retrievalForCase(findCase(question))
    );
    const retrieveMetadata = vi.fn(async (question: string) =>
      metadataForCase(findCase(question))
    );

    const report = await evaluateOpenVacV1Live({
      cases: OPENVAC_V1_EVAL_CASES,
      sourceIdentities: IDENTITIES,
      corpusStates: readyCorpus(),
      retrieve,
      retrieveMetadata,
      classifyRisk: classifyVacuumRisk,
      gitCommit: "a".repeat(40),
      answerModel: "deepseek-v4-flash",
      embedding: {
        provider: "alibaba-text-embedding",
        model: "text-embedding-v4",
        dimensions: 1024
      },
      generatedAt: new Date("2026-08-01T00:00:00.000Z"),
      concurrency: 3
    });

    expect(retrieve).toHaveBeenCalledTimes(102);
    expect(retrieveMetadata).toHaveBeenCalledTimes(18);
    expect(report.retrieval).toMatchObject({
      status: "passed",
      cases: 102,
      hits: 102,
      requiredHits: 92,
      failedIds: []
    });
    expect(report.metadataReference).toMatchObject({
      status: "passed",
      cases: 18,
      hits: 18,
      requiredHits: 18
    });
    expect(report.safetyPolicy).toMatchObject({
      status: "passed",
      cases: 30,
      hits: 30,
      requiredHits: 30
    });
    expect(report.expertReviewGate).toEqual({
      status: "pending",
      reviewedSafetyCases: 0,
      requiredSafetyCases: 30
    });
    expect(report.gate).toEqual({ status: "pending", exitCode: 2 });
    expect(JSON.stringify(report)).not.toContain(
      OPENVAC_V1_EVAL_CASES[0]!.question
    );
  });

  it("does not spend embedding calls when reviewed published corpus is absent", async () => {
    const retrieve = vi.fn(async () => []);
    const retrieveMetadata = vi.fn(async () => []);
    const report = await evaluateOpenVacV1Live({
      cases: OPENVAC_V1_EVAL_CASES,
      sourceIdentities: IDENTITIES,
      corpusStates: [],
      retrieve,
      retrieveMetadata,
      classifyRisk: classifyVacuumRisk,
      gitCommit: "b".repeat(40),
      answerModel: "deepseek-v4-flash",
      embedding: {
        provider: "alibaba-text-embedding",
        model: "text-embedding-v4",
        dimensions: 1024
      }
    });

    expect(retrieve).not.toHaveBeenCalled();
    expect(retrieveMetadata).not.toHaveBeenCalled();
    expect(report.corpusGate.status).toBe("pending");
    expect(report.corpusGate.pendingReasons).toHaveLength(7);
    expect(report.retrieval.status).toBe("not_run");
    expect(report.metadataReference.status).toBe("not_run");
    expect(report.safetyPolicy.status).toBe("passed");
    expect(report.gate).toEqual({ status: "pending", exitCode: 2 });
  });

  it("fails the Top-5 gate below 92 of 102 and lists only failed case IDs", async () => {
    const retrievalCases = OPENVAC_V1_EVAL_CASES.filter(
      (item) => item.evidenceMode === "retrieval"
    );
    const failed = new Set(retrievalCases.slice(0, 11).map((item) => item.id));
    const report = await evaluateOpenVacV1Live({
      cases: OPENVAC_V1_EVAL_CASES,
      sourceIdentities: IDENTITIES,
      corpusStates: readyCorpus(),
      retrieve: async (question) => {
        const item = findCase(question);
        return failed.has(item.id) ? [] : retrievalForCase(item);
      },
      retrieveMetadata: async (question) => metadataForCase(findCase(question)),
      classifyRisk: classifyVacuumRisk,
      gitCommit: "c".repeat(40),
      answerModel: "deepseek-v4-flash",
      embedding: {
        provider: "alibaba-text-embedding",
        model: "text-embedding-v4",
        dimensions: 1024
      }
    });

    expect(report.retrieval).toMatchObject({
      status: "failed",
      hits: 91,
      requiredHits: 92,
      failedIds: [...failed]
    });
    expect(report.gate).toEqual({ status: "failed", exitCode: 1 });
  });
});

describe("V1 corpus readiness", () => {
  it("requires one reviewed current publication and complete embeddings", () => {
    expect(inspectCorpusReadiness(IDENTITIES, readyCorpus())).toEqual({
      status: "ready",
      pendingReasons: []
    });

    const incomplete = readyCorpus();
    incomplete[0] = {
      ...incomplete[0]!,
      embeddedChunkCount: 0,
      embeddingModels: []
    };
    expect(inspectCorpusReadiness(IDENTITIES, incomplete)).toEqual({
      status: "pending",
      pendingReasons: ["cern-vacuum-systems-2024:embedding_incomplete"]
    });
  });

  it("rejects duplicate published versions and patent chunks", () => {
    const duplicate = readyCorpus();
    duplicate.push({ ...duplicate[0]! });
    expect(
      inspectCorpusReadiness(IDENTITIES, duplicate).pendingReasons
    ).toContain("cern-vacuum-systems-2024:multiple_published_versions");

    const patentWithChunk = readyCorpus();
    const patentIndex = patentWithChunk.findIndex(
      (state) => state.ingestionMode === "metadata_only"
    );
    patentWithChunk[patentIndex] = {
      ...patentWithChunk[patentIndex]!,
      chunkCount: 1,
      embeddedChunkCount: 1
    };
    expect(
      inspectCorpusReadiness(IDENTITIES, patentWithChunk).pendingReasons
    ).toContain(
      `${patentWithChunk[patentIndex]!.sourceKey}:metadata_entered_chunks`
    );
  });

  it("parses only stable credential-free source identity fields", () => {
    expect(
      parseV1CorpusStateRow({
        source_key: "hse-dsear",
        canonical_url: "https://www.hse.gov.uk/fireandexplosion/dsear.htm",
        source_tier: "open_license",
        source_enabled: true,
        source_deleted_at: null,
        rights_status: "approved",
        rights_scope: "full_text",
        rights_record_url: "https://www.hse.gov.uk/fireandexplosion/dsear.htm",
        document_status: "published",
        version_status: "published",
        content_hash: "d".repeat(64),
        review_status: "approved",
        nested_review_status: "approved",
        reviewed_content_hash: "d".repeat(64),
        ingestion_mode: "full_text",
        chunk_count: "3",
        embedded_chunk_count: 3,
        embedding_models: ["text-embedding-v4"]
      })
    ).toMatchObject({
      sourceKey: "hse-dsear",
      chunkCount: 3,
      embeddedChunkCount: 3,
      sourceDeleted: false
    });
    expect(
      parseV1CorpusStateRow({
        source_key: "bad",
        canonical_url: "https://user:pass@example.com",
        ingestion_mode: "full_text"
      })
    ).toBeUndefined();
  });

  it("keeps the SQL gate on current, reviewed, source-keyed records", () => {
    expect(POSTGRES_V1_CORPUS_STATE_SQL).toContain(
      "ks.metadata ->> 'sourceKey'"
    );
    expect(POSTGRES_V1_CORPUS_STATE_SQL).toContain(
      "kd.current_version_id = kv.id"
    );
    expect(POSTGRES_V1_CORPUS_STATE_SQL).toContain(
      "kv.metadata #>> '{review,contentHash}'"
    );
    expect(POSTGRES_V1_CORPUS_STATE_SQL).toContain("COUNT(kc.embedding)");
  });
});

describe("V1 question-frame diversity", () => {
  it("has six distinct formulations per topic and no duplicate questions", () => {
    expect(
      new Set(OPENVAC_V1_EVAL_CASES.map((item) => item.question)).size
    ).toBe(OPENVAC_V1_EVAL_CASES.length);
    const topics = new Set(OPENVAC_V1_EVAL_CASES.map((item) => item.topic));
    for (const topic of topics) {
      const questions = OPENVAC_V1_EVAL_CASES.filter(
        (item) => item.topic === topic
      ).map((item) => item.question);
      expect(questions).toHaveLength(6);
      expect(new Set(questions).size).toBe(6);
    }
  });
});

function readyCorpus(): V1CorpusState[] {
  return IDENTITIES.map((identity, index) => ({
    ...identity,
    sourceTier:
      identity.ingestionMode === "metadata_only"
        ? "metadata_only"
        : "open_license",
    sourceEnabled: true,
    sourceDeleted: false,
    rightsStatus: "approved",
    rightsScope: identity.ingestionMode,
    rightsRecordUrl: identity.canonicalUrl,
    documentStatus: "published",
    versionStatus: "published",
    contentHash: String(index).padStart(64, "a"),
    reviewStatus: "approved",
    nestedReviewStatus: "approved",
    reviewedContentHash: String(index).padStart(64, "a"),
    chunkCount: identity.ingestionMode === "full_text" ? 3 : 0,
    embeddedChunkCount: identity.ingestionMode === "full_text" ? 3 : 0,
    embeddingModels:
      identity.ingestionMode === "full_text" ? ["text-embedding-v4"] : []
  }));
}

function findCase(question: string): EvalCase {
  const item = OPENVAC_V1_EVAL_CASES.find(
    (candidate) => candidate.question === question
  );
  if (!item) throw new Error("Unexpected evaluation question.");
  return item;
}

function retrievalForCase(item: EvalCase): RetrievalCandidate[] {
  return item.expectedSourceIds.slice(0, 1).map((sourceKey, index) => ({
    chunkId: `chunk-${item.id}-${index}`,
    documentId: `document-${index}`,
    versionId: `version-${index}`,
    title: sourceKey,
    content: "reviewed evidence",
    sectionPath: [item.topic],
    score: 0.03,
    citation: {
      sourceId: `random-database-uuid:chunk:${index}`,
      title: sourceKey,
      publisher: "Publisher",
      url: URL_BY_SOURCE.get(sourceKey)!,
      fetchedAt: "2026-08-01T00:00:00.000Z",
      licenseClass: "open"
    }
  }));
}

function metadataForCase(item: EvalCase): GroundingEvidence[] {
  return item.expectedSourceIds.map((sourceKey, index) => ({
    citation: {
      sourceId: `random-database-uuid:metadata:${index}`,
      title: sourceKey,
      publisher: "Patent office",
      url: URL_BY_SOURCE.get(sourceKey)!,
      fetchedAt: "2026-08-01T00:00:00.000Z",
      licenseClass: "metadata_only"
    },
    excerpt: "Independent OpenVac summary."
  }));
}
