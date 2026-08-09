import { and, count, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/server/db";
import {
  agentRuns,
  knowledgeVersions,
  modelInvocations,
  systemSettings
} from "@/server/db/schema";
import { requireCapability } from "@/server/api/auth";
import {
  ApiError,
  jsonData,
  parseJson,
  withApiErrors
} from "@/server/api/errors";
import { apiStore } from "@/server/api/store";
import {
  createDeepSeekUserPartition,
  getResponsesProvider,
  ProviderError,
  type ResponsesStreamEvent
} from "@/server/providers";
import {
  completeModelInvocation,
  failModelInvocation,
  startModelInvocation
} from "@/server/operations/model-runtime";
import {
  normalizeTrustedHttpsBaseUrl,
  parseCommaSeparated,
  readJsonResponse
} from "@/server/providers/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const checkSchema = z.object({
  check: z.enum(["balance", "responses"]),
  confirmation: z.literal("EXECUTE_EXTERNAL_MODEL_CHECK")
});
const balanceSchema = z.object({
  is_available: z.boolean(),
  balance_infos: z
    .array(
      z.object({
        currency: z.string(),
        total_balance: z.string(),
        granted_balance: z.string().optional(),
        topped_up_balance: z.string().optional()
      })
    )
    .default([])
});

export const GET = withApiErrors(async (request: Request) => {
  await requireCapability(request, apiStore, "metrics:read");
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  const [active, statuses, latency, invocations, pendingKnowledge, budgets] =
    await Promise.all([
      db
        .select({ value: count() })
        .from(agentRuns)
        .where(sql`${agentRuns.status} in ('pending', 'running')`),
      db
        .select({ status: agentRuns.status, value: count() })
        .from(agentRuns)
        .where(gte(agentRuns.createdAt, since))
        .groupBy(agentRuns.status),
      db
        .select({
          p95: sql<
            number | null
          >`percentile_cont(0.95) within group (order by extract(epoch from (${agentRuns.completedAt} - ${agentRuns.startedAt})) * 1000)`
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.status, "completed"),
            gte(agentRuns.createdAt, since)
          )
        ),
      db
        .select({ phase: modelInvocations.phase, value: count() })
        .from(modelInvocations)
        .where(
          and(
            eq(modelInvocations.protocol, "responses"),
            gte(modelInvocations.startedAt, since)
          )
        )
        .groupBy(modelInvocations.phase),
      db
        .select({ value: count() })
        .from(knowledgeVersions)
        .where(eq(knowledgeVersions.status, "review")),
      db
        .select({ value: systemSettings.value })
        .from(systemSettings)
        .where(eq(systemSettings.key, "model_budgets"))
        .limit(1)
    ]);

  let trustedBaseUrl = false;
  try {
    normalizeTrustedHttpsBaseUrl(
      "deepseek-responses",
      process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      parseCommaSeparated(
        process.env.DEEPSEEK_ALLOWED_HOSTS ?? "api.deepseek.com"
      )
    );
    trustedBaseUrl = true;
  } catch {
    trustedBaseUrl = false;
  }

  return jsonData({
    enabled: true,
    environmentMasterSwitch: true,
    model: "deepseek-v4-flash",
    protocol: "responses",
    rollbackPath: "previous-image-digest",
    configuration: {
      apiKeyConfigured: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
      userPartitionSecretConfigured:
        Buffer.byteLength(
          process.env.DEEPSEEK_USER_PARTITION_SECRET ?? "",
          "utf8"
        ) >= 32,
      trustedBaseUrl,
      pricingConfigured: Boolean(
        process.env.MODEL_INPUT_COST_MICROS_PER_MILLION_TOKENS &&
        process.env.MODEL_OUTPUT_COST_MICROS_PER_MILLION_TOKENS &&
        process.env.MODEL_PRICE_VERSION
      ),
      budgetPolicyConfigured: Boolean(budgets[0]?.value)
    },
    metrics24h: {
      activeRuns: Number(active[0]?.value ?? 0),
      statuses: Object.fromEntries(
        statuses.map((row) => [row.status, Number(row.value)])
      ),
      p95LatencyMs: Math.round(Number(latency[0]?.p95 ?? 0)),
      providerInvocations: Object.fromEntries(
        invocations.map((row) => [row.phase, Number(row.value)])
      ),
      pendingKnowledgeReview: Number(pendingKnowledge[0]?.value ?? 0)
    }
  });
});

