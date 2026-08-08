import { createHash } from "node:crypto";

import { ApiError } from "@/server/api/errors";
import { sqlClient } from "@/server/db";

import {
  KNOWLEDGE_AUTOMATION_POLICY_VERSION,
  evaluateKnowledgePublicationReadiness
} from "./review-policy";
import {
  assertKnowledgePublicationEvidence,
  assertKnowledgeSourceAuthorized,
  isKnowledgeSourceTier
} from "./source-policy";
import type {
  AutomationReviewOutcome,
  KnowledgeReviewAutomationRepository,
  LeaseCandidate,
  ReviewPackageRecord
} from "./automation-review-service";

const SYSTEM_ACTOR_ROLE = "system:knowledge-review-automation";
const SYSTEM_ACTOR_ID = "knowledge-review-automation";

export interface KnowledgeReviewSql {
  unsafe(
    query: string,
    parameters?: unknown[]
  ): Promise<Array<Record<string, unknown>>>;
  begin<T>(
    handler: (transaction: KnowledgeReviewSql) => Promise<T>
  ): Promise<T>;
}

export class PostgresKnowledgeReviewAutomationRepository implements KnowledgeReviewAutomationRepository {
  constructor(
    private readonly sql: KnowledgeReviewSql = sqlClient as unknown as KnowledgeReviewSql
  ) {}

  async claim(
    input: Parameters<KnowledgeReviewAutomationRepository["claim"]>[0]
  ): Promise<LeaseCandidate[]> {
    return this.sql.begin(async (transaction) => {
      await transaction.unsafe(
        `
          UPDATE knowledge_review_run
          SET
            status = 'queued',
            lease_token_hash = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
          WHERE status = 'leased' AND lease_expires_at <= NOW()
        `
      );
      const candidates = await transaction.unsafe(
        `
          SELECT
            r.id,
            r.phase,
            r.input_version_id,
            r.input_content_hash,
            r.model,
            r.attempts
          FROM knowledge_review_run r
          JOIN knowledge_version kv ON kv.id = r.input_version_id
          JOIN knowledge_document kd ON kd.id = kv.document_id
          WHERE
            r.status = 'queued'
            AND r.phase = $1
            AND r.prompt_version = $3
            AND r.model = 'gpt-5.5-codex'
            AND kd.current_version_id = kv.id
            AND kv.content_hash = r.input_content_hash
            AND kd.status IN ('review', 'processing')
          ORDER BY r.created_at ASC, r.id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        `,
        [input.phase, input.max, input.promptVersion]
      );

      const claimed: LeaseCandidate[] = [];
      for (const [tokenSlot, candidate] of candidates.entries()) {
        const id = stringValue(candidate.id);
        const tokenHash = input.leaseTokenHashes[tokenSlot];
        if (!id || !tokenHash) continue;
        const rows = await transaction.unsafe(
          `
            UPDATE knowledge_review_run
            SET
              status = 'leased',
              lease_token_hash = $2,
              lease_expires_at = NOW() + make_interval(secs => $3),
              attempts = attempts + 1,
              updated_at = NOW()
            WHERE id = $1 AND status = 'queued'
            RETURNING id, attempts, lease_expires_at
          `,
          [id, tokenHash, input.leaseSeconds]
        );
        const updated = rows[0];
        if (!updated) continue;
        claimed.push({
          id,
          phase: input.phase,
          inputVersionId: requiredString(candidate.input_version_id),
          inputContentHash: requiredString(candidate.input_content_hash),
          model: requiredString(candidate.model),
          attempts: numberValue(updated.attempts),
          tokenSlot,
          leaseExpiresAt: dateString(updated.lease_expires_at)
        });
        await writeAudit(transaction, {
          action: "knowledge.automation_review.claimed",
          targetId: id,
          metadata: {
            phase: input.phase,
            inputVersionId: candidate.input_version_id,
            inputContentHash: candidate.input_content_hash,
            attempts: updated.attempts,
            leaseExpiresAt: updated.lease_expires_at
          }
        });
      }
      return claimed;
    });
  }

