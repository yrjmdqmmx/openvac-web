import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres, { type Sql } from "postgres";
import { describe, expect, it } from "vitest";

const describeDatabase =
  process.env.RUN_DATABASE_TESTS === "true" ? describe : describe.skip;

function migration(path: string) {
  return readFileSync(join(process.cwd(), "drizzle", path), "utf8");
}

async function applyMigration(database: Sql, path: string) {
  const statements = migration(path)
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await database.unsafe(statement);
  }
}

describeDatabase("migration upgrade compatibility", () => {
  it("upgrades an old-0002 database by applying only 0003 through 0005", async () => {
    const configuredUrl = new URL(
      process.env.DATABASE_URL ??
        "postgres://openvac:openvac@127.0.0.1:5432/openvac"
    );
    const databaseName = `openvac_upgrade_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(configuredUrl);
    adminUrl.pathname = "/postgres";
    const targetUrl = new URL(configuredUrl);
    targetUrl.pathname = `/${databaseName}`;
    const admin = postgres(adminUrl.toString(), { max: 1 });
    let target: Sql | undefined;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      target = postgres(targetUrl.toString(), { max: 1 });
      await createPre0002Schema(target);
      const legacyUserId = await seedLegacyConsultations(target);

      await applyMigration(target, "0002_problem_reports.sql");
      const columnsAfter0002 = await target<Array<{ column_name: string }>>`
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'problem_report'
          and column_name = 'client_request_id'
      `;
      expect(columnsAfter0002).toHaveLength(0);

      await applyMigration(target, "0003_account_deletion_guard.sql");
      await applyMigration(target, "0004_famous_daimon_hellstrom.sql");
      await applyMigration(target, "0005_sharp_lady_deathstrike.sql");

      const upgradedRows = await target<
        Array<{ id: string; client_request_id: string }>
      >`
        select id::text, client_request_id::text
        from problem_report
        order by id
      `;
      expect(upgradedRows).toHaveLength(2);
      expect(
        new Set(upgradedRows.map((row) => row.client_request_id)).size
      ).toBe(2);
      expect(
        upgradedRows.every((row) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            row.client_request_id
          )
        )
      ).toBe(true);
      await expect(
        target`
          update problem_report
          set client_request_id = ${upgradedRows[0]!.client_request_id}::uuid
          where id = ${upgradedRows[1]!.id}::uuid
        `
      ).rejects.toMatchObject({ code: "23505" });

      const [oldApplicationInsert] = await target<
        Array<{ id: string; client_request_id: string }>
      >`
        insert into problem_report (
          user_id, category, description, retention_until
        ) values (
          ${legacyUserId}, 'other', 'Legacy application insert',
          now() + interval '180 days'
        )
        returning id::text, client_request_id::text
      `;
      expect(oldApplicationInsert?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(oldApplicationInsert?.client_request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );

      const [column] = await target<Array<{ is_nullable: "YES" | "NO" }>>`
        select is_nullable
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'problem_report'
          and column_name = 'client_request_id'
      `;
      expect(column?.is_nullable).toBe("NO");

      const indexes = await target<Array<{ indexname: string }>>`
        select indexname
        from pg_indexes
        where schemaname = 'public'
          and tablename = 'problem_report'
          and indexname = 'problem_report_user_client_request_unique'
      `;
      expect(indexes).toHaveLength(1);

      const quotaResources = await target<Array<{ value: string }>>`
        select enumlabel as value
        from pg_enum
        join pg_type on pg_type.oid = pg_enum.enumtypid
        where pg_type.typname = 'quota_resource'
        order by pg_enum.enumsortorder
      `;
      expect(quotaResources.map((row) => row.value)).toEqual([
        "answer",
        "web_search",
        "model_attempt"
      ]);

      const userId = `pending-${randomUUID()}`;
      await target`
        insert into "user" (id, updated_at, deletion_requested_at)
        values (${userId}, now(), now())
      `;
      await expect(
        target`
          insert into audit_log (
            id, actor_user_id, actor_role, action, target_type, metadata
          ) values (
            ${randomUUID()}, ${userId}, 'user', 'late.write',
            'problem_report', '{}'::jsonb
          )
        `
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      if (target) {
        await target.end({ timeout: 5 });
      }
      await admin`
        select pg_terminate_backend(pid)
        from pg_stat_activity
        where datname = ${databaseName}
          and pid <> pg_backend_pid()
      `.catch(() => undefined);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end({ timeout: 5 });
    }
  });
});

async function createPre0002Schema(database: Sql) {
  await database.unsafe(`
    CREATE TYPE quota_resource AS ENUM ('answer', 'web_search');

    CREATE TABLE "user" (
      id text PRIMARY KEY,
      updated_at timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE conversation (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL REFERENCES "user"(id)
    );

    CREATE TABLE message (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid()
    );

    CREATE TABLE consultation (
      id uuid CONSTRAINT consultation_pkey PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      conversation_id uuid,
      status text DEFAULT 'submitted' NOT NULL,
      contact_name text NOT NULL,
      company_name text NOT NULL,
      contact_method text NOT NULL,
      contact_value text NOT NULL,
      problem text NOT NULL,
      conversation_summary text NOT NULL,
      context jsonb DEFAULT '{}'::jsonb NOT NULL,
      confirmed_at timestamp with time zone NOT NULL,
      assigned_to text,
      admin_note text,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      resolved_at timestamp with time zone,
      CONSTRAINT consultation_status_valid
        CHECK (status in ('submitted', 'contacting', 'resolved', 'closed')),
      CONSTRAINT consultation_user_id_user_id_fk
        FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
      CONSTRAINT consultation_conversation_id_conversation_id_fk
        FOREIGN KEY (conversation_id) REFERENCES conversation(id)
          ON DELETE SET NULL
    );

    CREATE INDEX consultation_user_created_idx
      ON consultation (user_id, created_at);
    CREATE INDEX consultation_status_created_idx
      ON consultation (status, created_at);

    CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id text,
      actor_role text NOT NULL,
      action text NOT NULL,
      target_type text NOT NULL,
      target_id text,
      request_id text,
      ip_address text,
      user_agent text,
      before jsonb,
      after jsonb,
      metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
}

async function seedLegacyConsultations(database: Sql): Promise<string> {
  const userId = `legacy-${randomUUID()}`;
  await database`insert into "user" (id) values (${userId})`;
  const [{ id: conversationId }] = await database<Array<{ id: string }>>`
    insert into conversation (user_id)
    values (${userId})
    returning id::text
  `;

  for (const suffix of ["one", "two"]) {
    await database`
      insert into consultation (
        user_id, conversation_id, contact_name, company_name,
        contact_method, contact_value, problem, conversation_summary,
        confirmed_at
      ) values (
        ${userId}, ${conversationId}, ${`Legacy ${suffix}`}, 'OpenVac',
        'email', ${`${suffix}@example.com`}, ${`Legacy issue ${suffix}`},
        ${`Legacy summary ${suffix}`}, now()
      )
      `;
  }

  return userId;
}