export const POST = withApiErrors(async (request: Request) => {
  const actor = await requireCapability(request, apiStore, "models:execute");
  const input = await parseJson(request, checkSchema);
  if (input.check === "balance") {
    return jsonData(await checkDeepSeekBalance());
  }

  const provider = getResponsesProvider();
  const startedAt = Date.now();
  const handle = await startModelInvocation({
    userId: actor.id,
    clientRequestId: `admin-responses-check:${crypto.randomUUID()}`,
    provider: provider.id,
    model: provider.model,
    messages: [
      { role: "system", content: "Reply with exactly OK." },
      { role: "user", content: "health check" }
    ],
    maximumOutputTokens: 16,
    evidenceSourceIds: [],
    webSearched: false,
    protocol: "responses",
    phase: "admin_model_check",
    purpose: "evaluation",
    priceVersion: process.env.MODEL_PRICE_VERSION
  });
  let terminal: Extract<ResponsesStreamEvent, { type: "finish" }> | undefined;
  try {
    for await (const event of provider.stream({
      instructions: "Reply with exactly OK.",
      input: "health check",
      toolChoice: "none",
      reasoningEffort: "none",
      maxOutputTokens: 16,
      user: createDeepSeekUserPartition(
        actor.id,
        process.env.DEEPSEEK_USER_PARTITION_SECRET ?? ""
      ),
      signal: AbortSignal.timeout(20_000)
    })) {
      if (event.type === "finish") terminal = event;
    }
    if (!terminal || terminal.status !== "completed") {
      throw new ApiError(
        503,
        "RESPONSES_MODEL_CHECK_FAILED",
        "Responses 模型检查未完成。"
      );
    }
    await completeModelInvocation({
      handle,
      usage: terminal.usage,
      providerRequestId: terminal.providerRequestId,
      finishReason: terminal.status,
      firstEventLatencyMs: terminal.firstEventLatencyMs,
      providerHttpStatus: 200
    });
    return jsonData({
      ok: true,
      protocol: "responses",
      latencyMs: Date.now() - startedAt
    });
  } catch (error) {
    await failModelInvocation({
      handle,
      errorCode: "ADMIN_RESPONSES_CHECK_FAILED",
      errorMessage:
        error instanceof Error ? error.name : "Unknown admin check failure.",
      providerHttpStatus:
        error instanceof ProviderError ? error.status : undefined,
      providerErrorCode:
        error instanceof ProviderError ? error.name : undefined,
      retainReservedEstimate: true
    }).catch(() => undefined);
    if (error instanceof ApiError) throw error;
    if (error instanceof ProviderError && error.status === 401) {
      throw new ApiError(
        503,
        "PROVIDER_AUTHENTICATION_FAILED",
        "DeepSeek 身份验证失败。"
      );
    }
    if (error instanceof ProviderError && error.status === 402) {
      throw new ApiError(
        503,
        "PROVIDER_BILLING_REQUIRED",
        "DeepSeek 余额或计费状态不可用。"
      );
    }
    throw new ApiError(
      503,
      "RESPONSES_MODEL_CHECK_FAILED",
      "Responses 模型检查失败。"
    );
  }
});

async function checkDeepSeekBalance() {
  const baseUrl = normalizeTrustedHttpsBaseUrl(
    "deepseek-balance",
    process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    parseCommaSeparated(
      process.env.DEEPSEEK_ALLOWED_HOSTS ?? "api.deepseek.com"
    )
  );
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new ApiError(
      503,
      "DEEPSEEK_API_KEY_MISSING",
      "DeepSeek 密钥未配置。"
    );
  }
  const response = await fetch(`${baseUrl}/user/balance`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(8_000),
    cache: "no-store"
  });
  if (response.status === 401 || response.status === 402) {
    void response.body?.cancel().catch(() => undefined);
    throw new ApiError(
      503,
      response.status === 401
        ? "PROVIDER_AUTHENTICATION_FAILED"
        : "PROVIDER_BILLING_REQUIRED",
      response.status === 401
        ? "DeepSeek 身份验证失败。"
        : "DeepSeek 余额或计费状态不可用。"
    );
  }
  const parsed = balanceSchema.safeParse(
    await readJsonResponse("deepseek-balance", response)
  );
  if (!parsed.success) {
    throw new ApiError(
      503,
      "DEEPSEEK_BALANCE_RESPONSE_INVALID",
      "DeepSeek 余额响应格式不正确。"
    );
  }
  return {
    available: parsed.data.is_available,
    balances: parsed.data.balance_infos.map((balance) => ({
      currency: balance.currency,
      total: balance.total_balance,
      granted: balance.granted_balance,
      toppedUp: balance.topped_up_balance
    }))
  };
}
