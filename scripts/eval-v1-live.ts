import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import sourceManifest from "../knowledge/source-manifest.json";
import {
  evaluateOpenVacV1Live,
  parseV1CorpusStateRow,
  POSTGRES_V1_CORPUS_STATE_SQL,
  type V1SourceIdentity
} from "../src/evals/live-v1";
import { OPENVAC_V1_EVAL_CASES } from "../src/evals/v1";
import { classifyVacuumRisk } from "../src/server/agent/risk";
import { sqlClient } from "../src/server/db";
import { retrievePatentMetadataReferences } from "../src/server/knowledge/metadata-reference";
import {
  HybridRetriever,
  PostgresHybridRetrievalRepository
} from "../src/server/knowledge/retrieval";
import { getEmbeddingProvider } from "../src/server/providers";

const execFileAsync = promisify(execFile);
const PATENT_PREFIX = "patent-";
const expectedSourceKeys = new Set(
  OPENVAC_V1_EVAL_CASES.flatMap((item) => item.expectedSourceIds)
);
const sourceIdentities: V1SourceIdentity[] = sourceManifest
  .filter((source) => expectedSourceKeys.has(source.sourceKey))
  .map((source) => ({
    sourceKey: source.sourceKey,
    canonicalUrl: source.canonicalUrl,
    ingestionMode: source.sourceKey.startsWith(PATENT_PREFIX)
      ? "metadata_only"
      : "full_text"
  }));

if (sourceIdentities.length !== expectedSourceKeys.size) {
  const present = new Set(sourceIdentities.map((source) => source.sourceKey));
  const missing = [...expectedSourceKeys].filter((key) => !present.has(key));
  throw new Error(
    `Source manifest is missing evaluation identities: ${missing.join(", ")}`
  );
}

const concurrency = parseConcurrency(process.argv);
const embedding = getEmbeddingProvider();
const repository = new PostgresHybridRetrievalRepository((query, parameters) =>
  sqlClient.unsafe(query, [...parameters] as never[])
);
const retriever = new HybridRetriever({ embeddings: embedding, repository });
const gitCommit = await currentGitCommit();

try {
  const stateRows = await sqlClient.unsafe(POSTGRES_V1_CORPUS_STATE_SQL, [
    [...expectedSourceKeys]
  ]);
  const corpusStates = stateRows.flatMap((row) => {
    const state = parseV1CorpusStateRow(row);
    return state ? [state] : [];
  });
  const report = await evaluateOpenVacV1Live({
    cases: OPENVAC_V1_EVAL_CASES,
    sourceIdentities,
    corpusStates,
    retrieve: (question) =>
      retriever.retrieve(question, {
        limit: 5,
        candidateLimit: 50,
        minimumScore: 0.01
      }),
    retrieveMetadata: (question) =>
      retrievePatentMetadataReferences(question, (query, parameters) =>
        sqlClient.unsafe(query, [...parameters] as never[])
      ),
    classifyRisk: classifyVacuumRisk,
    gitCommit,
    answerModel: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash",
    embedding: {
      provider: embedding.id,
      model: embedding.model,
      dimensions: embedding.dimensions
    },
    concurrency
  });

  const output = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = await saveReport(output, report.gitCommit);
  process.stdout.write(output);
  process.stderr.write(`Evaluation report: ${outputPath}\n`);
  process.exitCode = report.gate.exitCode;
} catch {
  const report = {
    schemaVersion: 1,
    dataset: "openvac-v1",
    generatedAt: new Date().toISOString(),
    gitCommit,
    answerModel: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash",
    embedding: {
      provider: embedding.id,
      model: embedding.model,
      dimensions: embedding.dimensions
    },
    sourceIdentities: sourceIdentities.map((identity) => ({
      ...identity,
      contentHashes: [],
      embeddingModels: []
    })),
    corpusGate: {
      status: "pending",
      pendingReasons: ["evaluation_runtime_failure"]
    },
    expertReviewGate: {
      status: "pending",
      reviewedSafetyCases: 0,
      requiredSafetyCases: 30
    },
    retrieval: {
      status: "not_run",
      cases: 102,
      hits: 0,
      requiredHits: 92,
      failedIds: []
    },
    metadataReference: {
      status: "not_run",
      cases: 18,
      hits: 0,
      requiredHits: 18,
      failedIds: []
    },
    safetyPolicy: {
      status: "failed",
      cases: 30,
      hits: 0,
      requiredHits: 30,
      failedIds: []
    },
    errorCode: "evaluation_runtime_failure",
    gate: { status: "failed", exitCode: 1 }
  } as const;
  const output = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = await saveReport(output, gitCommit);
  process.stdout.write(output);
  process.stderr.write(`Evaluation report: ${outputPath}\n`);
  process.exitCode = 1;
} finally {
  await sqlClient.end({ timeout: 5 });
}

function parseConcurrency(arguments_: readonly string[]): number {
  const raw = arguments_
    .find((argument) => argument.startsWith("--concurrency="))
    ?.slice("--concurrency=".length);
  if (raw === undefined) return 2;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new Error("--concurrency must be an integer from 1 to 8.");
  }
  return value;
}

async function currentGitCommit(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      timeout: 5_000,
      encoding: "utf8"
    });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function saveReport(report: string, commit: string): Promise<string> {
  const directory = path.resolve(process.cwd(), ".artifacts", "evals");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const safeCommit = /^[a-f0-9]{7,64}$/u.test(commit)
    ? commit.slice(0, 12)
    : "unknown";
  const filename = `openvac-v1-live-${safeCommit}-${Date.now()}.json`;
  const outputPath = path.join(directory, filename);
  await writeFile(outputPath, report, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  return outputPath;
}
