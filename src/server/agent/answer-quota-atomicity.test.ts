import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function between(input: string, start: string, end: string): string {
  const startIndex = input.indexOf(start);
  const endIndex = input.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing start marker: ${start}`).toBeGreaterThanOrEqual(
    0
  );
  expect(endIndex, `missing end marker: ${end}`).toBeGreaterThan(startIndex);
  return input.slice(startIndex, endIndex);
}

describe("Agent V3 quota atomicity contract", () => {
  const http = source("src/server/agent/http-v2.ts");
  const orchestrator = source("src/server/agent/orchestrator.ts");
  const runStore = source("src/server/agent/run-store.ts");
  const quotaRepository = source("src/server/quota/repository.ts");
  const settlement = source("src/server/agent/run-settlement.ts");
  const retention = source("src/server/agent/retention.ts");
  const migration = source("drizzle/0016_groovy_earthquake.sql");

  it.each([
    [
      "initial",
      "export async function postAgentV3",
      "export async function postAgentActionV3"
    ],
    [
      "action",
      "export async function postAgentActionV3",
      "export async function cancelAgentRunV3"
    ]
  ])(
    "validates the DeepSeek partition before committing the %s model attempt",
    (_label, start, end) => {
      const handler = between(http, start, end);
      const partition = handler.indexOf("createDeepSeekUserPartition(");
      const commit = handler.indexOf(
        "const modelAttempt = await commitQuota({"
      );

      expect(partition).toBeGreaterThanOrEqual(0);
      expect(commit).toBeGreaterThan(partition);
      expect(handler.slice(partition, commit)).toContain(
        "settleCreatedRunFailure({"
      );
      expect(handler.slice(partition, commit)).toContain(
        '"partition_configuration_failed"'
      );
      expect(handler.slice(commit)).toContain("settleCreatedRunFailure({");
      expect(handler.slice(commit)).toContain('"model_attempt_commit_failed"');
      expect(handler).toContain(
        "if (!settled) return settlementPendingResponse()"
      );
    }
  );

  it("persists the answer lease when the run is created instead of threading an in-memory lease into completion", () => {
    const streamRun = between(
      http,
      "function streamRun(",
      "function emitOrchestratorEvent("
    );
    const createInitial = between(
      runStore,
      "  async createInitial(input:",
      "  async createAction(input:"
    );
    const createAction = between(
      runStore,
      "  async createAction(input:",
      "  async complete(input:"
    );

    expect(http).toContain("answerQuotaLeaseId: reservations.answer.leaseId");
    expect(createInitial).toContain(
      "answerQuotaLeaseId: input.answerQuotaLeaseId"
    );
    expect(createAction).toContain(
      "answerQuotaLeaseId: input.answerQuotaLeaseId"
    );
    expect(createInitial).toContain('answerQuotaStatus: "reserved"');
    expect(createAction).toContain('answerQuotaStatus: "reserved"');
    expect(streamRun).not.toContain("await commitQuota({");
    expect(streamRun).not.toContain("answerQuotaLeaseId:");
    expect(orchestrator).not.toContain("answerQuotaLeaseId: string;");
  });

  it("settles completed and incomplete answer quota inside the RunStore completion transaction", () => {
    const complete = between(
      runStore,
      "  async complete(input:",
      "  async fail(input:"
    );
    const transaction = complete.indexOf(
      "await db.transaction(async (tx) => {"
    );
    const quotaSettlement = complete.indexOf(
      "await settleAnswerQuotaInTransaction(tx,"
    );
    const runTerminal = complete.indexOf('settlementStatus: "completed"');

    expect(transaction).toBeGreaterThanOrEqual(0);
    expect(quotaSettlement).toBeGreaterThan(transaction);
    expect(runTerminal).toBeGreaterThan(quotaSettlement);
    expect(complete).toContain("leaseId: current.answerQuotaLeaseId");
    expect(complete).toContain('reason: "agent_run_incomplete"');
  });

  it("exposes transaction-scoped commit and release without nested transactions", () => {
    const helper = between(
      quotaRepository,
      "export function commitQuotaInTransaction(",
      "async function transitionQuotaReservation("
    );

    expect(helper).toContain(
      'transitionQuotaReservation(transaction, input, "committed")'
    );
    expect(helper).not.toContain("db.transaction(");
    const releaseHelper = between(
      quotaRepository,
      "export function releaseQuotaInTransaction(",
      "async function transitionQuotaReservation("
    );
    expect(releaseHelper).toContain(
      'transitionQuotaReservation(transaction, input, "released")'
    );
    expect(releaseHelper).not.toContain("db.transaction(");
  });

  it("keeps failed settlement durable and never claims an unconfirmed refund", () => {
    const streamRun = between(
      http,
      "function streamRun(",
      "function emitOrchestratorEvent("
    );
    expect(streamRun).toContain('code: "RUN_SETTLEMENT_PENDING"');
    expect(streamRun).toContain("charged: null");
    expect(streamRun).toContain('settlement: "pending_recovery"');
    expect(streamRun).toContain(
      'settled = settlement.answerQuotaStatus === "released"'
    );
    expect(streamRun).toContain('settlement: "released"');
    expect(streamRun).toContain("charged: false");
    expect(http).toContain("const [answer, modelAttempt]");
    expect(http).toContain('modelAttempt.value.status === "released"');
  });

  it("recovers quota and run-scoped artifacts with idempotent durable jobs", () => {
    expect(settlement).toContain("on conflict (object_key) do nothing");
    expect(settlement).toContain("update chat_storage_account account");
    expect(settlement).toContain("delete from chat_artifact_file file");
    expect(settlement).toContain("update chat_artifact artifact");
    expect(retention).toContain("settleAnswerQuotaInTransaction(tx,");
    expect(retention).toContain("cleanupRunArtifactsInTransaction(tx,");
    expect(retention).toContain("pending += 1");
    expect(retention).toContain('"agent_run_never_persisted"');
    expect(retention).toContain('eq(quotaLedger.resource, "model_attempt")');
    expect(retention).toContain('"model_attempt_never_committed"');
  });

  it("ships additive 0016 lease backfill, recovery indexes, and settlement state", () => {
    expect(migration).toContain('ADD COLUMN "answer_quota_lease_id" uuid');
    expect(migration).toContain('FROM "quota_ledger"');
    expect(migration).toContain("WHERE \"resource\" = 'answer'");
    expect(migration).toContain('"agent_run_answer_quota_lease_unique"');
    expect(migration).toContain('"agent_run_settlement_recovery_idx"');
    expect(migration).not.toMatch(/DROP (TABLE|COLUMN|TYPE)/u);
  });
});
