import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PostgresKnowledgeReviewAutomationRepository,
  type KnowledgeReviewSql
} from "./automation-review-repository";

const hash = "a".repeat(64);

describe("PostgresKnowledgeReviewAutomationRepository", () => {
  it("releases expired leases and claims rows atomically with SKIP LOCKED", async () => {
    const sql = new RecordingSql((query) =>
      query.includes("FOR UPDATE SKIP LOCKED")
        ? [
            {
              id: "00000000-0000-4000-8000-000000000001",
              phase: "initial",
              input_version_id: "00000000-0000-4000-8000-000000000002",
              input_content_hash: hash,
              model: "gpt-5.5-codex",
              attempts: 0
            }
          ]
        : query.includes("RETURNING id, attempts, lease_expires_at")
          ? [
              {
                id: "00000000-0000-4000-8000-000000000001",
                attempts: 1,
                lease_expires_at: new Date("2026-08-08T12:00:00Z")
              }
            ]
          : []
    );
    const repository = new PostgresKnowledgeReviewAutomationRepository(sql);

    const rows = await repository.claim({
      phase: "initial",
      max: 1,
      leaseTokenHashes: ["b".repeat(64)],
      leaseSeconds: 7200,
      promptVersion: "codex_automation_v1"
    });

    expect(sql.calls[0]?.query).toContain("lease_expires_at <= NOW()");
    expect(sql.find("FOR UPDATE SKIP LOCKED").query).toContain("LIMIT $2");
    expect(sql.find("FOR UPDATE SKIP LOCKED").query).toContain(
      "r.model = 'gpt-5.5-codex'"
    );
    const update = sql.find("RETURNING id, attempts, lease_expires_at");
    expect(update.query).toContain("attempts = attempts + 1");
    expect(update.query).toContain("make_interval(secs => $3)");
    expect(update.parameters).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "b".repeat(64),
      7200
    ]);
    expect(rows[0]).toMatchObject({ tokenSlot: 0, attempts: 1 });
    const audit = sql.find("INSERT INTO audit_log");
    expect(audit.parameters).toContain("system:knowledge-review-automation");
    expect(audit.parameters).toContain("knowledge.automation_review.claimed");
  });

  it("loads packages only for a live lease on the current exact version and hash", async () => {
    const sql = new RecordingSql(() => []);
    const repository = new PostgresKnowledgeReviewAutomationRepository(sql);

    await repository.loadPackage({
      id: "00000000-0000-4000-8000-000000000001",
      phase: "verify",
      leaseTokenHash: "b".repeat(64)
    });

    const query = sql.calls[0]!;
    expect(query.query).toContain("r.lease_expires_at > NOW()");
    expect(query.query).toContain("kd.current_version_id = kv.id");
    expect(query.query).toContain("kv.content_hash = r.input_content_hash");
    expect(query.query).toContain("r.lease_token_hash = $3");
    expect(query.query).toContain("knowledge_original");
  });

  it("locks result rows and verifies the lease, phase, current version, and content hash", async () => {
    const sql = new RecordingSql(() => []);
    const repository = new PostgresKnowledgeReviewAutomationRepository(sql);

    await expect(
      repository.complete({
        id: "00000000-0000-4000-8000-000000000001",
        phase: "verify",
        leaseTokenHash: "b".repeat(64),
        inputVersionId: "00000000-0000-4000-8000-000000000002",
        inputContentHash: hash,
        report: {
          summary: "ok",
          risk: "low",
          decision: "approved",
          findings: [],
          blockers: [],
          evidence: [],
          numericClaims: []
        }
      })
    ).rejects.toMatchObject({
      status: 409,
      code: "KNOWLEDGE_REVIEW_LEASE_INVALID"
    });

    const query = sql.find("FOR UPDATE OF r, kv, kd");
    expect(query.query).toContain("r.input_version_id = $4");
    expect(query.query).toContain("r.input_content_hash = $5");
    expect(query.query).toContain("kd.current_version_id = kv.id");
    expect(query.query).toContain("kv.content_hash = r.input_content_hash");
  });

  it("forces needs_human when the current review target has no governed source", async () => {
    const sql = new RecordingSql((query) => {
      if (query.includes("FOR UPDATE OF r, kv, kd")) {
        return [reviewTarget({ sourceId: null })];
      }
      return query.includes("RETURNING id") ? [{ id: "updated" }] : [];
    });
    const repository = new PostgresKnowledgeReviewAutomationRepository(sql);

    const outcome = await repository.complete(resultInput("initial"));

    expect(outcome).toMatchObject({
      status: "needs_human",
      decision: "needs_human",
      queuedPhase: null
    });
    expect(
      sql.calls.some((call) =>
        call.parameters?.some((value) =>
          String(value).includes("source_rights_invalid")
        )
      )
    ).toBe(true);
    const markNeedsHuman = sql.find("metadata = metadata || $2::jsonb");
    expect(markNeedsHuman.query).toContain("WHERE id = $1");
    expect(markNeedsHuman.parameters).toHaveLength(2);
    expect(markNeedsHuman.parameters?.[0]).toBe(
      "00000000-0000-4000-8000-000000000002"
    );
  });

  it("creates an immutable next version for revised initial content and queues exactly one verify", async () => {
    const revisedId = "00000000-0000-4000-8000-000000000009";
    const sql = new RecordingSql((query) => {
      if (query.includes("FOR UPDATE OF r, kv, kd")) return [reviewTarget()];
      if (query.includes("FOR UPDATE OF kd, ks")) {
        return [lockedCurrentSource(true)];
      }
      if (query.includes("INSERT INTO knowledge_version"))
        return [{ id: revisedId }];
      return query.includes("RETURNING id") ? [{ id: "updated" }] : [];
    });
    const repository = new PostgresKnowledgeReviewAutomationRepository(sql);

    const outcome = await repository.complete({
      ...resultInput("initial"),
      revisedContent: "immutable revised content"
    });

    expect(outcome).toMatchObject({
      currentVersionId: revisedId,
      queuedPhase: "verify"
    });
    const insert = sql.find("INSERT INTO knowledge_version");
    expect(insert.query).toContain("gen_random_uuid()");
    expect(insert.query).toContain("MAX(version)");
    expect(insert.parameters).toContain("immutable revised content");
    expect(
      sql.calls.filter((call) =>
        call.query.includes("INSERT INTO knowledge_review_run")
      )
    ).toHaveLength(1);
  });

  it("re-locks current source before initial approval queues independent verification", async () => {
    let finalSourceLocked = false;
    const sql = new RecordingSql((query) => {
      if (query.includes("FOR UPDATE OF r, kv, kd")) return [reviewTarget()];
      if (query.includes("FOR UPDATE OF kd, ks")) {
        finalSourceLocked = true;
        return [lockedCurrentSource(false)];
      }
      return query.includes("RETURNING id") ? [{ id: "updated" }] : [];
    });
    const repository = new PostgresKnowledgeReviewAutomationRepository(sql);

    const outcome = await repository.complete(resultInput("initial"));

    expect(finalSourceLocked).toBe(true);
    expect(outcome).toMatchObject({
      status: "needs_human",
      decision: "needs_human",
      queuedPhase: null
    });
    expect(
      sql.calls.some((call) =>
        call.query.includes("INSERT INTO knowledge_review_run")
      )
    ).toBe(false);
  });

  it("downgrades verify approval to needs_human when full publication gates find high risk", async () => {
    const sql = new RecordingSql((query) => {
      if (query.includes("FOR UPDATE OF r, kv, kd")) return [reviewTarget()];
      if (query.includes("FOR UPDATE OF kd, ks")) {
        return [lockedCurrentSource(true)];
      }
      if (query.includes("SELECT * FROM knowledge_review_run")) {
        return [
          databaseReviewRun("initial", "low"),
          databaseReviewRun("verify", "high")
        ];
      }
      return query.includes("RETURNING id") ? [{ id: "updated" }] : [];
    });
    const repository = new PostgresKnowledgeReviewAutomationRepository(sql);

    const outcome = await repository.complete({
      ...resultInput("verify"),
      report: { ...resultInput("verify").report, risk: "high" }
    });

    expect(outcome).toMatchObject({
      status: "needs_human",
      decision: "needs_human",
      queuedPhase: null
    });
  });

  it("queues one idempotent embedding job after a clean verify pair", async () => {
    const sql = new RecordingSql((query) => {
      if (query.includes("FOR UPDATE OF r, kv, kd")) return [reviewTarget()];
      if (query.includes("FOR UPDATE OF kd, ks")) {
        return [lockedCurrentSource(true)];
      }
      if (query.includes("SELECT * FROM knowledge_review_run")) {
        return [
          databaseReviewRun("initial", "low"),
          databaseReviewRun("verify", "low")
        ];
      }
      return query.includes("RETURNING id") ? [{ id: "updated" }] : [];
    });
    const repository = new PostgresKnowledgeReviewAutomationRepository(sql);

    const outcome = await repository.complete(resultInput("verify"));

    expect(outcome).toMatchObject({
      status: "completed",
      decision: "approved",
      queuedPhase: "embedding"
    });
    const task = sql.find("INSERT INTO background_task");
    expect(task.query).toContain("idempotency_key");
    expect(task.query).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect(task.parameters?.[0]).toContain("knowledge-embedding:");
  });

  it("re-locks the current source and refuses verify queueing after rights are disabled", async () => {
    let finalSourceLocked = false;
    const sql = new RecordingSql((query) => {
      if (query.includes("FOR UPDATE OF r, kv, kd")) return [reviewTarget()];
      if (query.includes("SELECT * FROM knowledge_review_run")) {
        return [
          databaseReviewRun("initial", "low"),
          databaseReviewRun("verify", "low")
        ];
      }
      if (query.includes("FOR UPDATE OF kd, ks")) {
        finalSourceLocked = true;
        return [lockedCurrentSource(false)];
      }
      return query.includes("RETURNING id") ? [{ id: "updated" }] : [];
    });
    const repository = new PostgresKnowledgeReviewAutomationRepository(sql);

    const outcome = await repository.complete(resultInput("verify"));

    expect(finalSourceLocked).toBe(true);
    expect(outcome).toMatchObject({
      status: "needs_human",
      decision: "needs_human",
      queuedPhase: null
    });
    expect(
      sql.calls.some((call) =>
        call.query.includes("INSERT INTO background_task")
      )
    ).toBe(false);
  });

  it("binds idempotent replay to the revised content hash", async () => {
    const revisedId = "00000000-0000-4000-8000-000000000009";
    let completed = false;
    let storedReport: Record<string, unknown> | undefined;
    const sql = new RecordingSql((query, parameters) => {
      if (query.includes("FOR UPDATE OF r, kv, kd")) {
        return completed ? [] : [reviewTarget()];
      }
      if (query.includes("FOR UPDATE OF kd, ks")) {
        return [lockedCurrentSource(true)];
      }
      if (query.includes("INSERT INTO knowledge_version")) {
        return [{ id: revisedId }];
      }
      if (
        query.includes("UPDATE knowledge_review_run") &&
        query.includes("status = $2")
      ) {
        completed = true;
        storedReport = JSON.parse(String(parameters?.[3])) as Record<
          string,
          unknown
        >;
        return [{ id: "updated" }];
      }
      if (query.includes("jsonb_set")) {
        const automation = storedReport?.automation as
          Record<string, unknown> | undefined;
        if (automation) automation.queuedPhase = parameters?.[1];
        return [];
      }
      if (query.includes("submittedRevisionHash")) {
        const automation = storedReport?.automation as
          Record<string, unknown> | undefined;
        const submittedReportMatches =
          JSON.stringify(automation?.submittedReport) ===
          JSON.stringify(JSON.parse(String(parameters?.[5])));
        if (
          submittedReportMatches &&
          automation?.submittedRevisionHash === parameters?.[6]
        ) {
          return [
            {
              structured_report: storedReport,
              status: "completed",
              decision: "approved",
              revised_version_id: revisedId,
              input_version_id: resultInput("initial").inputVersionId
            }
          ];
        }
        return [];
      }
      return query.includes("RETURNING id") ? [{ id: "updated" }] : [];
    });
    const repository = new PostgresKnowledgeReviewAutomationRepository(sql);
    const input = {
      ...resultInput("initial"),
      revisedContent: "immutable revised content"
    };

    const first = await repository.complete(input);
    const exactReplay = await repository.complete(input);
    await expect(
      repository.complete({ ...input, revisedContent: "different revision" })
    ).rejects.toMatchObject({
      status: 409,
      code: "KNOWLEDGE_REVIEW_LEASE_INVALID"
    });

    expect(first).toMatchObject({
      currentVersionId: revisedId,
      queuedPhase: "verify",
      idempotent: false
    });
    expect(exactReplay).toMatchObject({
      currentVersionId: revisedId,
      queuedPhase: "verify",
      idempotent: true
    });
    expect(
      (storedReport?.automation as Record<string, unknown>)
        .submittedRevisionHash
    ).toBe(sha256("immutable revised content"));
    expect(JSON.stringify(storedReport)).not.toContain(
      "immutable revised content"
    );
  });
});