  async loadPackage(
    input: Parameters<KnowledgeReviewAutomationRepository["loadPackage"]>[0]
  ): Promise<ReviewPackageRecord | null> {
    const rows = await this.sql.unsafe(
      `
        SELECT
          r.id,
          r.phase,
          r.input_version_id,
          r.input_content_hash,
          kv.content,
          kv.citation_metadata,
          kv.metadata AS version_metadata,
          ks.id AS source_id,
          ks.kind AS source_kind,
          ks.name AS source_name,
          ks.canonical_url,
          ks.publisher,
          ks.source_tier,
          ks.license_policy,
          ks.enabled AS source_enabled,
          ks.deleted_at AS source_deleted_at,
          ks.metadata AS source_metadata,
          ko.object_key,
          ko.original_filename,
          ko.mime_type,
          ko.size_bytes,
          ko.sha256 AS original_sha256
        FROM knowledge_review_run r
        JOIN knowledge_version kv ON kv.id = r.input_version_id
        JOIN knowledge_document kd ON kd.id = kv.document_id
        LEFT JOIN knowledge_source ks ON ks.id = kd.source_id
        LEFT JOIN LATERAL (
          SELECT original.*
          FROM knowledge_original original
          WHERE original.version_id = kv.id
             OR original.version_id::text = kv.metadata ->> 'originalReferenceVersionId'
          ORDER BY CASE WHEN original.version_id = kv.id THEN 0 ELSE 1 END
          LIMIT 1
        ) ko ON TRUE
        WHERE
          r.id = $1
          AND r.phase = $2
          AND r.lease_token_hash = $3
          AND r.status = 'leased'
          AND r.lease_expires_at > NOW()
          AND kd.current_version_id = kv.id
          AND kv.content_hash = r.input_content_hash
        LIMIT 1
      `,
      [input.id, input.phase, input.leaseTokenHash]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: requiredString(row.id),
      phase: input.phase,
      inputVersionId: requiredString(row.input_version_id),
      inputContentHash: requiredString(row.input_content_hash),
      content: requiredString(row.content),
      citationMetadata: recordValue(row.citation_metadata),
      versionMetadata: recordValue(row.version_metadata),
      source: stringValue(row.source_id)
        ? {
            id: row.source_id,
            kind: row.source_kind,
            name: row.source_name,
            canonicalUrl: row.canonical_url,
            publisher: row.publisher,
            sourceTier: row.source_tier,
            licensePolicy: row.license_policy,
            enabled: row.source_enabled,
            deletedAt: row.source_deleted_at,
            metadata: recordValue(row.source_metadata)
          }
        : null,
      original: stringValue(row.object_key)
        ? {
            objectKey: requiredString(row.object_key),
            originalFilename: requiredString(row.original_filename),
            mimeType: requiredString(row.mime_type),
            sizeBytes: numberValue(row.size_bytes),
            sha256: requiredString(row.original_sha256)
          }
        : null
    };
  }

  async complete(
    input: Parameters<KnowledgeReviewAutomationRepository["complete"]>[0]
  ): Promise<AutomationReviewOutcome> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction.unsafe(
        `
          SELECT
            r.*,
            kv.document_id,
            kv.version,
            kv.content,
            kv.content_hash,
            kv.citation_metadata,
            kv.metadata AS version_metadata,
            kv.object_key AS version_object_key,
            kv.created_by,
            kd.current_version_id,
            kd.source_id,
            kd.status AS document_status,
            ks.source_tier,
            ks.enabled AS source_enabled,
            ks.deleted_at AS source_deleted_at,
            ks.canonical_url,
            ks.publisher,
            ks.metadata AS source_metadata,
            ko.version_id AS original_version_id
          FROM knowledge_review_run r
          JOIN knowledge_version kv ON kv.id = r.input_version_id
          JOIN knowledge_document kd ON kd.id = kv.document_id
          LEFT JOIN knowledge_source ks ON ks.id = kd.source_id
          LEFT JOIN LATERAL (
            SELECT original.version_id
            FROM knowledge_original original
            WHERE original.version_id = kv.id
               OR original.version_id::text = kv.metadata ->> 'originalReferenceVersionId'
            ORDER BY CASE WHEN original.version_id = kv.id THEN 0 ELSE 1 END
            LIMIT 1
          ) ko ON TRUE
          WHERE
            r.id = $1
            AND r.phase = $2
            AND r.lease_token_hash = $3
            AND r.input_version_id = $4
            AND r.input_content_hash = $5
            AND r.status = 'leased'
            AND r.lease_expires_at > NOW()
            AND kd.current_version_id = kv.id
            AND kv.content_hash = r.input_content_hash
          FOR UPDATE OF r, kv, kd
        `,
        [
          input.id,
          input.phase,
          input.leaseTokenHash,
          input.inputVersionId,
          input.inputContentHash
        ]
      );
      const row = rows[0];
      const submittedRevisionHash =
        input.revisedContent === undefined
          ? null
          : sha256(input.revisedContent);
      if (!row) {
        const replay = await transaction.unsafe(
          `
            SELECT structured_report, status, decision, revised_version_id, input_version_id
            FROM knowledge_review_run
            WHERE id = $1 AND phase = $2 AND input_version_id = $4 AND input_content_hash = $5
              AND structured_report #>> '{automation,idempotencyTokenHash}' = $3
              AND structured_report #> '{automation,submittedReport}' = $6::jsonb
              AND structured_report #>> '{automation,submittedRevisionHash}'
                    IS NOT DISTINCT FROM $7
            LIMIT 1
          `,
          [
            input.id,
            input.phase,
            input.leaseTokenHash,
            input.inputVersionId,
            input.inputContentHash,
            JSON.stringify(input.report),
            submittedRevisionHash
          ]
        );
        if (replay[0]) return replayOutcome(input.id, replay[0]);
        throw new ApiError(
          409,
          "KNOWLEDGE_REVIEW_LEASE_INVALID",
          "Review lease is expired, stale, replayed with different data, or invalid."
        );
      }

