import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<
    string,
    {
      columns: Record<string, unknown>;
      indexes: Record<string, unknown>;
    }
  >;
  enums: Record<string, { values: string[] }>;
};

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function snapshot(version: number): Snapshot {
  return JSON.parse(
    source(`drizzle/meta/${String(version).padStart(4, "0")}_snapshot.json`)
  ) as Snapshot;
}

describe("append-only migration history", () => {
  it("keeps the already-released 0002 schema and stages later snapshots accurately", () => {
    const versions = [2, 3, 4, 5].map(snapshot);
    const problemReport = (version: Snapshot) =>
      version.tables["public.problem_report"]!;

    expect(source("drizzle/0002_problem_reports.sql")).not.toContain(
      "client_request_id"
    );
    expect(problemReport(versions[0]).columns).not.toHaveProperty(
      "client_request_id"
    );
    expect(problemReport(versions[1]).columns).not.toHaveProperty(
      "client_request_id"
    );
    expect(problemReport(versions[2]).columns).not.toHaveProperty(
      "client_request_id"
    );
    expect(problemReport(versions[2]).indexes).not.toHaveProperty(
      "problem_report_user_client_request_unique"
    );

    expect(problemReport(versions[3]).columns).toHaveProperty(
      "client_request_id"
    );
    expect(problemReport(versions[3]).columns.client_request_id).toMatchObject({
      notNull: true,
      default: "gen_random_uuid()"
    });
    expect(problemReport(versions[3]).indexes).toHaveProperty(
      "problem_report_user_client_request_unique"
    );
    expect(versions[1].tables["public.user"]?.columns).toHaveProperty(
      "deletion_requested_at"
    );
    expect(versions[2].enums["public.quota_resource"]?.values).toEqual([
      "answer",
      "web_search",
      "model_attempt"
    ]);

    for (let index = 1; index < versions.length; index += 1) {
      expect(versions[index]!.prevId).toBe(versions[index - 1]!.id);
    }
  });

  it("backfills only null legacy rows before enforcing idempotency", () => {
    const migration = source("drizzle/0005_sharp_lady_deathstrike.sql");
    const add = migration.indexOf(
      'ADD COLUMN "client_request_id" uuid DEFAULT gen_random_uuid();'
    );
    const backfill = migration.indexOf(
      'SET "client_request_id" = gen_random_uuid()'
    );
    const nullGuard = migration.indexOf('WHERE "client_request_id" IS NULL;');
    const notNull = migration.indexOf(
      'ALTER COLUMN "client_request_id" SET NOT NULL;'
    );
    const unique = migration.indexOf(
      'CREATE UNIQUE INDEX "problem_report_user_client_request_unique"'
    );

    expect(add).toBeGreaterThanOrEqual(0);
    expect(backfill).toBeGreaterThan(add);
    expect(nullGuard).toBeGreaterThan(backfill);
    expect(notNull).toBeGreaterThan(nullGuard);
    expect(unique).toBeGreaterThan(notNull);
    expect(migration).not.toContain("DROP DEFAULT");
    expect(source("drizzle/0003_account_deletion_guard.sql")).toContain(
      'CREATE TRIGGER "audit_log_user_deletion_guard"'
    );
  });
});
