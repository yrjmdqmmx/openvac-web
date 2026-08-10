import { createHash } from "node:crypto";

import { z } from "zod";

import type { ResponsesInputItem } from "@/server/providers";
import type { CalculationResult } from "@/types/chat";
import type { AnswerV3, AgentV3RiskLevel } from "@/types/chat-v3";

import type { ToolExecutionResult } from "./tool-registry";

const CALCULATION_ID = /^calc_[0-9a-f]{20}$/u;
const MAX_PROJECTION_BYTES = 1_024;
const PUMPDOWN_TOOL = "estimate_pumpdown_time";
const PUMPDOWN_FORMULA = "p(t)=peq+(p0-peq)exp(-St/V)";
const PUMPDOWN_VERSION = "1.1.0";
const REACHABLE_ASSUMPTION =
  "容器充分混合；抽速与气载恒定；未计入泵启动、导流变化和材料解吸瞬态。";
const REACHABLE_WARNING = "这是理想化估算，不能替代泵曲线和实测抽空曲线。";
const UNREACHABLE_ASSUMPTION = "抽速与恒定气载在整个压力区间内保持不变。";
const UNREACHABLE_WARNING = "目标压力不高于理论平衡压力，按该模型不可达。";
const PUMPDOWN_SOURCE = "openvac.formula.pumpdown.constant-speed-load.v1";
const PURE_PUMPDOWN_INTENT =
  /(?:(?:抽空|抽气|抽至|降压).{0,80}(?:时间|多久)|(?:时间|多久).{0,80}(?:抽空|抽气|抽至|降压)|pump[ -]?down.{0,80}time)/iu;
const MIXED_OR_EXTERNAL_INTENT =
  /(?:并且|并同时|同时|以及|另外|还要|还需|然后|比较|选型|推荐|报告|表格|文件|附件|文档|图片|联网|上网|搜索|检索|核对|引用|来源|最新|价格|库存|生成|创建|导出|分析|诊断|建议|方案|report|compare|recommend|attachment|document|search|source)/iu;

const finiteNonNegative = z.number().finite().nonnegative();
const finitePositive = z.number().finite().positive();

const pumpdownCalculationSchema = z
  .object({
    id: z.string().regex(CALCULATION_ID),
    tool: z.literal(PUMPDOWN_TOOL),
    formulaId: z.literal(PUMPDOWN_FORMULA),
    formulaVersion: z.literal(PUMPDOWN_VERSION),
    normalizedInputs: z
      .object({
        volumeM3: finitePositive,
        speedM3S: finitePositive,
        initialPa: finitePositive,
        targetPa: finitePositive,
        gasLoadPaM3S: finiteNonNegative
      })
      .strict(),
    result: z
      .object({
        reachable: z.boolean(),
        equilibriumPressurePa: finiteNonNegative,
        time: z.number().finite().positive().nullable(),
        unit: z.enum(["s", "min", "h"])
      })
      .strict(),
    assumptions: z.array(z.string().max(1_000)).max(8),
    warnings: z.array(z.string().max(1_000)).max(8),
    sourceIds: z.array(z.string().max(200)).max(8)
  })
  .strict()
  .superRefine((value, context) => {
    const { initialPa, targetPa, gasLoadPaM3S, speedM3S } =
      value.normalizedInputs;
    const equilibrium = gasLoadPaM3S / speedM3S;
    if (!Number.isFinite(equilibrium)) {
      context.addIssue({
        code: "custom",
        path: ["result", "equilibriumPressurePa"],
        message: "equilibrium pressure is not finite"
      });
      return;
    }
    if (targetPa >= initialPa) {
      context.addIssue({
        code: "custom",
        path: ["normalizedInputs", "targetPa"],
        message: "target pressure must be below initial pressure"
      });
    }
    if (!nearlyEqual(equilibrium, value.result.equilibriumPressurePa)) {
      context.addIssue({
        code: "custom",
        path: ["result", "equilibriumPressurePa"],
        message: "equilibrium pressure is inconsistent"
      });
    }
    if (value.result.reachable) {
      if (value.result.time === null || targetPa <= equilibrium) {
        context.addIssue({
          code: "custom",
          path: ["result"],
          message: "reachable result is inconsistent"
        });
      } else {
        const seconds =
          (value.normalizedInputs.volumeM3 / speedM3S) *
          Math.log((initialPa - equilibrium) / (targetPa - equilibrium));
        const divisor =
          value.result.unit === "s"
            ? 1
            : value.result.unit === "min"
              ? 60
              : 3_600;
        const expectedTime = seconds / divisor;
        if (
          !Number.isFinite(expectedTime) ||
          !nearlyEqual(expectedTime, value.result.time)
        ) {
          context.addIssue({
            code: "custom",
            path: ["result", "time"],
            message: "pumpdown time is inconsistent"
          });
        }
      }
    } else if (value.result.time !== null || targetPa > equilibrium) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "unreachable result is inconsistent"
      });
    }
    const expectedAssumptions = [
      value.result.reachable ? REACHABLE_ASSUMPTION : UNREACHABLE_ASSUMPTION
    ];
    const expectedWarnings = [
      value.result.reachable ? REACHABLE_WARNING : UNREACHABLE_WARNING
    ];
    if (!sameJson(value.assumptions, expectedAssumptions)) {
      context.addIssue({
        code: "custom",
        path: ["assumptions"],
        message: "pumpdown assumptions are not allowlisted"
      });
    }
    if (!sameJson(value.warnings, expectedWarnings)) {
      context.addIssue({
        code: "custom",
        path: ["warnings"],
        message: "pumpdown warnings are not allowlisted"
      });
    }
    if (!sameJson(value.sourceIds, [PUMPDOWN_SOURCE])) {
      context.addIssue({
        code: "custom",
        path: ["sourceIds"],
        message: "pumpdown sources are not allowlisted"
      });
    }
  });

