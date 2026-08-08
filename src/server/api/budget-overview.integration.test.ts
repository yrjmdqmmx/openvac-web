import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, sqlClient } from "@/server/db";
import { dailyUsage, systemSettings } from "@/server/db/schema";

import { apiStore } from "./store";

const describeDatabase =
  process.env.RUN_DATABASE_TESTS === "true" ? describe : describe.skip;

describeDatabase("budget overview database query", () => {
  const model = `budget-date-${randomUUID()}`;
  const settingKey = "model_budgets";
  let originalSetting: unknown;
  let hadOriginalSetting = false;
  let createdMinimalTables = false;

  beforeAll(async () => {
    const [tables] = await sqlClient<
      Array<{ daily_usage: string | null; system_setting: string | null }>
    >`
      select
        to_regclass('public.daily_usage')::text as daily_usage,
        to_regclass('public.system_setting')::text as system_setting
    `;
    if (!tables?.daily_usage && !tables?.system_setting) {
      createdMinimalTables = true;
      await sqlClient.unsafe(`
        create table system_setting (
          key text primary key,
          value jsonb not null,
          description text,
          is_secret boolean not null default false,
          updated_by text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        );
        create table daily_usage (
          id uuid primary key,
          date timestamptz not null,
          provider text not null,
          model text not null,
          request_count integer not null default 0,
          input_tokens integer not null default 0,
          output_tokens integer not null default 0,
          cost_cents integer not null default 0,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique (date, provider, model)
        );
      `);
    } else if (!tables.daily_usage || !tables.system_setting) {
      throw new Error(
        "Budget integration test requires both daily_usage and system_setting."
      );
    }

    const [existing] = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, settingKey))
      .limit(1);
    hadOriginalSetting = Boolean(existing);
    originalSetting = existing?.value;

    await db
      .insert(systemSettings)
      .values({
        key: settingKey,
        value: [
          {
            model,
            dailyLimitCents: 1_000,
            monthlyLimitCents: 20_000,
            enabled: true
          }
        ],
        description: "Budget integration test"
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: [
            {
              model,
              dailyLimitCents: 1_000,
              monthlyLimitCents: 20_000,
              enabled: true
            }
          ]
        }
      });

    await db.insert(dailyUsage).values({
      id: randomUUID(),
      date: new Date("2026-08-08T06:00:00.000Z"),
      provider: "integration-test",
      model,
      requestCount: 1,
      inputTokens: 10,
      outputTokens: 5,
      costCents: 37
    });
  });

  afterAll(async () => {
    try {
      await db.delete(dailyUsage).where(eq(dailyUsage.model, model));
      if (hadOriginalSetting) {
        await db
          .update(systemSettings)
          .set({ value: originalSetting })
          .where(eq(systemSettings.key, settingKey));
      } else {
        await db
          .delete(systemSettings)
          .where(eq(systemSettings.key, settingKey));
      }
    } finally {
      if (createdMinimalTables) {
        await sqlClient.unsafe(
          "drop table if exists daily_usage; drop table if exists system_setting;"
        );
      }
    }
  });

  it("serializes both UTC usage-window boundaries for the postgres driver", async () => {
    await expect(
      apiStore.getBudgetOverview(new Date("2026-08-08T09:00:00.000Z"))
    ).resolves.toEqual([
      expect.objectContaining({
        model,
        dailyUsedCents: 37,
        monthlyUsedCents: 37,
        circuitStatus: "ok"
      })
    ]);
  });
});
