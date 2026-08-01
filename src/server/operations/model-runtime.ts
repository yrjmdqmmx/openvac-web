import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  dailyUsage,
  modelInvocations,
  promptVersions,
  systemSettings
} from "@/server/db/schema";
import type { ChatMessage, ModelUsage } from "@/server/providers";

export const VACUUM_EXPERT_PROMPT_KEY = "vacuum_expert_system";

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const MICROS_PER_CENT = 10_000;

export interface ActiveRuntimePrompt {
  id: string;
  key: string;
  version: number;
  content: string;
}

export interface ModelPricing {
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
}

export interface ModelBudgetPolicy {
  model: string;
  dailyLimitCents: number;
  monthlyLimitCents: number;
  enabled: boolean;
}

export interface InvocationHandle {
  id: string;
  provider: string;
  model: string;
  startedAt: Date;
  reservedCostMicros: number;
  estimatedInputTokens: number;
  maximumOutputTokens: number;
  pricing: ModelPricing;
}

export interface StartInvocationInput {
  userId: string;
  conversationId: string;
  messageId: string;
  clientRequestId: string;
  provider: string;
  model: string;
  messages: ChatMessage[];
  maximumOutputTokens: number;
  promptVersionId?: string;
  evidenceSourceIds: string[];
  webSearched: boolean;
  now?: Date;
}

export async function loadActiveRuntimePrompt(
  key = VACUUM_EXPERT_PROMPT_KEY
): Promise<ActiveRuntimePrompt | null> {
  const [active] = await db
    .select({
      id: promptVersions.id,
      key: promptVersions.key,
      version: promptVersions.version,
      content: promptVersions.content
    })
    .from(promptVersions)
    .where(
      and(eq(promptVersions.key, key), eq(promptVersions.status, "active"))
    )
    .orderBy(desc(promptVersions.version))
    .limit(1);

  return active ?? null;
}

