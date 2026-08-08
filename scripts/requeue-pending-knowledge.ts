import { sqlClient } from "../src/server/db";
import {
  PendingKnowledgeReviewRequeueService,
  parsePendingReviewRequeueArgs
} from "../src/server/knowledge/pending-review-requeue";

const input = parsePendingReviewRequeueArgs(process.argv.slice(2));

try {
  const result = await new PendingKnowledgeReviewRequeueService().run(input);
  console.log(JSON.stringify(result, null, 2));
  if (!input.apply && result.eligible > 0) {
    console.log(
      "Dry run only. Re-run with --apply to create queued initial runs."
    );
  }
} finally {
  await sqlClient.end({ timeout: 5 });
}
