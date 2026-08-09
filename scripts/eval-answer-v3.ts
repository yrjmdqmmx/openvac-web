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
const gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8"
}).trim();
const report = await runAnswerV3Eval({ dependencies, gitSha });
const outputDirectory = path.resolve(process.cwd(), ".artifacts", "evals");
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