      const citationMetadata = recordValue(row.citation_metadata);
      const sourceValid = isSourceAuthorized(row, citationMetadata);
      let finalSourceRightsValid = sourceValid;
      let effectiveDecision: AutomationReviewOutcome["decision"] = sourceValid
        ? input.report.decision
        : "needs_human";
      let status: AutomationReviewOutcome["status"] =
        effectiveDecision === "approved"
          ? "completed"
          : effectiveDecision === "needs_human"
            ? "needs_human"
            : "failed";
      let finalStatus: AutomationReviewOutcome["status"] = status;
      let finalDecision: AutomationReviewOutcome["decision"] =
        effectiveDecision;
      let currentVersionId = input.inputVersionId;
      let currentContentHash = input.inputContentHash;
      let revisedVersionId: string | null = null;

      if (
        input.phase === "initial" &&
        status === "completed" &&
        input.revisedContent !== undefined
      ) {
        currentContentHash = sha256(input.revisedContent);
        const inserted = await transaction.unsafe(
          `
            INSERT INTO knowledge_version (
              id, document_id, version, content_hash, content, citation_metadata,
              status, object_key, parser_version, source_updated_at, metadata,
              created_by, created_at, updated_at
            )
            SELECT
              gen_random_uuid(), kv.document_id,
              (SELECT COALESCE(MAX(version), 0) + 1 FROM knowledge_version WHERE document_id = kv.document_id),
              $2, $3, kv.citation_metadata, 'review', kv.object_key,
              kv.parser_version, kv.source_updated_at,
              (kv.metadata - 'review') || $4::jsonb,
              kv.created_by, NOW(), NOW()
            FROM knowledge_version kv
            WHERE kv.id = $1 AND kv.content_hash = $5
            RETURNING id
          `,
          [
            input.inputVersionId,
            currentContentHash,
            input.revisedContent,
            JSON.stringify({
              reviewStatus: "required",
              embeddingStatus: "pending_review",
              originalReferenceVersionId:
                stringValue(row.original_version_id) ?? input.inputVersionId
            }),
            input.inputContentHash
          ]
        );
        revisedVersionId = requiredString(inserted[0]?.id);
        currentVersionId = revisedVersionId;
        const moved = await transaction.unsafe(
          `
            UPDATE knowledge_document
            SET current_version_id = $2, status = 'review', updated_at = NOW()
            WHERE id = $1 AND current_version_id = $3
            RETURNING id
          `,
          [row.document_id, currentVersionId, input.inputVersionId]
        );
        if (moved.length !== 1) throw staleVersion();
      }

