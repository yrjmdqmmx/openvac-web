import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sqlClient } from "@/server/db";

import {
  PostgresKnowledgeReviewAutomationRepository,
  type KnowledgeReviewSql
} from "./automation-review-repository";
import { KNOWLEDGE_AUTOMATION_POLICY_VERSION } from "./review-policy";

const describeDatabase =
  process.env.RUN_DATABASE_TESTS === "true" ? describe : describe.skip;

describeDatabase("knowledge automation result PostgreSQL integration", () => {
  it("records an initial needs_human result without skipped SQL parameters", async () => {
    const documentId = randomUUID();
    const versionId = randomUUID();
    const runId = randomUUID();
    const contentHash = "a".repeat(64);
    const leaseTokenHash = "b".repeat(64);

    try {
      await sqlClient.unsafe(
        `INSERT INTO knowledge_document (id, title, status, metadata)
         VALUES ($1, 'Integration review document', 'review', '{}'::jsonb)`,
        [documentId]
      );
      await sqlClient.unsafe(
        `INSERT INTO knowledge_version (
           id, document_id, version, content_hash, content, citation_metadata,
           status, metadata
         ) VALUES ($1, $2, 1, $3, 'review content', '{}'::jsonb, 'review', '{}'::jsonb)`,
        [versionId, documentId, contentHash]
      );
      await sqlClient.unsafe(
        "UPDATE knowledge_document SET current_version_id = $2 WHERE id = $1",
        [documentId, versionId]
      );
      await sqlClient.unsafe(
        `INSERT INTO knowledge_review_run (
           id, phase, status, input_version_id, input_content_hash,
           model, prompt_version, lease_token_hash, lease_expires_at, attempts
         ) VALUES (
           $1, 'initial', 'leased', $2, $3,
           'gpt-5.5-codex', $4, $5, NOW() + INTERVAL '1 hour', 1
         )`,
        [
          runId,
          versionId,
          contentHash,
          KNOWLEDGE_AUTOMATION_POLICY_VERSION,
          leaseTokenHash
        ]
      );

      const repository = new PostgresKnowledgeReviewAutomationRepository(
        sqlClient as unknown as KnowledgeReviewSql
      );
      const outcome = await repository.complete({
        id: runId,
        phase: "initial",
        leaseTokenHash,
        inputVersionId: versionId,
        inputContentHash: contentHash,
        report: {
          summary: "Evidence requires a human decision.",
          risk: "medium",
          decision: "needs_human",
          findings: [
            {
              code: "EVIDENCE_INCOMPLETE",
              message: "The official evidence is incomplete."
            }
          ],
          blockers: [
            {
              code: "HUMAN_REVIEW_REQUIRED",
              message: "A human must resolve the evidence gap."
            }
          ],
          evidence: [],
          numericClaims: []
        }
      });

      expect(outcome).toMatchObject({
        runId,
        status: "needs_human",
        decision: "needs_human",
        currentVersionId: versionId,
        queuedPhase: null,
        idempotent: false
      });
      const [storedRun] = await sqlClient.unsafe(
        "SELECT status, decision, lease_token_hash, lease_expires_at FROM knowledge_review_run WHERE id = $1",
        [runId]
      );
      expect(storedRun).toMatchObject({
        status: "needs_human",
        decision: "needs_human",
        lease_token_hash: null,
        lease_expires_at: null
      });
    } finally {
      await sqlClient.unsafe(
        "DELETE FROM audit_log WHERE target_type = 'knowledge_review_run' AND target_id = $1",
        [runId]
      );
      await sqlClient.unsafe("DELETE FROM knowledge_review_run WHERE id = $1", [
        runId
      ]);
      await sqlClient.unsafe(
        "UPDATE knowledge_document SET current_version_id = NULL WHERE id = $1",
        [documentId]
      );
      await sqlClient.unsafe("DELETE FROM knowledge_version WHERE id = $1", [
        versionId
      ]);
      await sqlClient.unsafe("DELETE FROM knowledge_document WHERE id = $1", [
        documentId
      ]);
    }
  });
});
