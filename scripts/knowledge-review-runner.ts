import { readFile } from "node:fs/promises";

import {
  createKnowledgeReviewAutomationClientFromEnv,
  parseKnowledgeReviewJob,
  parseKnowledgeReviewRunnerArgs,
  parseKnowledgeReviewSubmission,
  writeKnowledgeReviewJob
} from "../src/server/knowledge/automation-review-client";

const args = parseKnowledgeReviewRunnerArgs(process.argv.slice(2));
const client = createKnowledgeReviewAutomationClientFromEnv();

if (args.command === "claim") {
  const claims = await client.claim(args.phase, args.max);
  const paths: string[] = [];
  for (const claim of claims) {
    const reviewPackage = await client.getPackage(claim);
    paths.push(
      await writeKnowledgeReviewJob(args.stateDir, {
        claim,
        package: reviewPackage
      })
    );
  }
  console.log(
    JSON.stringify({ phase: args.phase, claimed: paths.length, jobs: paths })
  );
} else {
  const job = parseKnowledgeReviewJob(
    JSON.parse(await readFile(args.jobPath, "utf8"))
  );
  const submission = parseKnowledgeReviewSubmission(
    JSON.parse(await readFile(args.reportPath, "utf8"))
  );
  const outcome = await client.submit(job.claim, submission);
  console.log(JSON.stringify(outcome));
}