export type TrustedPumpdownProjection = {
  schemaVersion: "openvac.trusted-calculation.v1";
  kind: "pumpdown_time";
  calculationId: string;
  data:
    | {
        outcome: "reachable";
        estimatedTime: number;
        timeUnit: "s" | "min" | "h";
        equilibriumPressurePa: number;
      }
    | {
        outcome: "unreachable";
        equilibriumPressurePa: number;
      };
};

export type TrustedPumpdownEligibilityFailure =
  | "TRUSTED_CALCULATION_PROJECTION_HIGH_RISK"
  | "TRUSTED_CALCULATION_PROJECTION_WEB_REQUIRED"
  | "TRUSTED_CALCULATION_PROJECTION_MIXED_INTENT"
  | "TRUSTED_CALCULATION_PROJECTION_NON_TEXT_INPUT"
  | "TRUSTED_CALCULATION_PROJECTION_ARTIFACT_INTENT"
  | "TRUSTED_CALCULATION_PROJECTION_TOOL_ROUND_MISMATCH"
  | "TRUSTED_CALCULATION_PROJECTION_CALCULATION_COUNT_MISMATCH"
  | "TRUSTED_CALCULATION_PROJECTION_CALL_COUNT_MISMATCH"
  | "TRUSTED_CALCULATION_PROJECTION_TOOL_NAME_MISMATCH";

export function trustedPumpdownEligibilityFailure(input: {
  riskLevel: AgentV3RiskLevel;
  webRequired: boolean;
  question: string;
  inputPartTypes: readonly string[];
  hasArtifactIntent: boolean;
  toolRounds: number;
  calculationCount: number;
  calls: readonly { name: string }[];
}): TrustedPumpdownEligibilityFailure | undefined {
  if (input.riskLevel === "high") {
    return "TRUSTED_CALCULATION_PROJECTION_HIGH_RISK";
  }
  if (input.webRequired) {
    return "TRUSTED_CALCULATION_PROJECTION_WEB_REQUIRED";
  }
  if (!isPurePumpdownCalculationRequest(input.question)) {
    return "TRUSTED_CALCULATION_PROJECTION_MIXED_INTENT";
  }
  if (input.inputPartTypes.some((type) => type !== "text")) {
    return "TRUSTED_CALCULATION_PROJECTION_NON_TEXT_INPUT";
  }
  if (input.hasArtifactIntent) {
    return "TRUSTED_CALCULATION_PROJECTION_ARTIFACT_INTENT";
  }
  if (input.toolRounds !== 1) {
    return "TRUSTED_CALCULATION_PROJECTION_TOOL_ROUND_MISMATCH";
  }
  if (input.calculationCount !== 1) {
    return "TRUSTED_CALCULATION_PROJECTION_CALCULATION_COUNT_MISMATCH";
  }
  if (input.calls.length !== 1) {
    return "TRUSTED_CALCULATION_PROJECTION_CALL_COUNT_MISMATCH";
  }
  if (input.calls[0]?.name !== PUMPDOWN_TOOL) {
    return "TRUSTED_CALCULATION_PROJECTION_TOOL_NAME_MISMATCH";
  }
  return undefined;
}