      if (input.phase === "initial" && status === "completed") {
        const lockedSource = await lockCurrentSourceForPublication(
          transaction,
          row.document_id,
          currentVersionId,
          currentContentHash
        );
        finalSourceRightsValid = lockedSource?.valid === true;
        if (!finalSourceRightsValid) {
          effectiveDecision = "needs_human";
          status = "needs_human";
          finalStatus = "needs_human";
          finalDecision = "needs_human";
        }
      }

      const storedReport = {
        summary: input.report.summary,
        outputContentHash: currentContentHash,
        blockers: input.report.blockers,
        numericClaims: input.report.numericClaims,
        findings: input.report.findings,
        evidence: input.report.evidence,
        automation: {
          idempotencyTokenHash: input.leaseTokenHash,
          submittedReport: input.report,
          submittedRevisionHash,
          actor: SYSTEM_ACTOR_ID,
          outputVersionId: currentVersionId,
          outputContentHash: currentContentHash,
          sourceRightsValid: finalSourceRightsValid,
          queuedPhase: null
        }
      };
      const completed = await transaction.unsafe(
        `
          UPDATE knowledge_review_run
          SET
            status = $2,
            risk = $3,
            structured_report = $4::jsonb,
            decision = $5,
            revised_version_id = $6,
            completed_at = NOW(),
            lease_token_hash = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
          WHERE id = $1 AND status = 'leased'
          RETURNING id
        `,
        [
          input.id,
          status,
          input.report.risk,
          JSON.stringify(storedReport),
          effectiveDecision,
          revisedVersionId
        ]
      );
      if (completed.length !== 1) throw staleVersion();

      let queuedPhase: AutomationReviewOutcome["queuedPhase"] = null;
      if (input.phase === "initial" && status === "completed") {
        await transaction.unsafe(
          `
            INSERT INTO knowledge_review_run (
              phase, status, input_version_id, input_content_hash,
              model, prompt_version, created_at, updated_at
            ) VALUES ('verify', 'queued', $1, $2, $3, $4, NOW(), NOW())
            ON CONFLICT (input_version_id, input_content_hash, prompt_version, phase)
            DO NOTHING
          `,
          [
            currentVersionId,
            currentContentHash,
            row.model,
            KNOWLEDGE_AUTOMATION_POLICY_VERSION
          ]
        );
        queuedPhase = "verify";
      } else if (input.phase === "verify" && status === "completed") {
        const lockedSource = await lockCurrentSourceForPublication(
          transaction,
          row.document_id,
          currentVersionId,
          currentContentHash
        );
        finalSourceRightsValid = lockedSource?.valid === true;
        const runs = await transaction.unsafe(
          `
            SELECT * FROM knowledge_review_run
            WHERE prompt_version = $3
              AND (
                (input_version_id = $1 AND input_content_hash = $2)
                OR revised_version_id = $1
              )
            ORDER BY created_at ASC
          `,
          [
            currentVersionId,
            currentContentHash,
            KNOWLEDGE_AUTOMATION_POLICY_VERSION
          ]
        );
        const readiness = evaluateKnowledgePublicationReadiness({
          currentVersionId,
          currentContentHash,
          sourceRightsValid: finalSourceRightsValid,
          automationRuns: runs.map(databaseRun),
          legacySectionReviewReady: false
        });
        if (
          readiness.ready &&
          readiness.path === KNOWLEDGE_AUTOMATION_POLICY_VERSION
        ) {
          const reviewMetadata = {
            status: "approved",
            policyVersion: KNOWLEDGE_AUTOMATION_POLICY_VERSION,
            reviewedBy: SYSTEM_ACTOR_ID,
            reviewedAt: new Date().toISOString(),
            contentHash: currentContentHash,
            risk: input.report.risk,
            initialRunId: findRunId(runs, "initial"),
            verifyRunId: input.id
          };
          const ingestionMode = lockedSource?.citationMetadata.ingestionMode;
          if (ingestionMode === "full_text") {
            await transaction.unsafe(
              `
                UPDATE knowledge_version
                SET metadata = metadata || $2::jsonb, status = 'review', updated_at = NOW()
                WHERE id = $1 AND content_hash = $3
              `,
              [
                currentVersionId,
                JSON.stringify({
                  reviewStatus: "approved",
                  embeddingStatus: "queued",
                  review: reviewMetadata
                }),
                currentContentHash
              ]
            );
            await transaction.unsafe(
              `
                INSERT INTO background_task (
                  type, status, priority, idempotency_key, payload, run_at, max_attempts,
                  created_at, updated_at
                ) VALUES ('knowledge_ingestion', 'queued', 10, $1, $2::jsonb, NOW(), 3, NOW(), NOW())
                ON CONFLICT (idempotency_key) DO NOTHING
              `,
              [
                `knowledge-embedding:${currentVersionId}:${currentContentHash}:${KNOWLEDGE_AUTOMATION_POLICY_VERSION}`,
                JSON.stringify({
                  stage: "embedding_pending",
                  documentId: row.document_id,
                  versionId: currentVersionId,
                  review: reviewMetadata
                })
              ]
            );
            queuedPhase = "embedding";
          } else {
            await transaction.unsafe(
              `
                UPDATE knowledge_version
                SET status = 'published', published_at = NOW(),
                    metadata = metadata || $2::jsonb, updated_at = NOW()
                WHERE id = $1 AND content_hash = $3
              `,
              [
                currentVersionId,
                JSON.stringify({
                  reviewStatus: "approved",
                  embeddingStatus: "metadata_only",
                  review: reviewMetadata
                }),
                currentContentHash
              ]
            );
            await transaction.unsafe(
              "UPDATE knowledge_document SET status = 'published', updated_at = NOW() WHERE id = $1 AND current_version_id = $2",
              [row.document_id, currentVersionId]
            );
          }
        } else {
          await transaction.unsafe(
            `
              UPDATE knowledge_review_run
              SET status = 'needs_human', decision = 'needs_human', updated_at = NOW()
              WHERE id = $1 AND status = 'completed'
            `,
            [input.id]
          );
          finalStatus = "needs_human";
          finalDecision = "needs_human";
          await markNeedsHuman(
            transaction,
            row.document_id,
            currentVersionId,
            readiness.reasons
          );
        }
      } else {
        await markNeedsHuman(transaction, row.document_id, currentVersionId, [
          sourceValid ? `review_${status}` : "source_rights_invalid"
        ]);
      }

