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
  it("upgrades a pre-0002 database through permanent modeling purge 0009", async () => {
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
      await applyMigration(target, "0006_sour_roulette.sql");
      await applyMigration(target, "0007_consultation_rollback_compat.sql");
      await applyMigration(target, "0008_agent_v2_responses.sql");
      const legacyMessageId = randomUUID();
      await target`
        insert into message (id, metadata)
        values (
          ${legacyMessageId},
          ${target.json({
            modelingCards: [{ projectId: "legacy-project" }],
            retained: "keep-me"
          })}
        )
      `;
      await applyMigration(target, "0009_modeling_permanent_purge.sql");

      const agentV2Tables = await target<Array<{ table_name: string }>>`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'conversation_turn', 'agent_run', 'agent_tool_call',
            'conversation_memory', 'user_memory', 'web_domain_policy'
          )
        order by table_name
      `;
      expect(agentV2Tables.map((row) => row.table_name)).toEqual([
        "agent_run",
        "agent_tool_call",
        "conversation_memory",
        "conversation_turn",
        "user_memory",
        "web_domain_policy"
      ]);

      const messageStatuses = await target<Array<{ value: string }>>`
        select enumlabel as value
        from pg_enum
        join pg_type on pg_type.oid = pg_enum.enumtypid
        join pg_namespace on pg_namespace.oid = pg_type.typnamespace
        where pg_namespace.nspname = 'public'
          and pg_type.typname = 'message_status'
        order by pg_enum.enumsortorder
      `;
      expect(messageStatuses.map((row) => row.value)).toEqual([
        "pending",
        "streaming",
        "completed",
        "incomplete",
        "failed",
        "cancelled"
      ]);

      const expandedColumns = await target<
        Array<{ table_name: string; column_name: string }>
      >`
        select table_name, column_name
        from information_schema.columns
        where table_schema = 'public'
          and (
            (table_name = 'citation' and column_name in (
              'trust_tier', 'review_status'
            ))
            or (table_name = 'message' and column_name in (
              'turn_id', 'answer_schema_version', 'answer_payload'
            ))
            or (table_name = 'model_invocation' and column_name in (
              'agent_run_id', 'protocol', 'phase', 'attempt', 'retry_of_id',
              'cache_hit_input_tokens', 'cache_miss_input_tokens',
              'reasoning_tokens', 'first_event_latency_ms',
              'provider_http_status', 'provider_error_code', 'price_version'
            ))
          )
        order by table_name, column_name
      `;
      expect(expandedColumns).toHaveLength(17);

      const modelingTables = await target<Array<{ table_name: string }>>`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name like 'modeling_%'
        order by table_name
      `;
      expect(modelingTables).toEqual([]);

      const modelingEnums = await target<Array<{ type_name: string }>>`
        select pg_type.typname as type_name
        from pg_type
        join pg_namespace on pg_namespace.oid = pg_type.typnamespace
        where pg_namespace.nspname = 'public'
          and pg_type.typname like 'modeling_%'
        order by pg_type.typname
      `;
      expect(modelingEnums).toEqual([]);

      const [cleanedMessage] = await target<
        Array<{ metadata: Record<string, unknown> }>
      >`
        select metadata
        from message
        where id = ${legacyMessageId}
      `;
      expect(cleanedMessage?.metadata).toEqual({ retained: "keep-me" });

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

      await verifyConsultationRollbackCompatibility(target, legacyUserId);

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

      await target`drop view consultation`;
      await target`create table consultation (id integer primary key)`;
      await expect(
        applyMigration(target, "0007_consultation_rollback_compat.sql")
      ).rejects.toThrow(/refusing to replace existing public\.consultation/u);
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

async function verifyConsultationRollbackCompatibility(
  database: Sql,
  legacyUserId: string
) {
  const relations = await database<
    Array<{ relname: string; relkind: string; reloptions: string[] }>
  >`
    select
      relation.relname,
      relation.relkind,
      coalesce(relation.reloptions, array[]::text[]) as reloptions
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in ('consultation', 'problem_report')
    order by relation.relname
  `;
  expect(relations).toEqual([
    {
      relname: "consultation",
      relkind: "v",
      reloptions: expect.arrayContaining(["security_invoker=true"])
    },
    { relname: "problem_report", relkind: "r", reloptions: [] }
  ]);

  // These are the exact columns and predicates used by the old user list.
  const legacyUserList = await database<
    Array<{
      id: string;
      conversation_id: string | null;
      company_name: string;
      problem: string;
      status: string;
      created_at: Date;
      updated_at: Date;
    }>
  >`
    select
      id::text,
      conversation_id::text,
      company_name,
      problem,
      status,
      created_at,
      updated_at
    from consultation
    where user_id = ${legacyUserId}
      and status = 'submitted'
    order by created_at desc
    limit 20 offset 0
  `;
  expect(legacyUserList).toHaveLength(3);
  expect(legacyUserList.every((row) => row.company_name === "")).toBe(true);
  expect(legacyUserList.map((row) => row.problem).sort()).toEqual([
    "Legacy application insert",
    "Legacy issue one",
    "Legacy issue two"
  ]);
  const legacyConversationId = legacyUserList.find(
    (row) => row.conversation_id !== null
  )?.conversation_id;
  if (!legacyConversationId) {
    throw new Error("legacy migration fixture did not retain a conversation");
  }

  const [{ value: legacyUserCount }] = await database<Array<{ value: number }>>`
    select count(*)::integer as value
    from consultation
    where user_id = ${legacyUserId}
      and status = 'submitted'
  `;
  expect(legacyUserCount).toBe(3);

  // The old admin list performs SELECT * and searches company_name OR problem.
  const oldAdminList = await database<
    Array<{
      id: string;
      contact_name: string;
      company_name: string;
      problem: string;
      status: string;
    }>
  >`
    select *
    from consultation
    where company_name ilike ${"%Legacy issue%"}
      or problem ilike ${"%Legacy issue%"}
    order by created_at desc
    limit 20 offset 0
  `;
  expect(oldAdminList).toHaveLength(2);
  expect(
    oldAdminList.every(
      (row) => row.contact_name === "" && row.company_name === ""
    )
  ).toBe(true);

  const currentInsertVisibleToRollback = await database<
    Array<{ status: string }>
  >`
    select status
    from consultation
    where problem = 'Legacy application insert'
  `;
  expect(currentInsertVisibleToRollback).toEqual([{ status: "submitted" }]);

  const consultationId = randomUUID();
  const assignedUserId = `compat-admin-${randomUUID()}`;
  const contactName = "Rollback Secret Contact";
  const companyName = "Rollback Secret Company";
  const contactValue = "rollback-secret@example.com";
  const conversationSummary = "Rollback compatibility summary";
  const longProblem = `Rollback compatibility ${"x".repeat(4_900)}`;
  const createdAt = new Date("2026-08-01T06:00:00.000Z");
  await database`insert into "user" (id) values (${assignedUserId})`;

  // This mirrors origin/main createConsultation, including its RETURNING list.
  const [created] = await database<
    Array<{ id: string; status: string; created_at: Date }>
  >`
    insert into consultation (
      id,
      user_id,
      conversation_id,
      contact_name,
      company_name,
      contact_method,
      contact_value,
      problem,
      conversation_summary,
      confirmed_at,
      status,
      created_at,
      updated_at
    ) values (
      ${consultationId},
      ${legacyUserId},
      ${legacyConversationId},
      ${contactName},
      ${companyName},
      'email',
      ${contactValue},
      ${longProblem},
      ${conversationSummary},
      ${createdAt},
      'submitted',
      ${createdAt},
      ${createdAt}
    )
    returning id::text, status, created_at
  `;
  expect(created).toMatchObject({
    id: consultationId,
    status: "submitted",
    created_at: createdAt
  });

  const [canonical] = await database<
    Array<{
      category: string;
      description_length: number;
      summary: string;
      legacy_description: string;
      context_text: string;
      contact_type: string;
      contact_value: string;
      consent_to_contact: boolean;
      include_context: boolean;
      status: string;
      client_request_id: string;
      retention_seconds: number;
    }>
  >`
    select
      category,
      char_length(description)::integer as description_length,
      context ->> 'summary' as summary,
      context ->> 'legacyDescription' as legacy_description,
      context::text as context_text,
      contact_type,
      contact_value,
      consent_to_contact,
      include_context,
      status,
      client_request_id::text,
      extract(epoch from (retention_until - created_at))::integer
        as retention_seconds
    from problem_report
    where id = ${consultationId}
  `;
  expect(canonical).toMatchObject({
    category: "other",
    description_length: 3_000,
    summary: conversationSummary,
    legacy_description: longProblem,
    contact_type: "email",
    contact_value: contactValue,
    consent_to_contact: true,
    include_context: true,
    status: "new",
    retention_seconds: 180 * 24 * 60 * 60
  });
  expect(canonical?.client_request_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
  );
  expect(canonical?.context_text).not.toContain(contactName);
  expect(canonical?.context_text).not.toContain(companyName);
  expect(canonical?.context_text).not.toContain(contactValue);

  const [legacyCreatedView] = await database<
    Array<{
      contact_name: string;
      company_name: string;
      contact_method: string;
      contact_value: string;
      problem: string;
      conversation_summary: string;
      assigned_to: string | null;
      status: string;
    }>
  >`
    select
      contact_name,
      company_name,
      contact_method,
      contact_value,
      problem,
      conversation_summary,
      assigned_to,
      status
    from consultation
    where id = ${consultationId}
  `;
  expect(legacyCreatedView).toEqual({
    contact_name: "",
    company_name: "",
    contact_method: "email",
    contact_value: contactValue,
    problem: longProblem,
    conversation_summary: conversationSummary,
    assigned_to: null,
    status: "submitted"
  });

  const resolvedAt = new Date("2026-08-02T06:00:00.000Z");
  // This mirrors origin/main setConsultationStatus, including RETURNING *.
  const [resolved] = await database<
    Array<{
      status: string;
      assigned_to: string | null;
      admin_note: string | null;
      resolved_at: Date | null;
    }>
  >`
    update consultation
    set
      status = 'resolved',
      assigned_to = ${assignedUserId},
      admin_note = 'legacy resolution',
      resolved_at = ${resolvedAt},
      updated_at = ${resolvedAt}
    where id = ${consultationId}
    returning *
  `;
  expect(resolved).toMatchObject({
    status: "resolved",
    assigned_to: null,
    admin_note: "legacy resolution",
    resolved_at: resolvedAt
  });

  const [resolvedCanonical] = await database<
    Array<{
      status: string;
      compatibility_status: string;
      closed_at: Date;
      purge_seconds: number;
    }>
  >`
    select
      status,
      context ->> '_openvacConsultationStatus' as compatibility_status,
      closed_at,
      extract(epoch from (contact_purge_at - closed_at))::integer
        as purge_seconds
    from problem_report
    where id = ${consultationId}
  `;
  expect(resolvedCanonical).toEqual({
    status: "closed",
    compatibility_status: "resolved",
    closed_at: resolvedAt,
    purge_seconds: 30 * 24 * 60 * 60
  });
  const resolvedList = await database<Array<{ id: string }>>`
    select id::text
    from consultation
    where status = 'resolved'
      and id = ${consultationId}
  `;
  expect(resolvedList).toEqual([{ id: consultationId }]);

  // Repeating a legacy close must not postpone the PII purge window. Legacy
  // clients commonly retry status writes with a fresh resolved_at value.
  const repeatedCloseAt = new Date("2026-08-03T05:00:00.000Z");
  const [repeatedClose] = await database<
    Array<{ status: string; resolved_at: Date }>
  >`
    update consultation
    set
      status = 'closed',
      admin_note = 'legacy close retry',
      resolved_at = ${repeatedCloseAt},
      updated_at = ${repeatedCloseAt}
    where id = ${consultationId}
    returning status, resolved_at
  `;
  expect(repeatedClose).toEqual({
    status: "closed",
    resolved_at: resolvedAt
  });
  const [repeatedCloseCanonical] = await database<
    Array<{
      closed_at: Date;
      contact_purge_at: Date;
    }>
  >`
    select closed_at, contact_purge_at
    from problem_report
    where id = ${consultationId}
  `;
  expect(repeatedCloseCanonical).toEqual({
    closed_at: resolvedAt,
    contact_purge_at: new Date(resolvedAt.getTime() + 30 * 24 * 60 * 60 * 1000)
  });

  // Repair pre-fix rows that were already closed without a purge deadline,
  // without allowing the retry's later resolved_at to extend retention.
  await database`
    update problem_report
    set contact_purge_at = null
    where id = ${consultationId}
  `;
  const repairAttemptAt = new Date("2026-08-03T05:30:00.000Z");
  await database`
    update consultation
    set
      status = 'resolved',
      resolved_at = ${repairAttemptAt},
      updated_at = ${repairAttemptAt}
    where id = ${consultationId}
  `;
  const [repairedCloseCanonical] = await database<
    Array<{ closed_at: Date; contact_purge_at: Date }>
  >`
    select closed_at, contact_purge_at
    from problem_report
    where id = ${consultationId}
  `;
  expect(repairedCloseCanonical).toEqual({
    closed_at: resolvedAt,
    contact_purge_at: new Date(resolvedAt.getTime() + 30 * 24 * 60 * 60 * 1000)
  });

  // A current-app status write normalizes any stale rollback-only marker.
  const currentClosedAt = new Date("2026-08-03T06:00:00.000Z");
  await database`
    update problem_report
    set status = 'closed', updated_at = ${currentClosedAt}
    where id = ${consultationId}
  `;
  const [normalizedCurrentStatus] = await database<Array<{ status: string }>>`
    select status from consultation where id = ${consultationId}
  `;
  expect(normalizedCurrentStatus?.status).toBe("closed");

  const reopenedAt = new Date("2026-08-04T06:00:00.000Z");
  const [reopened] = await database<
    Array<{ status: string; resolved_at: Date | null }>
  >`
    update consultation
    set
      status = 'contacting',
      assigned_to = null,
      admin_note = null,
      resolved_at = null,
      updated_at = ${reopenedAt}
    where id = ${consultationId}
    returning *
  `;
  expect(reopened).toMatchObject({ status: "contacting", resolved_at: null });
  const [reopenedCanonical] = await database<
    Array<{
      status: string;
      compatibility_status: string;
      closed_at: Date | null;
      contact_purge_at: Date | null;
    }>
  >`
    select
      status,
      context ->> '_openvacConsultationStatus' as compatibility_status,
      closed_at,
      contact_purge_at
    from problem_report
    where id = ${consultationId}
  `;
  expect(reopenedCanonical).toEqual({
    status: "reviewing",
    compatibility_status: "contacting",
    closed_at: null,
    contact_purge_at: null
  });

  const reclosedAt = new Date("2026-08-05T06:00:00.000Z");
  const [reclosed] = await database<
    Array<{ status: string; resolved_at: Date }>
  >`
    update consultation
    set
      status = 'closed',
      assigned_to = null,
      admin_note = 'closed again',
      resolved_at = ${reclosedAt},
      updated_at = ${reclosedAt}
    where id = ${consultationId}
    returning *
  `;
  expect(reclosed).toMatchObject({ status: "closed", resolved_at: reclosedAt });
  const [reclosedCanonical] = await database<
    Array<{ closed_at: Date; purge_seconds: number }>
  >`
    select
      closed_at,
      extract(epoch from (contact_purge_at - closed_at))::integer
        as purge_seconds
    from problem_report
    where id = ${consultationId}
  `;
  expect(reclosedCanonical).toEqual({
    closed_at: reclosedAt,
    purge_seconds: 30 * 24 * 60 * 60
  });

  await database`
    update problem_report
    set contact_type = null, contact_value = null
    where id = ${consultationId}
  `;
  const [purgedView] = await database<
    Array<{
      contact_name: string;
      company_name: string;
      contact_method: string;
      contact_value: string;
      context_text: string;
    }>
  >`
    select
      contact_name,
      company_name,
      contact_method,
      contact_value,
      context::text as context_text
    from consultation
    where id = ${consultationId}
  `;
  expect(purgedView).toMatchObject({
    contact_name: "",
    company_name: "",
    contact_method: "",
    contact_value: ""
  });
  expect(purgedView?.context_text).not.toContain(contactName);
  expect(purgedView?.context_text).not.toContain(companyName);
  expect(purgedView?.context_text).not.toContain(contactValue);
}

async function createPre0002Schema(database: Sql) {
  await database.unsafe(`
    CREATE TYPE quota_resource AS ENUM ('answer', 'web_search');
    CREATE TYPE message_status AS ENUM (
      'pending', 'streaming', 'completed', 'failed', 'cancelled'
    );

    CREATE TABLE "user" (
      id text PRIMARY KEY,
      updated_at timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE conversation (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL REFERENCES "user"(id)
    );

    CREATE TABLE message (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status message_status DEFAULT 'pending' NOT NULL,
      metadata jsonb DEFAULT '{}'::jsonb NOT NULL
    );

    CREATE TABLE citation (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid()
    );

    CREATE TABLE model_invocation (
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