export async function startModelInvocation(
  input: StartInvocationInput
): Promise<InvocationHandle> {
  const now = input.now ?? new Date();
  const pricing = readModelPricing();
  const estimatedInputTokens = estimateInputTokens(input.messages);
  const reservedCostMicros = calculateModelCostMicros(
    {
      inputTokens: estimatedInputTokens,
      outputTokens: input.maximumOutputTokens
    },
    pricing
  );

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`openvac:model-budget:${input.model}`}))`
    );

    const [setting] = await tx
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, "model_budgets"))
      .limit(1);
    const policy = findModelBudget(setting?.value, input.model);

    if (policy && !policy.enabled) {
      throw new ModelRuntimeError(
        "MODEL_DISABLED",
        `模型 ${input.model} 已在后台停用。`
      );
    }
    if (policy) {
      assertUsablePricing(pricing);
      const windows = beijingUsageWindows(now);
      const [daySpend, monthSpend] = await Promise.all([
        sumReservedModelCost(tx, input.model, windows.dayStart, windows.dayEnd),
        sumReservedModelCost(
          tx,
          input.model,
          windows.monthStart,
          windows.monthEnd
        )
      ]);
      assertWithinModelBudget(policy, daySpend, monthSpend, reservedCostMicros);
    }

    const [created] = await tx
      .insert(modelInvocations)
      .values({
        userId: input.userId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        clientRequestId: input.clientRequestId,
        purpose: "answer",
        provider: input.provider,
        model: input.model,
        status: "running",
        costMicros: reservedCostMicros,
        requestMetadata: {
          promptVersionId: input.promptVersionId ?? null,
          evidenceSourceIds: [...new Set(input.evidenceSourceIds)],
          webSearched: input.webSearched,
          estimatedInputTokens,
          maximumOutputTokens: input.maximumOutputTokens,
          pricing
        },
        responseMetadata: {
          costState: "reserved"
        },
        startedAt: now
      })
      .returning({ id: modelInvocations.id });

    if (!created) {
      throw new ModelRuntimeError(
        "MODEL_INVOCATION_PERSIST_FAILED",
        "无法记录模型调用。"
      );
    }

    return {
      id: created.id,
      provider: input.provider,
      model: input.model,
      startedAt: now,
      reservedCostMicros,
      estimatedInputTokens,
      maximumOutputTokens: input.maximumOutputTokens,
      pricing
    };
  });
}

export async function completeModelInvocation(input: {
  handle: InvocationHandle;
  usage?: ModelUsage;
  providerRequestId?: string;
  finishReason?: string;
  completedAt?: Date;
}) {
  const completedAt = input.completedAt ?? new Date();
  const inputTokens = input.usage?.inputTokens;
  const outputTokens = input.usage?.outputTokens;
  const usageComplete =
    Number.isFinite(inputTokens) && Number.isFinite(outputTokens);
  const costMicros = usageComplete
    ? calculateModelCostMicros(
        { inputTokens: inputTokens!, outputTokens: outputTokens! },
        input.handle.pricing
      )
    : input.handle.reservedCostMicros;
  const usageDate = beijingUsageWindows(completedAt).dayStart;

  await db.transaction(async (tx) => {
    await tx
      .update(modelInvocations)
      .set({
        providerRequestId: input.providerRequestId,
        status: "succeeded",
        inputTokens,
        outputTokens,
        totalTokens: input.usage?.totalTokens,
        costMicros,
        latencyMs: Math.max(
          0,
          completedAt.getTime() - input.handle.startedAt.getTime()
        ),
        responseMetadata: {
          costState: usageComplete ? "actual" : "reserved_estimate",
          finishReason: input.finishReason ?? null,
          usageComplete
        },
        completedAt
      })
      .where(eq(modelInvocations.id, input.handle.id));

    await tx
      .insert(dailyUsage)
      .values({
        date: usageDate,
        provider: input.handle.provider,
        model: input.handle.model,
        requestCount: 1,
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        costCents: Math.ceil(costMicros / MICROS_PER_CENT),
        updatedAt: completedAt
      })
      .onConflictDoUpdate({
        target: [dailyUsage.date, dailyUsage.provider, dailyUsage.model],
        set: {
          requestCount: sql`${dailyUsage.requestCount} + 1`,
          inputTokens: sql`${dailyUsage.inputTokens} + ${inputTokens ?? 0}`,
          outputTokens: sql`${dailyUsage.outputTokens} + ${outputTokens ?? 0}`,
          costCents: sql`${dailyUsage.costCents} + ${Math.ceil(costMicros / MICROS_PER_CENT)}`,
          updatedAt: completedAt
        }
      });
  });
}

export async function failModelInvocation(input: {
  handle: InvocationHandle;
  status?: "failed" | "cancelled";
  errorCode: string;
  errorMessage: string;
  completedAt?: Date;
}) {
  const completedAt = input.completedAt ?? new Date();
  await db
    .update(modelInvocations)
    .set({
      status: input.status ?? "failed",
      costMicros: 0,
      latencyMs: Math.max(
        0,
        completedAt.getTime() - input.handle.startedAt.getTime()
      ),
      responseMetadata: { costState: "released_after_failure" },
      errorCode: input.errorCode,
      errorMessage: input.errorMessage.slice(0, 1000),
      completedAt
    })
    .where(eq(modelInvocations.id, input.handle.id));
}

export function readModelPricing(
  environment: Record<string, string | undefined> = process.env
): ModelPricing {
  return {
    inputMicrosPerMillionTokens: parseNonNegativeNumber(
      environment.MODEL_INPUT_COST_MICROS_PER_MILLION_TOKENS
    ),
    outputMicrosPerMillionTokens: parseNonNegativeNumber(
      environment.MODEL_OUTPUT_COST_MICROS_PER_MILLION_TOKENS
    )
  };
}

export function calculateModelCostMicros(
  usage: Pick<ModelUsage, "inputTokens" | "outputTokens">,
  pricing: ModelPricing
) {
  const inputCost =
    (Math.max(0, usage.inputTokens ?? 0) *
      pricing.inputMicrosPerMillionTokens) /
    1_000_000;
  const outputCost =
    (Math.max(0, usage.outputTokens ?? 0) *
      pricing.outputMicrosPerMillionTokens) /
    1_000_000;
  return Math.ceil(inputCost + outputCost);
}

export function estimateInputTokens(messages: ChatMessage[]) {
  const characters = messages.reduce(
    (total, message) => total + Array.from(message.content).length,
    0
  );
  return Math.max(1, characters + messages.length * 12);
}

export function findModelBudget(
  raw: unknown,
  model: string
): ModelBudgetPolicy | null {
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    if (
      value.model === model &&
      typeof value.dailyLimitCents === "number" &&
      Number.isSafeInteger(value.dailyLimitCents) &&
      value.dailyLimitCents >= 0 &&
      typeof value.monthlyLimitCents === "number" &&
      Number.isSafeInteger(value.monthlyLimitCents) &&
      value.monthlyLimitCents >= 0 &&
      typeof value.enabled === "boolean"
    ) {
      return value as unknown as ModelBudgetPolicy;
    }
  }
  return null;
}

export function assertWithinModelBudget(
  policy: ModelBudgetPolicy,
  daySpendMicros: number,
  monthSpendMicros: number,
  reservedCostMicros: number
) {
  if (!policy.enabled) {
    throw new ModelRuntimeError(
      "MODEL_DISABLED",
      `模型 ${policy.model} 已在后台停用。`
    );
  }
  if (
    daySpendMicros + reservedCostMicros >
    policy.dailyLimitCents * MICROS_PER_CENT
  ) {
    throw new ModelRuntimeError(
      "MODEL_DAILY_BUDGET_EXHAUSTED",
      "模型当日预算已触发熔断。"
    );
  }
  if (
    monthSpendMicros + reservedCostMicros >
    policy.monthlyLimitCents * MICROS_PER_CENT
  ) {
    throw new ModelRuntimeError(
      "MODEL_MONTHLY_BUDGET_EXHAUSTED",
      "模型当月预算已触发熔断。"
    );
  }
}

export function beijingUsageWindows(at: Date) {
  const shifted = new Date(at.getTime() + BEIJING_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const fromBeijingParts = (
    yearValue: number,
    monthValue: number,
    dayValue: number
  ) => new Date(Date.UTC(yearValue, monthValue, dayValue) - BEIJING_OFFSET_MS);

  return {
    dayStart: fromBeijingParts(year, month, day),
    dayEnd: fromBeijingParts(year, month, day + 1),
    monthStart: fromBeijingParts(year, month, 1),
    monthEnd: fromBeijingParts(year, month + 1, 1)
  };
}

async function sumReservedModelCost(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  model: string,
  from: Date,
  to: Date
) {
  const [row] = await tx
    .select({
      value: sql<number>`coalesce(sum(${modelInvocations.costMicros}), 0)`
    })
    .from(modelInvocations)
    .where(
      and(
        eq(modelInvocations.model, model),
        inArray(modelInvocations.status, ["running", "succeeded"]),
        gte(modelInvocations.startedAt, from),
        lt(modelInvocations.startedAt, to)
      )
    );
  return Number(row?.value ?? 0);
}

function assertUsablePricing(pricing: ModelPricing) {
  if (
    pricing.inputMicrosPerMillionTokens <= 0 ||
    pricing.outputMicrosPerMillionTokens <= 0
  ) {
    throw new ModelRuntimeError(
      "MODEL_PRICING_UNCONFIGURED",
      "启用模型预算前必须配置输入和输出 Token 单价。"
    );
  }
}

function parseNonNegativeNumber(value: string | undefined) {
  if (!value?.trim()) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export class ModelRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ModelRuntimeError";
  }
}
