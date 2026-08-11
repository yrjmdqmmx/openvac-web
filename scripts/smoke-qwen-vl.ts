import { randomInt } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  QWEN_VISION_BENCHMARK_CASE_IDS,
  QWEN_VISION_COMPLEX_CASE_IDS,
  qwenVisionBenchmarkSchema,
  type QwenVisionBenchmarkMeasurement
} from "../src/evals/vision/qwen-vl-benchmark";
import {
  ProviderTimeoutError,
  QwenVlProvider,
  type QwenVlTelemetryResult,
  type VisionImage,
  type VisionRequest,
  type VisionResult
} from "../src/server/providers";
import {
  classifyQwenVlSmokeFailure,
  createQwenVlSmokeRetryBudget,
  publicQwenVlSmokeFailure,
  qwenVlSmokeRecordedDurationMs,
  QwenVlSmokeFailure,
  recognizesVisualNonce,
  withOneQwenVlControlledFixtureRetry
} from "./smoke-qwen-vl-boundary";
import { renderVisualFixture, renderVisualNonce } from "./qwen-vl-fixtures";

type BenchmarkCase = {
  id: (typeof QWEN_VISION_BENCHMARK_CASE_IDS)[number];
  prompt: string;
  images: VisionImage[];
  expected: Record<string, string | number>;
};

const CURRENT_MODEL = "qwen3.8-max";
const BASELINE_MODEL = "qwen3-vl-plus";
let activeBenchmarkCase:
  | {
      caseId: (typeof QWEN_VISION_BENCHMARK_CASE_IDS)[number];
      model: typeof CURRENT_MODEL | typeof BASELINE_MODEL;
      thinking: boolean;
    }
  | undefined;
const controlledFixtureRetryBudget = createQwenVlSmokeRetryBudget();

async function main(): Promise<void> {
  const mode = process.env.QWEN_VL_SMOKE_MODE?.trim() || "contract";
  if (mode === "contract") {
    await contractSmoke();
    return;
  }
  if (mode !== "benchmark") {
    throw new Error("QWEN_VL_SMOKE_MODE is invalid.");
  }
  await benchmarkSmoke();
}

async function contractSmoke(): Promise<void> {
  const provider = new QwenVlProvider({
    model: CURRENT_MODEL,
    enableThinking: true,
    highResolutionImages: false
  });
  if (provider.model !== CURRENT_MODEL) {
    throw new QwenVlSmokeFailure("CONFIG_MISSING");
  }
  const outcomes: Array<Record<string, string | number | boolean>> = [];
  const measurements: QwenVisionBenchmarkMeasurement[] = [];
  const visualNonce = String(randomInt(10_000_000, 100_000_000));
  const image = await renderVisualNonce(visualNonce);
  const nonceProbes = [
    {
      probeId: "current_thinking_default",
      provider,
      thinking: true,
      highResolution: false,
      transport: "non_streaming",
      required: true
    },
    {
      probeId: "current_thinking_high_resolution",
      provider: new QwenVlProvider({
        model: CURRENT_MODEL,
        enableThinking: true,
        highResolutionImages: true
      }),
      thinking: true,
      highResolution: true,
      transport: "streaming",
      required: false
    },
    {
      probeId: "current_non_thinking_default",
      provider: new QwenVlProvider({
        model: CURRENT_MODEL,
        enableThinking: false,
        highResolutionImages: false
      }),
      thinking: false,
      highResolution: false,
      transport: "streaming",
      required: false
    },
    {
      probeId: "baseline_non_thinking_default",
      provider: new QwenVlProvider({
        model: BASELINE_MODEL,
        enableThinking: false,
        highResolutionImages: false
      }),
      thinking: false,
      highResolution: false,
      transport: "streaming",
      required: false
    }
  ] as const;
  for (const probe of nonceProbes) {
    outcomes.push(
      await measureVisualNonce(
        probe.provider,
        image,
        visualNonce,
        probe.probeId,
        probe.thinking,
        probe.highResolution,
        probe.transport,
        probe.required
      )
    );
  }
  const noncePassed = outcomes.some(
    (outcome) =>
      outcome.probeId === "current_thinking_default" && outcome.passed
  );

  for (const testCase of await benchmarkCases()) {
    try {
      const measurement = await measure(provider, testCase, true);
      measurements.push(measurement);
      outcomes.push({
        ...measurement,
        required: true,
        passed: measurement.qualityScore >= 75
      });
    } catch (error) {
      outcomes.push({
        caseId: testCase.id,
        model: provider.model,
        thinking: true,
        required: true,
        passed: false,
        code: classifyQwenVlSmokeFailure(error).code
      });
    } finally {
      activeBenchmarkCase = undefined;
    }
  }

  const currentQualityScore =
    measurements.length === QWEN_VISION_BENCHMARK_CASE_IDS.length
      ? average(measurements.map((item) => item.qualityScore))
      : 0;
  const passed =
    noncePassed &&
    outcomes
      .filter((outcome) => outcome.required)
      .every((outcome) => outcome.passed) &&
    currentQualityScore >= 85;
  console.log(
    JSON.stringify({
      schemaVersion: "openvac.qwen-vl-preflight.v1",
      model: provider.model,
      protocol: provider.capabilities.protocol,
      thinking: true,
      thinkingBudgetTokens: provider.thinkingBudgetTokens,
      currentQualityScore,
      passed,
      outcomes
    })
  );
  if (!passed) {
    throw new QwenVlSmokeFailure(
      "RESPONSE_INVALID",
      noncePassed ? "VISUAL_PREFLIGHT_FAILED" : "VISUAL_NONCE_MISMATCH"
    );
  }
}