export function trustedPumpdownArtifactEligibilityFailure(input: {
  riskLevel: AgentV3RiskLevel;
  webRequired: boolean;
  inputPartTypes: readonly string[];
  hasArtifactIntent: boolean;
  toolRounds: number;
  calculationCount: number;
  calls: readonly { name: string }[];
}): TrustedPumpdownEligibilityFailure | undefined {
  if (input.riskLevel === "high") {
    return "TRUSTED_CALCULATION_PROJECTION_HIGH_RISK";
  }
  if (input.webRequired) {
    return "TRUSTED_CALCULATION_PROJECTION_WEB_REQUIRED";
  }
  if (input.inputPartTypes.some((type) => type !== "text")) {
    return "TRUSTED_CALCULATION_PROJECTION_NON_TEXT_INPUT";
  }
  if (!input.hasArtifactIntent) {
    return "TRUSTED_CALCULATION_PROJECTION_ARTIFACT_INTENT";
  }
  if (input.toolRounds !== 1) {
    return "TRUSTED_CALCULATION_PROJECTION_TOOL_ROUND_MISMATCH";
  }
  if (input.calculationCount !== 1) {
    return "TRUSTED_CALCULATION_PROJECTION_CALCULATION_COUNT_MISMATCH";
  }
  if (input.calls.length !== 1) {
    return "TRUSTED_CALCULATION_PROJECTION_CALL_COUNT_MISMATCH";
  }
  if (input.calls[0]?.name !== PUMPDOWN_TOOL) {
    return "TRUSTED_CALCULATION_PROJECTION_TOOL_NAME_MISMATCH";
  }
  return undefined;
}

export function buildTrustedPumpdownProjection(
  value: unknown
): TrustedPumpdownProjection {
  const calculation = pumpdownCalculationSchema.parse(value);
  const expectedId = calculationId(calculation);
  if (calculation.id !== expectedId) {
    throw new TypeError("Calculation identifier does not match its payload.");
  }
  const projection: TrustedPumpdownProjection = {
    schemaVersion: "openvac.trusted-calculation.v1",
    kind: "pumpdown_time",
    calculationId: calculation.id,
    data: calculation.result.reachable
      ? {
          outcome: "reachable",
          estimatedTime: calculation.result.time as number,
          timeUnit: calculation.result.unit,
          equilibriumPressurePa: calculation.result.equilibriumPressurePa
        }
      : {
          outcome: "unreachable",
          equilibriumPressurePa: calculation.result.equilibriumPressurePa
        }
  };
  if (
    Buffer.byteLength(JSON.stringify(projection), "utf8") > MAX_PROJECTION_BYTES
  ) {
    throw new TypeError(
      "Trusted calculation projection exceeds its byte limit."
    );
  }
  return projection;
}

export function buildTrustedCalculationFinalInput(
  originalInput: readonly ResponsesInputItem[],
  projection: TrustedPumpdownProjection
): ResponsesInputItem[] {
  if (originalInput.some((item) => item.type !== "message")) {
    throw new TypeError(
      "Trusted calculation input must start from message-only context."
    );
  }
  return [
    ...originalInput,
    {
      type: "message",
      role: "system",
      content: JSON.stringify({
        schemaVersion: "openvac.trusted-calculation-context.v1",
        dataOnly: true,
        requiredCalculationIds: [projection.calculationId],
        requiredAnswerShape: "calculation_blocks_only",
        calculation: projection
      })
    }
  ];
}

export function buildTrustedCalculationArtifactInput(
  originalInput: readonly ResponsesInputItem[],
  projection: TrustedPumpdownProjection
): ResponsesInputItem[] {
  if (originalInput.some((item) => item.type !== "message")) {
    throw new TypeError(
      "Trusted calculation input must start from message-only context."
    );
  }
  return [
    ...originalInput,
    {
      type: "message",
      role: "system",
      content: JSON.stringify({
        schemaVersion: "openvac.trusted-calculation-artifact-context.v1",
        dataOnly: true,
        requiredCalculationIds: [projection.calculationId],
        requiredAction: "create_artifact",
        calculation: projection
      })
    }
  ];
}

export function isPurePumpdownCalculationRequest(question: string): boolean {
  const normalized = question.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return (
    normalized.length > 0 &&
    normalized.length <= 600 &&
    PURE_PUMPDOWN_INTENT.test(normalized) &&
    !MIXED_OR_EXTERNAL_INTENT.test(normalized)
  );
}

