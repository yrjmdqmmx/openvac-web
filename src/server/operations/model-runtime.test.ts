import { describe, expect, it } from "vitest";

import {
  assertWithinModelBudget,
  beijingUsageWindows,
  calculateModelCostMicros,
  estimateInputTokens,
  findModelBudget,
  ModelRuntimeError,
  readModelPricing
} from "./model-runtime";

describe("model runtime accounting", () => {
  it("uses Beijing calendar boundaries", () => {
    const windows = beijingUsageWindows(
      new Date("2026-08-01T00:15:00.000+08:00")
    );

    expect(windows.dayStart.toISOString()).toBe("2026-07-31T16:00:00.000Z");
    expect(windows.dayEnd.toISOString()).toBe("2026-08-01T16:00:00.000Z");
    expect(windows.monthStart.toISOString()).toBe("2026-07-31T16:00:00.000Z");
    expect(windows.monthEnd.toISOString()).toBe("2026-08-31T16:00:00.000Z");
  });

  it("calculates micro-currency cost without rounding down", () => {
    expect(
      calculateModelCostMicros(
        { inputTokens: 500_000, outputTokens: 250_000 },
        {
          inputMicrosPerMillionTokens: 2_000_000,
          outputMicrosPerMillionTokens: 8_000_000
        }
      )
    ).toBe(3_000_000);
  });

  it("conservatively estimates multilingual prompt tokens", () => {
    expect(
      estimateInputTokens([
        { role: "system", content: "真空安全" },
        { role: "user", content: "pump" }
      ])
    ).toBeGreaterThanOrEqual(30);
  });

  it("only accepts a complete exact-model budget", () => {
    const budget = findModelBudget(
      [
        {
          model: "other",
          dailyLimitCents: 1,
          monthlyLimitCents: 2,
          enabled: true
        },
        {
          model: "deepseek-v4-flash",
          dailyLimitCents: 100,
          monthlyLimitCents: 2_000,
          enabled: true
        }
      ],
      "deepseek-v4-flash"
    );

    expect(budget).toEqual({
      model: "deepseek-v4-flash",
      dailyLimitCents: 100,
      monthlyLimitCents: 2_000,
      enabled: true
    });
    expect(
      findModelBudget(
        [
          {
            model: "deepseek-v4-flash",
            dailyLimitCents: "100",
            monthlyLimitCents: 2_000,
            enabled: true
          }
        ],
        "deepseek-v4-flash"
      )
    ).toBeNull();
  });

  it("blocks disabled, daily-exhausted and monthly-exhausted models", () => {
    expectRuntimeCode(
      () =>
        assertWithinModelBudget(
          {
            model: "deepseek-v4-flash",
            dailyLimitCents: 100,
            monthlyLimitCents: 1_000,
            enabled: false
          },
          0,
          0,
          1
        ),
      "MODEL_DISABLED"
    );

    expectRuntimeCode(
      () =>
        assertWithinModelBudget(
          {
            model: "deepseek-v4-flash",
            dailyLimitCents: 100,
            monthlyLimitCents: 1_000,
            enabled: true
          },
          999_999,
          999_999,
          2
        ),
      "MODEL_DAILY_BUDGET_EXHAUSTED"
    );

    expectRuntimeCode(
      () =>
        assertWithinModelBudget(
          {
            model: "deepseek-v4-flash",
            dailyLimitCents: 1_000,
            monthlyLimitCents: 100,
            enabled: true
          },
          0,
          999_999,
          2
        ),
      "MODEL_MONTHLY_BUDGET_EXHAUSTED"
    );
  });

  it("reads non-negative pricing and rejects malformed values to zero", () => {
    expect(
      readModelPricing({
        MODEL_INPUT_COST_MICROS_PER_MILLION_TOKENS: "2000000",
        MODEL_OUTPUT_COST_MICROS_PER_MILLION_TOKENS: "-1"
      })
    ).toEqual({
      inputMicrosPerMillionTokens: 2_000_000,
      outputMicrosPerMillionTokens: 0
    });
  });
});

function expectRuntimeCode(run: () => void, code: string) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ModelRuntimeError);
  expect((caught as ModelRuntimeError).code).toBe(code);
}