      await transaction.unsafe(
        `
          UPDATE knowledge_review_run
          SET structured_report = jsonb_set(
            jsonb_set(
              structured_report,
              '{automation,queuedPhase}',
              COALESCE(to_jsonb($2::text), 'null'::jsonb),
              true
            ),
            '{automation,sourceRightsValid}',
            to_jsonb($3::boolean),
            true
          ), updated_at = NOW()
          WHERE id = $1
        `,
        [input.id, queuedPhase, finalSourceRightsValid]
      );

      await writeAudit(transaction, {
        action: "knowledge.automation_review.result",
        targetId: input.id,
        metadata: {
          phase: input.phase,
          status: finalStatus,
          decision: finalDecision,
          inputVersionId: input.inputVersionId,
          currentVersionId,
          currentContentHash,
          queuedPhase
        }
      });
      return {
        runId: input.id,
        status: finalStatus,
        decision: finalDecision,
        currentVersionId,
        queuedPhase,
        idempotent: false
      };
    });
  }
}

async function lockCurrentSourceForPublication(
  sql: KnowledgeReviewSql,
  documentId: unknown,
  versionId: string,
  contentHash: string
): Promise<{
  valid: boolean;
  citationMetadata: Record<string, unknown>;
} | null> {
  const rows = await sql.unsafe(
    `
      SELECT
        kd.id AS document_id,
        kd.current_version_id,
        kv.content_hash,
        kv.citation_metadata,
        ks.id AS source_id,
        ks.source_tier,
        ks.enabled AS source_enabled,
        ks.deleted_at AS source_deleted_at,
        ks.canonical_url,
        ks.publisher,
        ks.metadata AS source_metadata
      FROM knowledge_document kd
      JOIN knowledge_version kv ON kv.id = kd.current_version_id
      JOIN knowledge_source ks ON ks.id = kd.source_id
      WHERE
        kd.id = $1
        AND kd.current_version_id = $2
        AND kv.content_hash = $3
      FOR UPDATE OF kd, ks
    `,
    [documentId, versionId, contentHash]
  );
  const row = rows[0];
  if (!row) return null;
  const citationMetadata = recordValue(row.citation_metadata);
  return {
    valid: isSourceAuthorized(row, citationMetadata),
    citationMetadata
  };
}