export function trustedPumpdownProjectionFromToolTurn(input: {
  calls: readonly { callId: string; name: string; arguments: string }[];
  executedCalls?: readonly {
    callId: string;
    name: string;
    arguments: string;
  }[];
  continuationItems: readonly ResponsesInputItem[];
  outputs: readonly ToolExecutionResult[];
}): TrustedPumpdownProjection | undefined {
  const executedCalls = input.executedCalls ?? input.calls;
  if (
    input.calls.length !== 1 ||
    executedCalls.length !== 1 ||
    input.outputs.length !== 1 ||
    input.continuationItems.length !== 1
  ) {
    return undefined;
  }
  const providerCall = input.calls[0];
  const call = executedCalls[0];
  const output = input.outputs[0];
  const continuation = input.continuationItems[0];
  if (
    !providerCall ||
    !call ||
    providerCall.callId !== call.callId ||
    providerCall.name !== call.name ||
    call.name !== PUMPDOWN_TOOL ||
    !output ||
    !output.ok ||
    output.calculations.length !== 1 ||
    output.evidenceIds.length !== 0 ||
    output.verifiedLinks.length !== 0 ||
    output.artifacts.length !== 0 ||
    output.missingInputs.length !== 0 ||
    continuation?.type !== "function_call" ||
    continuation.call_id !== providerCall.callId ||
    continuation.name !== providerCall.name ||
    continuation.arguments !== providerCall.arguments ||
    output.outputItem.type !== "function_call_output" ||
    output.outputItem.call_id !== call.callId
  ) {
    return undefined;
  }
  const calculation = output.calculations[0];
  if (!calculation || calculation.tool !== call.name) return undefined;
  if (
    boundCalculationIdFromToolResult(output, {
      callId: call.callId,
      toolName: call.name
    }) !== calculation.id
  ) {
    return undefined;
  }
  try {
    return buildTrustedPumpdownProjection(calculation);
  } catch {
    return undefined;
  }
}

export function answerUsesOnlyProjectedCalculations(
  answer: AnswerV3,
  calculationIds: ReadonlySet<string>,
  riskLevel: AgentV3RiskLevel
): boolean {
  if (
    answer.riskLevel !== riskLevel ||
    answer.answerKind !== (riskLevel === "low" ? "direct" : "expert") ||
    answer.missingInputs.length !== 0 ||
    answer.usedEvidenceIds.length !== 0 ||
    answer.usedLinkIds.length !== 0
  ) {
    return false;
  }
  const blocks = answer.blocks;
  if (blocks.length !== calculationIds.size || blocks.length === 0)
    return false;
  const answerCalculationIds = blocks.flatMap((block) =>
    block.type === "calculation" ? [block.calculationId] : []
  );
  return (
    answerCalculationIds.length === blocks.length &&
    new Set(answerCalculationIds).size === calculationIds.size &&
    answerCalculationIds.every((id) => calculationIds.has(id))
  );
}

export function calculationsForProjection(
  calculationIds: ReadonlySet<string>,
  calculations: ReadonlyMap<string, CalculationResult>
): CalculationResult[] | undefined {
  if (calculationIds.size === 0) return undefined;
  const selected = [...calculationIds].flatMap((id) => {
    const calculation = calculations.get(id);
    return calculation ? [calculation] : [];
  });
  return selected.length === calculationIds.size ? selected : undefined;
}

export function boundCalculationIdFromToolResult(
  result: ToolExecutionResult,
  expected: { callId: string; toolName: string }
): string | undefined {
  if (!result.ok || result.calculations.length !== 1) return undefined;
  const calculation = result.calculations[0];
  if (
    !calculation ||
    calculation.tool !== expected.toolName ||
    !CALCULATION_ID.test(calculation.id) ||
    result.outputItem.type !== "function_call_output" ||
    result.outputItem.call_id !== expected.callId
  ) {
    return undefined;
  }
  const parsedOutput = safeJson(String(result.outputItem.output ?? ""));
  return parsedOutput?.ok === true &&
    sameJson(Object.keys(parsedOutput).sort(), ["calculation", "ok"]) &&
    sameJson(parsedOutput.calculation, calculation)
    ? calculation.id
    : undefined;
}

function calculationId(calculation: CalculationResult): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        tool: calculation.tool,
        formulaId: calculation.formulaId,
        normalizedInputs: calculation.normalizedInputs,
        result: calculation.result
      })
    )
    .digest("hex")
    .slice(0, 20);
  return `calc_${digest}`;
}

function nearlyEqual(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (left === right) return true;
  const scale = Math.max(Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * 64 * scale;
}

function safeJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