async function measureVisualNonce(
  provider: QwenVlProvider,
  image: Buffer,
  visualNonce: string,
  probeId: string,
  thinking: boolean,
  highResolution: boolean,
  transport: "non_streaming" | "streaming",
  required: boolean
): Promise<Record<string, string | number | boolean>> {
  try {
    const request: VisionRequest = {
      prompt: "读取图片中清晰显示的8位校验数字。只输出数字。",
      images: [{ mimeType: "image/png", bytes: new Uint8Array(image) }],
      maxOutputTokens: 128
    };
    const result =
      transport === "non_streaming"
        ? (
            await withOneQwenVlControlledFixtureRetry({
              caseId: "visual_nonce",
              budget: controlledFixtureRetryBudget,
              request,
              execute: (stableRequest) =>
                analyzeAttempt(provider, stableRequest),
              onRetry: (event) => console.warn(JSON.stringify(event))
            })
          ).result
        : await telemetryAttempt(provider, request);
    const usage = requireUsage(result);
    const passed = recognizesVisualNonce(result.text, visualNonce);
    return {
      caseId: "visual_nonce",
      probeId,
      model: provider.model,
      thinking,
      highResolution,
      transport,
      required,
      passed,
      ...(transport === "streaming"
        ? {
            firstTokenLatencyMs: (result as QwenVlTelemetryResult)
              .firstTokenLatencyMs,
            totalDurationMs: (result as QwenVlTelemetryResult).totalDurationMs
          }
        : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      estimatedCostMicrosCny: estimatedCostMicrosCny(
        provider.model,
        usage.inputTokens,
        usage.outputTokens
      ),
      ...(!passed ? { code: "RESPONSE_INVALID" } : {})
    };
  } catch (error) {
    return {
      caseId: "visual_nonce",
      probeId,
      model: provider.model,
      thinking,
      highResolution,
      transport,
      required,
      passed: false,
      code: classifyQwenVlSmokeFailure(error).code
    };
  }
}

async function analyzeAttempt(
  provider: QwenVlProvider,
  request: VisionRequest
): Promise<VisionResult> {
  const signal = AbortSignal.timeout(150_000);
  try {
    return await provider.analyze({ ...request, signal });
  } catch (error) {
    if (signal.aborted) {
      throw new ProviderTimeoutError(provider.id, "Vision smoke timed out.");
    }
    throw error;
  }
}

async function benchmarkSmoke(): Promise<void> {
  const outputPath = required("QWEN_VL_BENCHMARK_OUTPUT");
  const gitSha = required("AGENT_V3_SMOKE_GIT_SHA");
  const imageDigest = required("AGENT_V3_SMOKE_IMAGE_DIGEST");
  const cases = await benchmarkCases();
  const measurements: QwenVisionBenchmarkMeasurement[] = [];

  const currentProvider = new QwenVlProvider({
    model: CURRENT_MODEL,
    enableThinking: true
  });
  for (const testCase of cases) {
    measurements.push(await measure(currentProvider, testCase, true));
  }
  const baselineProvider = new QwenVlProvider({
    model: BASELINE_MODEL,
    enableThinking: false
  });
  for (const testCase of cases) {
    measurements.push(await measure(baselineProvider, testCase, false));
  }
  const nonThinkingProvider = new QwenVlProvider({
    model: CURRENT_MODEL,
    enableThinking: false
  });
  for (const id of QWEN_VISION_COMPLEX_CASE_IDS) {
    const testCase = cases.find((item) => item.id === id);
    if (!testCase) throw new Error("Complex visual benchmark case is missing.");
    measurements.push(await measure(nonThinkingProvider, testCase, false));
  }

  const current = measurements.filter(
    (item) => item.model === CURRENT_MODEL && item.thinking
  );
  const baseline = measurements.filter(
    (item) => item.model === BASELINE_MODEL && !item.thinking
  );
  const complexThinking = current.filter((item) =>
    QWEN_VISION_COMPLEX_CASE_IDS.includes(
      item.caseId as (typeof QWEN_VISION_COMPLEX_CASE_IDS)[number]
    )
  );
  const complexNonThinking = measurements.filter(
    (item) =>
      item.model === CURRENT_MODEL &&
      !item.thinking &&
      QWEN_VISION_COMPLEX_CASE_IDS.includes(
        item.caseId as (typeof QWEN_VISION_COMPLEX_CASE_IDS)[number]
      )
  );
  const complexThinkingQualityDelta =
    average(complexThinking.map((item) => item.qualityScore)) -
    average(complexNonThinking.map((item) => item.qualityScore));
  const currentQualityScore = average(current.map((item) => item.qualityScore));
  if (
    current.some((item) => item.qualityScore < 75) ||
    currentQualityScore < 85
  ) {
    throw new QwenVlSmokeFailure("RESPONSE_INVALID");
  }

  const report = qwenVisionBenchmarkSchema.parse({
    schemaVersion: "openvac.qwen-vision-benchmark.v1",
    gitSha,
    imageDigest,
    generatedAt: new Date().toISOString(),
    environment: "staging",
    endpointRegion: "cn-beijing",
    protocol: "openai-chat-completions",
    imageTransport: "base64-data-url",
    defaultModel: CURRENT_MODEL,
    defaultThinking: true,
    thinkingBudgetTokens: currentProvider.thinkingBudgetTokens,
    priceVersion: "aliyun-standard-cn-beijing-2026-08-10",
    measurements,
    summary: {
      currentQualityScore,
      baselineQualityScore: average(baseline.map((item) => item.qualityScore)),
      currentMedianFirstTokenLatencyMs: median(
        current.map((item) => item.firstTokenLatencyMs)
      ),
      baselineMedianFirstTokenLatencyMs: median(
        baseline.map((item) => item.firstTokenLatencyMs)
      ),
      currentTotalDurationMs: sum(current.map((item) => item.totalDurationMs)),
      baselineTotalDurationMs: sum(
        baseline.map((item) => item.totalDurationMs)
      ),
      currentTotalTokens: sum(current.map((item) => item.totalTokens)),
      baselineTotalTokens: sum(baseline.map((item) => item.totalTokens)),
      currentEstimatedCostMicrosCny: sum(
        current.map((item) => item.estimatedCostMicrosCny)
      ),
      baselineEstimatedCostMicrosCny: sum(
        baseline.map((item) => item.estimatedCostMicrosCny)
      ),
      complexThinkingQualityDelta,
      recommendation:
        complexThinkingQualityDelta >= 10
          ? "retain_thinking"
          : "review_reasoning_effort_for_cost",
      passed: true
    }
  });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  console.log(
    JSON.stringify({
      passed: true,
      caseCount: QWEN_VISION_BENCHMARK_CASE_IDS.length,
      model: CURRENT_MODEL,
      baselineModel: BASELINE_MODEL,
      defaultThinking: true,
      thinkingBudgetTokens: currentProvider.thinkingBudgetTokens
    })
  );
}

async function measure(
  provider: QwenVlProvider,
  testCase: BenchmarkCase,
  thinking: boolean
): Promise<QwenVisionBenchmarkMeasurement> {
  activeBenchmarkCase = {
    caseId: testCase.id,
    model: provider.model as typeof CURRENT_MODEL | typeof BASELINE_MODEL,
    thinking
  };
  const request: VisionRequest = {
    prompt: testCase.prompt,
    images: testCase.images,
    maxOutputTokens: 384
  };
  const requestStartedAt = performance.now();
  const attempt = await withOneQwenVlControlledFixtureRetry({
    caseId: testCase.id,
    budget: controlledFixtureRetryBudget,
    request,
    execute: (stableRequest) => telemetryAttempt(provider, stableRequest),
    onRetry: (event) => console.warn(JSON.stringify(event))
  });
  const result = attempt.result;
  const requestFinishedAt = performance.now();
  const usage = requireUsage(result);
  const parsed = parseModelObject(result.text);
  const expectedKeys = Object.keys(testCase.expected).sort();
  const totalChecks = expectedKeys.length + 1;
  const valueChecks = Object.entries(testCase.expected).filter(
    ([key, expected]) => equivalent(parsed[key], expected)
  ).length;
  const passedChecks =
    valueChecks +
    (JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify(expectedKeys)
      ? 1
      : 0);
  const measurement: QwenVisionBenchmarkMeasurement = {
    caseId: testCase.id,
    model: provider.model as "qwen3.8-max" | "qwen3-vl-plus",
    thinking,
    qualityScore: Math.round((passedChecks / totalChecks) * 100),
    passedChecks,
    totalChecks,
    firstTokenLatencyMs: result.firstTokenLatencyMs,
    totalDurationMs: qwenVlSmokeRecordedDurationMs({
      attempts: attempt.attempts,
      successfulAttemptDurationMs: result.totalDurationMs,
      requestStartedAtMs: requestStartedAt,
      requestFinishedAtMs: requestFinishedAt
    }),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    estimatedCostMicrosCny: estimatedCostMicrosCny(
      provider.model,
      usage.inputTokens,
      usage.outputTokens
    )
  };
  activeBenchmarkCase = undefined;
  return measurement;
}

async function benchmarkCases(): Promise<BenchmarkCase[]> {
  const image = async (body: string): Promise<VisionImage> => ({
    mimeType: "image/png",
    bytes: new Uint8Array(await renderVisualFixture(body))
  });
  const fixedImage = async (file: string): Promise<VisionImage> => ({
    mimeType: "image/png",
    bytes: new Uint8Array(
      await readFile(
        resolve(process.cwd(), "scripts", "fixtures", "qwen-vl-fixed", file)
      )
    )
  });
  return [
    {
      id: "device_identification",
      prompt: jsonPrompt(["device", "inlet"]),
      images: [await fixedImage("device-identification.png")],
      expected: { device: "turbomolecular pump", inlet: "dn100" }
    },
    {
      id: "nameplate_ocr",
      prompt: jsonPrompt(["model", "serial", "speed_l_s"]),
      images: [await fixedImage("nameplate-ocr.png")],
      expected: { model: "ovp-160", serial: "ov20260810", speed_l_s: 160 }
    },
    {
      id: "gauge_reading",
      prompt: jsonPrompt(["reading", "unit"]),
      images: [await fixedImage("gauge-reading.png")],
      expected: { reading: 0.0025, unit: "pa" }
    },
    {
      id: "pump_curve",
      prompt: jsonPrompt(["pressure_pa", "speed_l_s", "trend"]),
      images: [await fixedImage("pump-curve.png")],
      expected: { pressure_pa: 100, speed_l_s: 120, trend: "decreases" }
    },
    {
      id: "vacuum_schematic",
      prompt: jsonPrompt(["flow_order", "gauge_location"]),
      images: [await image(schematic())],
      expected: {
        flow_order: "chamber,gate valve,turbo pump,backing pump",
        gauge_location: "chamber"
      }
    },
    {
      id: "fault_screenshot",
      prompt: jsonPrompt(["fault_code", "fault"]),
      images: [
        await image(
          panel(
            "CONTROLLER ALARM",
            ["FAULT E07", "COOLING WATER LOW"],
            "#fee2e2"
          )
        )
      ],
      expected: { fault_code: "e07", fault: "cooling water low" }
    },
    {
      id: "table_image",
      prompt: jsonPrompt(["highest_model", "highest_speed_l_s"]),
      images: [await image(table())],
      expected: { highest_model: "ovp-320", highest_speed_l_s: 320 }
    },
    {
      id: "multi_image_comparison",
      prompt: jsonPrompt(["faster_model", "speed_difference_l_s"]),
      images: [
        await image(panel("PUMP A", ["MODEL: OVP-80", "SPEED: 80 L/s"])),
        await image(panel("PUMP B", ["MODEL: OVP-160", "SPEED: 160 L/s"]))
      ],
      expected: { faster_model: "ovp-160", speed_difference_l_s: 80 }
    }
  ];
}

function jsonPrompt(keys: string[]): string {
  return `读取图片，只输出一个 JSON 对象，不要 Markdown 或解释。字段必须且只能是：${keys.join(", ")}。数字字段输出 JSON number，字符串保持图片原意。`;
}

function panel(title: string, lines: string[], color = "#f8fafc"): string {
  return `<rect width="960" height="540" fill="${color}"/><rect x="50" y="45" width="860" height="450" rx="20" fill="#ffffff" stroke="#0f172a" stroke-width="5"/><text x="90" y="120" font-family="Arial" font-size="38" font-weight="700">${title}</text>${lines
    .map(
      (line, index) =>
        `<text x="90" y="${205 + index * 78}" font-family="Arial" font-size="46" font-weight="600">${line}</text>`
    )
    .join("")}`;
}

function schematic(): string {
  const boxes = [
    [40, "CHAMBER"],
    [265, "GATE VALVE"],
    [510, "TURBO PUMP"],
    [750, "BACKING PUMP"]
  ] as const;
  return `<rect width="1040" height="520" fill="#f8fafc"/><text x="40" y="55" font-family="Arial" font-size="34" font-weight="700">VACUUM SYSTEM SCHEMATIC</text>${boxes
    .map(
      ([x, label]) =>
        `<rect x="${x}" y="210" width="190" height="100" rx="12" fill="#fff" stroke="#0f172a" stroke-width="4"/><text x="${x + 18}" y="270" font-family="Arial" font-size="24" font-weight="700">${label}</text>`
    )
    .join(
      ""
    )}<path d="M230 260 H265 M455 260 H510 M700 260 H750" stroke="#2563eb" stroke-width="7" marker-end="url(#a)"/><defs><marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#2563eb"/></marker></defs><circle cx="135" cy="155" r="38" fill="#fff" stroke="#dc2626" stroke-width="5"/><text x="105" y="165" font-family="Arial" font-size="24" font-weight="700">GAUGE</text><line x1="135" y1="193" x2="135" y2="210" stroke="#dc2626" stroke-width="5"/>`;
}

function table(): string {
  const rows = [
    ["MODEL", "SPEED (L/s)", "BASE PRESSURE (Pa)"],
    ["OVP-80", "80", "1E-6"],
    ["OVP-160", "160", "5E-7"],
    ["OVP-320", "320", "2E-7"]
  ];
  return `<rect width="960" height="540" fill="#fff"/><text x="55" y="65" font-family="Arial" font-size="34" font-weight="700">PUMP SELECTION TABLE</text>${rows
    .map((row, r) =>
      row
        .map(
          (cell, c) =>
            `<rect x="${55 + c * 285}" y="${110 + r * 90}" width="285" height="90" fill="${r === 0 ? "#dbeafe" : "#fff"}" stroke="#334155" stroke-width="3"/><text x="${70 + c * 285}" y="${165 + r * 90}" font-family="Arial" font-size="26" font-weight="${r === 0 ? 700 : 500}">${cell}</text>`
        )
        .join("")
    )
    .join("")}`;
}

async function telemetryAttempt(
  provider: QwenVlProvider,
  request: VisionRequest
): Promise<QwenVlTelemetryResult> {
  const signal = AbortSignal.timeout(150_000);
  try {
    return await provider.analyzeWithTelemetry({ ...request, signal });
  } catch (error) {
    if (signal.aborted) {
      throw new ProviderTimeoutError(
        provider.id,
        "Vision benchmark timed out."
      );
    }
    throw error;
  }
}

function parseModelObject(text: string): Record<string, unknown> {
  const normalized = text
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new QwenVlSmokeFailure("RESPONSE_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new QwenVlSmokeFailure("RESPONSE_INVALID");
  }
  return parsed as Record<string, unknown>;
}

function equivalent(actual: unknown, expected: string | number): boolean {
  if (typeof expected === "number") {
    const numeric = typeof actual === "number" ? actual : Number(actual);
    return Number.isFinite(numeric) && Math.abs(numeric - expected) < 1e-9;
  }
  return normalize(String(actual ?? "")).includes(normalize(expected));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, "");
}

function requireUsage(result: Pick<VisionResult, "usage">): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const inputTokens = result.usage?.inputTokens;
  const outputTokens = result.usage?.outputTokens;
  const totalTokens = result.usage?.totalTokens;
  if (
    typeof inputTokens !== "number" ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    typeof totalTokens !== "number" ||
    !Number.isSafeInteger(totalTokens) ||
    totalTokens !== inputTokens + outputTokens
  ) {
    throw new QwenVlSmokeFailure("RESPONSE_INVALID");
  }
  return { inputTokens, outputTokens, totalTokens };
}

function estimatedCostMicrosCny(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  if (model === CURRENT_MODEL) {
    return Math.round(inputTokens * 12 + outputTokens * 36);
  }
  if (model === BASELINE_MODEL) {
    const [inputPrice, outputPrice] =
      inputTokens <= 32_000
        ? [1, 10]
        : inputTokens <= 128_000
          ? [1.5, 15]
          : [3, 30];
    return Math.round(inputTokens * inputPrice + outputTokens * outputPrice);
  }
  throw new Error("Vision benchmark model pricing is missing.");
}

function average(values: number[]): number {
  if (values.length === 0) throw new Error("Cannot average an empty set.");
  return Math.round(sum(values) / values.length);
}

function median(values: number[]): number {
  if (values.length === 0) throw new Error("Cannot take an empty median.");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new QwenVlSmokeFailure("CONFIG_MISSING");
  return value;
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      ...publicQwenVlSmokeFailure(classifyQwenVlSmokeFailure(error)),
      ...(activeBenchmarkCase ?? {})
    })
  );
  process.exitCode = 1;
});
