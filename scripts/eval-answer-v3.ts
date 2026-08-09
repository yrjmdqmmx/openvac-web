import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import {
  createFixtureEvalDependencies,
  runAnswerV3Eval,
  type AnswerV3EvalDependencies
} from "../src/evals/answer-v3";

const live = process.argv.includes("--live");
const dependencies = live
  ? await loadLiveDependencies()
  : createFixtureEvalDependencies();
const requestedGitSha = process.env.ANSWER_V3_EVAL_GIT_SHA?.trim();
if (live && !requestedGitSha) {
  throw new Error(
    "ANSWER_V3_EVAL_GIT_SHA is required for --live and must match the checked-out commit."
  );
}
const repositoryGitSha = repositoryHead();
if (
  requestedGitSha &&
  (!/^[0-9a-f]{40}$/u.test(requestedGitSha) ||
    (repositoryGitSha !== undefined && requestedGitSha !== repositoryGitSha))
) {
  throw new Error(
    "ANSWER_V3_EVAL_GIT_SHA must match the checked-out 40-character Git SHA."
  );
}
const gitSha = requestedGitSha ?? repositoryGitSha;
if (!gitSha) {
  throw new Error(
    "A Git checkout or ANSWER_V3_EVAL_GIT_SHA is required for Answer V3 evaluation."
  );
}
const report = await runAnswerV3Eval({ dependencies, gitSha });
const outputDirectory = path.resolve(
  process.cwd(),
  process.env.ANSWER_V3_EVAL_OUTPUT_DIR?.trim() || ".artifacts/evals"
);
await mkdir(outputDirectory, { recursive: true });
const outputPath = path.join(
  outputDirectory,
  `answer-v3-${gitSha.slice(0, 12)}.json`
);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ ...report, reportPath: outputPath }, null, 2));
if (!report.passed) {
  process.exitCode = 1;
}

function repositoryHead(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
}

async function loadLiveDependencies(): Promise<AnswerV3EvalDependencies> {
  const adapterPath = process.env.ANSWER_V3_EVAL_ADAPTER?.trim();
  if (!adapterPath) {
    throw new Error(
      "ANSWER_V3_EVAL_ADAPTER is required for --live. The module must export createAnswerV3EvalDependencies()."
    );
  }
  const moduleUrl = pathToFileURL(
    path.resolve(process.cwd(), adapterPath)
  ).href;
  const adapter = (await import(moduleUrl)) as {
    createAnswerV3EvalDependencies?: () =>
      AnswerV3EvalDependencies | Promise<AnswerV3EvalDependencies>;
  };
  if (typeof adapter.createAnswerV3EvalDependencies !== "function") {
    throw new Error(
      "ANSWER_V3_EVAL_ADAPTER must export createAnswerV3EvalDependencies()."
    );
  }
  return adapter.createAnswerV3EvalDependencies();
}