type Call = { query: string; parameters?: unknown[] };

class RecordingSql implements KnowledgeReviewSql {
  readonly calls: Call[] = [];

  constructor(
    private readonly response: (
      query: string,
      parameters?: unknown[]
    ) => Array<Record<string, unknown>>
  ) {}

  async unsafe(query: string, parameters?: unknown[]) {
    const normalized = query.trim();
    this.calls.push({ query: normalized, parameters });
    return this.response(normalized, parameters);
  }

  async begin<T>(
    handler: (transaction: KnowledgeReviewSql) => Promise<T>
  ): Promise<T> {
    return handler(this);
  }

  find(fragment: string): Call {
    const call = this.calls.find((entry) => entry.query.includes(fragment));
    if (!call) throw new Error(`Missing SQL call containing ${fragment}`);
    return call;
  }
}

function resultInput(phase: "initial" | "verify") {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    phase,
    leaseTokenHash: "b".repeat(64),
    inputVersionId: "00000000-0000-4000-8000-000000000002",
    inputContentHash: hash,
    report: {
      summary: "ok",
      risk: "low" as const,
      decision: "approved" as const,
      findings: [],
      blockers: [],
      evidence: [],
      numericClaims: []
    }
  };
}

function reviewTarget(input: { sourceId?: string | null } = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    phase: "initial",
    status: "leased",
    input_version_id: "00000000-0000-4000-8000-000000000002",
    input_content_hash: hash,
    model: "gpt-5.5-codex",
    prompt_version: "codex_automation_v1",
    document_id: "00000000-0000-4000-8000-000000000003",
    version: 1,
    content: "original content",
    content_hash: hash,
    citation_metadata: { ingestionMode: "full_text" },
    version_metadata: {},
    version_object_key: "private/knowledge-originals/file.pdf",
    created_by: "owner-1",
    current_version_id: "00000000-0000-4000-8000-000000000002",
    source_id:
      input.sourceId === undefined
        ? "00000000-0000-4000-8000-000000000004"
        : input.sourceId,
    document_status: "review",
    source_tier: "internal",
    source_enabled: true,
    source_deleted_at: null,
    canonical_url: "https://example.com/manual",
    publisher: "Example",
    source_metadata: { commercialAiRightsConfirmed: true },
    original_version_id: "00000000-0000-4000-8000-000000000002"
  };
}

