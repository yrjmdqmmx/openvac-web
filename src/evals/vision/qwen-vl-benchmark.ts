import { z } from "zod";

export const QWEN_VISION_BENCHMARK_CASE_IDS = [
  "device_identification",
  "nameplate_ocr",
  "gauge_reading",
  "pump_curve",
  "vacuum_schematic",
  "fault_screenshot",
  "table_image",
  "multi_image_comparison"
] as const;

export const QWEN_VISION_COMPLEX_CASE_IDS = [
  "pump_curve",
  "vacuum_schematic"
] as const;

const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export const qwenVisionBenchmarkMeasurementSchema = z
  .object({
    caseId: z.enum(QWEN_VISION_BENCHMARK_CASE_IDS),
    model: z.enum(["qwen3.8-max", "qwen3-vl-plus"]),
    thinking: z.boolean(),
    qualityScore: z.number().int().min(0).max(100),
    passedChecks: z.number().int().nonnegative(),
    totalChecks: z.number().int().positive(),
    firstTokenLatencyMs: z.number().int().nonnegative(),
    totalDurationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    estimatedCostMicrosCny: z.number().int().nonnegative()
  })
  .strict();

export const qwenVisionBenchmarkSchema = z
  .object({
    schemaVersion: z.literal("openvac.qwen-vision-benchmark.v1"),
    gitSha: z.string().regex(SHA),
    imageDigest: z.string().regex(DIGEST),
    generatedAt: z.iso.datetime(),
    environment: z.literal("staging"),
    endpointRegion: z.literal("cn-beijing"),
    protocol: z.literal("openai-chat-completions"),
    imageTransport: z.literal("base64-data-url"),
    defaultModel: z.literal("qwen3.8-max"),
    defaultThinking: z.literal(true),
    thinkingBudgetTokens: z.literal(8192),
    priceVersion: z.literal("aliyun-standard-cn-beijing-2026-08-10"),
    measurements: z
      .array(qwenVisionBenchmarkMeasurementSchema)
      .length(QWEN_VISION_BENCHMARK_CASE_IDS.length * 2 + 2),
    summary: z
      .object({
        currentQualityScore: z.number().int().min(0).max(100),
        baselineQualityScore: z.number().int().min(0).max(100),
        currentMedianFirstTokenLatencyMs: z.number().int().nonnegative(),
        baselineMedianFirstTokenLatencyMs: z.number().int().nonnegative(),
        currentTotalDurationMs: z.number().int().nonnegative(),
        baselineTotalDurationMs: z.number().int().nonnegative(),
        currentTotalTokens: z.number().int().nonnegative(),
        baselineTotalTokens: z.number().int().nonnegative(),
        currentEstimatedCostMicrosCny: z.number().int().nonnegative(),
        baselineEstimatedCostMicrosCny: z.number().int().nonnegative(),
        complexThinkingQualityDelta: z.number().int().min(-100).max(100),
        recommendation: z.enum([
          "retain_thinking",
          "review_reasoning_effort_for_cost"
        ]),
        passed: z.literal(true)
      })
      .strict()
  })
  .strict()
  .superRefine((report, context) => {
    const expected = new Set(QWEN_VISION_BENCHMARK_CASE_IDS);
    const currentIds = report.measurements
      .filter((item) => item.model === "qwen3.8-max" && item.thinking)
      .map((item) => item.caseId);
    if (
      currentIds.length !== expected.size ||
      new Set(currentIds).size !== expected.size ||
      currentIds.some((id) => !expected.has(id))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "qwen3.8-max must contain every thinking visual case exactly once."
      });
    }
    const baselineIds = report.measurements
      .filter((item) => item.model === "qwen3-vl-plus" && !item.thinking)
      .map((item) => item.caseId);
    if (
      baselineIds.length !== expected.size ||
      new Set(baselineIds).size !== expected.size ||
      baselineIds.some((id) => !expected.has(id))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "qwen3-vl-plus must contain every non-thinking visual case exactly once."
      });
    }
    const nonThinkingIds = report.measurements
      .filter((item) => item.model === "qwen3.8-max" && !item.thinking)
      .map((item) => item.caseId)
      .sort();
    if (
      JSON.stringify(nonThinkingIds) !==
      JSON.stringify([...QWEN_VISION_COMPLEX_CASE_IDS].sort())
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Non-thinking comparison must contain the exact complex case set."
      });
    }
  });

export type QwenVisionBenchmark = z.infer<typeof qwenVisionBenchmarkSchema>;
export type QwenVisionBenchmarkMeasurement = z.infer<
  typeof qwenVisionBenchmarkMeasurementSchema
>;