async function markNeedsHuman(
  sql: KnowledgeReviewSql,
  documentId: unknown,
  versionId: string,
  reasons: unknown[]
) {
  await sql.unsafe(
    `
      UPDATE knowledge_version
      SET status = 'review', metadata = metadata || $2::jsonb, updated_at = NOW()
      WHERE id = $1
    `,
    [
      versionId,
      JSON.stringify({
        reviewStatus: "required",
        automationStatus: "needs_human",
        automationReasons: reasons
      })
    ]
  );
  await sql.unsafe(
    "UPDATE knowledge_document SET status = 'review', updated_at = NOW() WHERE id = $1 AND current_version_id = $2",
    [documentId, versionId]
  );
}

async function writeAudit(
  sql: KnowledgeReviewSql,
  input: { action: string; targetId: string; metadata: Record<string, unknown> }
) {
  await sql.unsafe(
    `
      INSERT INTO audit_log (
        actor_user_id, actor_role, action, target_type, target_id, metadata, created_at
      ) VALUES (NULL, $1, $2, 'knowledge_review_run', $3, $4::jsonb, NOW())
    `,
    [
      SYSTEM_ACTOR_ROLE,
      input.action,
      input.targetId,
      JSON.stringify(input.metadata)
    ]
  );
}

function isSourceAuthorized(
  row: Record<string, unknown>,
  citationMetadata: Record<string, unknown>
): boolean {
  if (!stringValue(row.source_id) || !isKnowledgeSourceTier(row.source_tier)) {
    return false;
  }
  try {
    const source = {
      sourceTier: row.source_tier,
      enabled: row.source_enabled === true,
      deletedAt:
        row.source_deleted_at instanceof Date ||
        typeof row.source_deleted_at === "string"
          ? row.source_deleted_at
          : null,
      canonicalUrl: stringValue(row.canonical_url),
      publisher: stringValue(row.publisher),
      metadata: recordValue(row.source_metadata)
    };
    assertKnowledgeSourceAuthorized(source, citationMetadata);
    assertKnowledgePublicationEvidence(source, citationMetadata);
    return true;
  } catch {
    return false;
  }
}

function databaseRun(row: Record<string, unknown>) {
  return {
    id: row.id,
    phase: row.phase,
    status: row.status,
    inputVersionId: row.input_version_id,
    inputContentHash: row.input_content_hash,
    model: row.model,
    promptVersion: row.prompt_version,
    risk: row.risk,
    structuredReport: row.structured_report,
    decision: row.decision,
    revisedVersionId: row.revised_version_id,
    completedAt: normalizeDatabaseTimestamp(row.completed_at)
  };
}

function normalizeDatabaseTimestamp(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return value;

  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed;
}

function findRunId(rows: Array<Record<string, unknown>>, phase: string) {
  return rows.find((row) => row.phase === phase)?.id ?? null;
}

function replayOutcome(
  runId: string,
  row: Record<string, unknown>
): AutomationReviewOutcome {
  const report = recordValue(row.structured_report);
  const automation = recordValue(report.automation);
  const status = row.status;
  const decision = row.decision;
  if (
    status !== "completed" &&
    status !== "needs_human" &&
    status !== "failed"
  ) {
    throw staleVersion();
  }
  if (
    decision !== "approved" &&
    decision !== "needs_human" &&
    decision !== "rejected"
  ) {
    throw staleVersion();
  }
  return {
    runId,
    status,
    decision,
    currentVersionId:
      stringValue(automation.outputVersionId) ??
      stringValue(row.revised_version_id) ??
      requiredString(row.input_version_id),
    queuedPhase:
      automation.queuedPhase === "verify" ||
      automation.queuedPhase === "embedding"
        ? automation.queuedPhase
        : null,
    idempotent: true
  };
}

function staleVersion() {
  return new ApiError(
    409,
    "KNOWLEDGE_REVIEW_STALE",
    "Knowledge review target changed before the result could be applied."
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredString(value: unknown): string {
  const parsed = stringValue(value);
  if (!parsed) throw new Error("Malformed knowledge review database row.");
  return parsed;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Malformed knowledge review database number.");
  }
  return value;
}

function dateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new Error("Malformed knowledge review database date.");
}

export const knowledgeReviewAutomationRepository =
  new PostgresKnowledgeReviewAutomationRepository();