function databaseReviewRun(phase: "initial" | "verify", risk: "low" | "high") {
  return {
    id:
      phase === "initial"
        ? "00000000-0000-4000-8000-000000000011"
        : "00000000-0000-4000-8000-000000000012",
    phase,
    status: "completed",
    input_version_id: "00000000-0000-4000-8000-000000000002",
    input_content_hash: hash,
    model: "gpt-5.5-codex",
    prompt_version: "codex_automation_v1",
    risk,
    structured_report: storedAutomationReport(risk),
    decision: "approved",
    completed_at: new Date()
  };
}

function storedAutomationReport(risk: "low" | "high") {
  const findings = [{ code: "REVIEWED", message: "Evidence checked." }];
  const evidence = [
    {
      claim: "Reviewed claim",
      exactEvidence: "Reviewed source text",
      sourceLocator: "page 1, paragraph 1"
    }
  ];
  return {
    summary: "ok",
    outputContentHash: hash,
    blockers: [],
    numericClaims: [],
    findings,
    evidence,
    automation: {
      idempotencyTokenHash: "b".repeat(64),
      submittedReport: {
        summary: "ok",
        risk,
        decision: "approved",
        findings,
        blockers: [],
        evidence,
        numericClaims: []
      },
      submittedRevisionHash: null,
      actor: "knowledge-review-automation",
      outputVersionId: resultInput("initial").inputVersionId,
      outputContentHash: hash,
      sourceRightsValid: true,
      queuedPhase: null
    }
  };
}

function lockedCurrentSource(enabled: boolean) {
  return {
    document_id: "00000000-0000-4000-8000-000000000003",
    current_version_id: "00000000-0000-4000-8000-000000000002",
    content_hash: hash,
    citation_metadata: { ingestionMode: "full_text" },
    source_id: "00000000-0000-4000-8000-000000000004",
    source_tier: "internal",
    source_enabled: enabled,
    source_deleted_at: null,
    canonical_url: "https://example.com/manual",
    publisher: "Example",
    source_metadata: { commercialAiRightsConfirmed: true }
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
