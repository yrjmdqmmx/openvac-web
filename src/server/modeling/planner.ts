import { z } from "zod";

import {
  hashModelingPlanDraft,
  modelOperationSchema,
  modelingPlanDraftSchema,
  expandRotaryVanePumpDerivedOperations,
  type ModelDocument,
  type ModelOperation,
  type ModelParameter,
  type ModelingPlanDraft
} from "@/lib/modeling";
import { getModelProvider } from "@/server/providers";
import type { ModelProvider, ModelTool } from "@/server/providers/types";

const MAX_TOOL_ARGUMENT_BYTES = 256 * 1024;

const MODEL_OPERATION_TOOL_SCHEMA = (() => {
  const schema = z.toJSONSchema(modelOperationSchema, {
    target: "draft-7"
  }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
})();

const PLAN_TOOL: ModelTool = {
  name: "submit_modeling_plan",
  description:
    "Submit a bounded OpenVac modeling plan. Ask for missing engineering inputs instead of inventing dimensions.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "summary",
      "assumptions",
      "warnings",
      "missingInputs",
      "expectedChecks",
      "operations"
    ],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 160 },
      summary: { type: "string", minLength: 1, maxLength: 4000 },
      assumptions: {
        type: "array",
        maxItems: 100,
        items: { type: "string", minLength: 1, maxLength: 500 }
      },
      warnings: {
        type: "array",
        maxItems: 100,
        items: { type: "string", minLength: 1, maxLength: 500 }
      },
      missingInputs: {
        type: "array",
        maxItems: 100,
        items: { type: "string", minLength: 1, maxLength: 500 }
      },
      expectedChecks: {
        type: "array",
        maxItems: 100,
        items: { type: "string", minLength: 1, maxLength: 500 }
      },
      operations: {
        type: "array",
        maxItems: 500,
        description:
          "Exact openvac.modeling.v1 operations. Leave empty whenever missingInputs is non-empty.",
        items: MODEL_OPERATION_TOOL_SCHEMA
      }
    }
  }
};

interface RawPlanToolPayload {
  title: string;
  summary: string;
  assumptions: string[];
  warnings: string[];
  missingInputs: string[];
  expectedChecks: string[];
  operations: unknown[];
}

export interface CreateModelingPlanInput {
  document: ModelDocument;
  baseRevisionId: string;
  prompt: string;
  idempotencyKey: string;
  selectedSemanticRefs?: string[];
  provider?: ModelProvider;
  signal?: AbortSignal;
}

export class ModelingPlannerError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "ModelingPlannerError";
  }
}

export async function createModelingPlan(
  input: CreateModelingPlanInput
): Promise<ModelingPlanDraft> {
  const prompt = input.prompt.trim();
  if (prompt.length < 2 || prompt.length > 4_000) {
    throw new ModelingPlannerError("自然语言建模指令必须为 2–4000 个字符。");
  }
  if (input.document.revisionId !== input.baseRevisionId) {
    throw new ModelingPlannerError("建模计划的基础版本与当前文档不一致。");
  }
  const selectedSemanticRefs = input.selectedSemanticRefs ?? [];
  const availableRefs = documentSemanticRefs(input.document);
  const unknownSelection = selectedSemanticRefs.find(
    (reference) => !availableRefs.has(reference)
  );
  if (unknownSelection) {
    throw new ModelingPlannerError(
      `选择对象 ${unknownSelection} 不属于当前建模版本。`
    );
  }

  const provider = input.provider ?? getModelProvider();
  const argumentsByIndex = new Map<number, string>();
  const namesByIndex = new Map<number, string>();
  let streamedText = "";

  for await (const event of provider.stream({
    signal: input.signal,
    temperature: 0,
    maxOutputTokens: 4096,
    tools: [PLAN_TOOL],
    messages: [
      { role: "system", content: buildSystemPrompt() },
      {
        role: "user",
        content: JSON.stringify({
          intent: prompt,
          selectedSemanticRefs,
          currentDocument: input.document
        })
      }
    ]
  })) {
    if (event.type === "text-delta") {
      streamedText += event.text;
      if (Buffer.byteLength(streamedText, "utf8") > 32 * 1024) {
        throw new ModelingPlannerError("AI 规划器返回了过长的非结构化文本。");
      }
    }
    if (event.type === "tool-call-delta") {
      if (event.name) namesByIndex.set(event.index, event.name);
      if (event.argumentsDelta) {
        const next =
          (argumentsByIndex.get(event.index) ?? "") + event.argumentsDelta;
        if (Buffer.byteLength(next, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
          throw new ModelingPlannerError("AI 建模计划超过协议大小限制。");
        }
        argumentsByIndex.set(event.index, next);
      }
    }
  }

  const calls = [...argumentsByIndex.entries()].filter(
    ([index]) => namesByIndex.get(index) === PLAN_TOOL.name
  );
  if (calls.length !== 1) {
    throw new ModelingPlannerError(
      streamedText.trim()
        ? "AI 只返回了解释文本，没有提交可验证的建模计划。"
        : "AI 没有提交唯一的结构化建模计划。"
    );
  }

  let payload: RawPlanToolPayload;
  try {
    payload = validateRawPayload(JSON.parse(calls[0]?.[1] ?? ""));
  } catch (cause) {
    throw new ModelingPlannerError("AI 返回的建模计划不符合受限协议。", {
      cause
    });
  }

  let parsedOperations: ModelOperation[] = [];
  if (payload.missingInputs.length === 0 && payload.operations.length > 0) {
    parsedOperations = payload.operations.map((operation) =>
      modelOperationSchema.parse(operation)
    ) as ModelOperation[];
  }
  const deterministicMissingInputs = findUnconfirmedInputs({
    document: input.document,
    operations: parsedOperations,
    prompt,
    selectedSemanticRefs
  });
  const missingInputs = uniqueStrings([
    ...payload.missingInputs.map((item) => item.trim()),
    ...deterministicMissingInputs
  ]);
  const status = missingInputs.length > 0 ? "needs_input" : "validated";
  let operationBatch: ModelingPlanDraft["operationBatch"];
  if (status === "validated") {
    if (payload.operations.length === 0) {
      throw new ModelingPlannerError("已验证的 AI 计划必须包含至少一个操作。");
    }
    operationBatch = expandRotaryVanePumpDerivedOperations(input.document, {
      version: "openvac.modeling.v1",
      id: crypto.randomUUID(),
      documentId: input.document.id,
      baseRevisionId: input.baseRevisionId,
      idempotencyKey: input.idempotencyKey,
      operations: normalizeUserParameterSources(parsedOperations)
    });
  }

  const draft: ModelingPlanDraft = {
    version: "openvac.modeling.v1",
    id: crypto.randomUUID(),
    documentId: input.document.id,
    baseRevisionId: input.baseRevisionId,
    title: payload.title.trim(),
    summary: payload.summary.trim(),
    status,
    assumptions: payload.assumptions.map((item) => item.trim()),
    warnings: uniqueStrings([
      ...payload.warnings.map((item) => item.trim()),
      ...(deterministicMissingInputs.length
        ? ["AI 提议中存在未经用户明确确认的数值或目标，已阻止执行。"]
        : [])
    ]),
    missingInputs,
    expectedChecks: payload.expectedChecks.map((item) => item.trim()),
    planHash: "0".repeat(64),
    ...(operationBatch ? { operationBatch } : {})
  };
  draft.planHash = hashModelingPlanDraft(draft);
  return modelingPlanDraftSchema.parse(draft);
}

function findUnconfirmedInputs(input: {
  document: ModelDocument;
  operations: ModelOperation[];
  prompt: string;
  selectedSemanticRefs: string[];
}): string[] {
  const missing: string[] = [];
  const addedParameters = input.operations.flatMap((operation) =>
    operation.kind === "add" &&
    operation.collection === "parameters" &&
    "parameterType" in operation.item
      ? [operation.item as ModelParameter]
      : []
  );
  const parameterTargets = [...input.document.parameters, ...addedParameters];
  const parametersByReference = new Map<string, ModelParameter>();
  for (const parameter of input.document.parameters) {
    parametersByReference.set(parameter.id, parameter);
    parametersByReference.set(parameter.semanticRef, parameter);
  }

  for (const operation of input.operations) {
    if (
      operation.kind === "add" &&
      operation.collection === "parameters" &&
      "parameterType" in operation.item
    ) {
      const parameter = operation.item as ModelParameter;
      if (parameter.source !== "user") {
        missing.push(
          `请明确参数“${parameter.label}”的工程来源；AI 不得把新尺寸标记为模板或派生真值。`
        );
      }
      collectUnconfirmedParameterNumbers(
        parameter,
        parameterTargets,
        input.prompt,
        missing
      );
    }

    if (operation.kind === "update" && operation.collection === "parameters") {
      const parameter =
        parametersByReference.get(operation.target.id) ??
        parametersByReference.get(operation.target.semanticRef);
      if (!parameter) {
        missing.push(
          `请重新选择参数“${operation.target.semanticRef}”；它不属于当前版本。`
        );
        continue;
      }
      if (!parameter.editable && "value" in operation.changes) {
        missing.push(`参数“${parameter.label}”不可由 AI 直接修改。`);
        continue;
      }
      const changes = operation.changes as Record<string, unknown>;
      for (const field of ["value", "minimum", "maximum"] as const) {
        const value = changes[field];
        if (
          typeof value === "number" &&
          !promptConfirmsParameterQuantity(
            input.prompt,
            value,
            parameter,
            parameterTargets
          )
        ) {
          missing.push(parameterConfirmationQuestion(parameter, field, value));
        }
      }
      if (
        (changes.source !== undefined && changes.source !== "user") ||
        (changes.unit !== undefined && changes.unit !== parameter.unit) ||
        (changes.parameterType !== undefined &&
          changes.parameterType !== parameter.parameterType)
      ) {
        missing.push(
          `请明确是否要改变参数“${parameter.label}”的类型、单位或来源；AI 不会自行改写这些语义。`
        );
      }
    }
  }

  collectUnconfirmedInlineGeometry(input, missing);

  if (usesDeicticTarget(input.prompt)) {
    if (input.selectedSemanticRefs.length === 0) {
      missing.push("请在建模工作台中选择目标对象后再提交这条指令。");
    } else if (
      input.operations.length > 0 &&
      !operationsReferenceAny(input.operations, input.selectedSemanticRefs)
    ) {
      missing.push("AI 计划没有引用当前选择对象，请重新确认目标对象。");
    }
  }

  return uniqueStrings(missing);
}

function collectUnconfirmedInlineGeometry(
  input: {
    document: ModelDocument;
    operations: ModelOperation[];
    prompt: string;
  },
  missing: string[]
) {
  for (const operation of input.operations) {
    if (operation.kind === "add") {
      if (
        operation.collection === "sketches" ||
        operation.collection === "features" ||
        operation.collection === "components"
      ) {
        collectChangedGeometryNumbers(
          operation.item,
          undefined,
          input.prompt,
          missing,
          operation.item.semanticRef,
          "add"
        );
      }
      continue;
    }
    if (
      operation.kind !== "update" ||
      !["sketches", "features", "components"].includes(operation.collection)
    ) {
      continue;
    }
    const collection = input.document[operation.collection] as Array<{
      id: string;
      semanticRef: string;
    }>;
    const current = collection.find(
      (item) =>
        item.id === operation.target.id &&
        item.semanticRef === operation.target.semanticRef
    );
    if (!current) continue;
    collectChangedGeometryNumbers(
      operation.changes,
      current,
      input.prompt,
      missing,
      operation.target.semanticRef,
      "update"
    );
  }
}

function collectChangedGeometryNumbers(
  proposed: unknown,
  current: unknown,
  prompt: string,
  missing: string[],
  target: string,
  operationKind: "add" | "update",
  path: string[] = []
) {
  if (typeof proposed === "number") {
    if (typeof current === "number" && nearlyEqual(proposed, current)) return;
    if (
      operationKind === "add" &&
      Object.is(proposed, 0) &&
      isCanonicalAddZero(path)
    ) {
      return;
    }
    const unit = inlineGeometryUnit(path);
    if (
      unit &&
      !promptConfirmsQuantity(
        prompt,
        proposed,
        unit,
        unit === "deg" ? "angle" : "length"
      )
    ) {
      missing.push(
        `请明确几何对象“${target}”的 ${proposed} ${unit} 数值；AI 不会自行确定位置或角度。`
      );
    }
    return;
  }
  if (!proposed || typeof proposed !== "object") return;
  if (Array.isArray(proposed)) {
    const currentArray = Array.isArray(current) ? current : [];
    proposed.forEach((value, index) =>
      collectChangedGeometryNumbers(
        value,
        currentArray[index],
        prompt,
        missing,
        target,
        operationKind,
        [...path, String(index)]
      )
    );
    return;
  }
  const currentRecord =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(
    proposed as Record<string, unknown>
  )) {
    collectChangedGeometryNumbers(
      value,
      currentRecord[key],
      prompt,
      missing,
      target,
      operationKind,
      [...path, key]
    );
  }
}

function isCanonicalAddZero(path: string[]) {
  if (path.includes("axisOrigin")) return true;
  if (path.includes("axisDirection") || path.includes("directionVector")) {
    return true;
  }
  if (path.includes("translationMm")) return true;
  if (path.includes("rotationDegrees")) return true;
  return false;
}

function inlineGeometryUnit(path: string[]): "mm" | "deg" | undefined {
  if (path.includes("axisDirection") || path.includes("directionVector")) {
    return undefined;
  }
  if (path.includes("translationMm") || path.includes("axisOrigin")) {
    return "mm";
  }
  const key = path.at(-1) ?? "";
  if (key === "x" || key === "y") return "mm";
  if (
    key === "rotationDegrees" ||
    key === "centerAngleDegrees" ||
    key === "totalAngleDegrees"
  ) {
    return "deg";
  }
  return undefined;
}

function normalizeUserParameterSources(
  operations: ModelOperation[]
): ModelOperation[] {
  return operations.map((operation) => {
    if (
      operation.kind !== "update" ||
      operation.collection !== "parameters" ||
      !("value" in operation.changes)
    ) {
      return operation;
    }
    return modelOperationSchema.parse({
      ...operation,
      changes: { ...operation.changes, source: "user" }
    }) as ModelOperation;
  });
}

function collectUnconfirmedParameterNumbers(
  parameter: ModelParameter,
  parameterTargets: ModelParameter[],
  prompt: string,
  missing: string[]
) {
  for (const field of ["value", "minimum", "maximum"] as const) {
    const value = parameter[field];
    if (
      typeof value === "number" &&
      !promptConfirmsParameterQuantity(
        prompt,
        value,
        parameter,
        parameterTargets
      )
    ) {
      missing.push(parameterConfirmationQuestion(parameter, field, value));
    }
  }
}

function promptConfirmsParameterQuantity(
  prompt: string,
  expectedValue: number,
  parameter: ModelParameter,
  parameterTargets: ModelParameter[]
) {
  const normalized = normalizePrompt(prompt);
  const quantities = extractPromptQuantities(normalized).filter(
    (quantity) =>
      quantity.unit === parameter.unit &&
      nearlyEqual(quantity.value, expectedValue) &&
      (parameter.parameterType !== "integer" ||
        Number.isInteger(quantity.value))
  );
  if (quantities.length === 0) return false;

  const mentions = parameterTargets.flatMap((candidate) =>
    parameterTargetMentions(normalized, candidate)
  );
  return quantities.some((quantity) => {
    const associated = mentions.filter((mention) =>
      isAssociatedTextSpan(normalized, mention, quantity)
    );
    if (associated.length === 0) return false;

    const nearestByParameter = new Map<string, number>();
    for (const mention of associated) {
      const distance = textSpanDistance(mention, quantity);
      const existing = nearestByParameter.get(mention.parameterId);
      if (existing === undefined || distance < existing) {
        nearestByParameter.set(mention.parameterId, distance);
      }
    }
    const nearestDistance = Math.min(...nearestByParameter.values());
    const nearestParameterIds = [...nearestByParameter.entries()]
      .filter(([, distance]) => distance === nearestDistance)
      .map(([parameterId]) => parameterId);
    return (
      nearestParameterIds.length === 1 &&
      nearestParameterIds[0] === parameter.id
    );
  });
}

function parameterConfirmationQuestion(
  parameter: ModelParameter,
  field: "value" | "minimum" | "maximum",
  proposedValue: number
) {
  const fieldName =
    field === "value" ? "目标值" : field === "minimum" ? "最小值" : "最大值";
  return `请明确参数“${parameter.label}”的${fieldName}及单位（${parameter.unit}）；AI 提议的 ${proposedValue} 未在指令中得到确认。`;
}

function promptConfirmsQuantity(
  prompt: string,
  expectedValue: number,
  unit: ModelParameter["unit"],
  parameterType: ModelParameter["parameterType"]
) {
  const quantities = extractPromptQuantities(prompt);
  return quantities.some(
    (quantity) =>
      quantity.unit === unit &&
      nearlyEqual(quantity.value, expectedValue) &&
      (parameterType !== "integer" || Number.isInteger(quantity.value))
  );
}

interface PromptTextSpan {
  start: number;
  end: number;
}

interface ParameterTargetMention extends PromptTextSpan {
  parameterId: string;
}

const KNOWN_PARAMETER_ALIASES: Record<string, string[]> = {
  "pump.parameter.chamber-diameter": ["泵腔直径", "腔体直径", "泵腔内径"],
  "pump.parameter.rotor-diameter": ["转子直径"],
  "pump.parameter.eccentricity": ["偏心量", "转子偏心量"],
  "pump.parameter.axial-width": ["轴向宽度"],
  "pump.parameter.vane-count": ["旋片数量", "滑片数量", "叶片数量"],
  "pump.parameter.vane-thickness": ["旋片厚度", "滑片厚度"],
  "pump.parameter.vane-height": ["旋片高度", "滑片高度", "旋片径向高度"],
  "pump.parameter.shaft-diameter": ["主轴直径", "轴直径"],
  "pump.parameter.inlet-width": ["进气口宽度", "入口宽度"],
  "pump.parameter.outlet-width": ["排气口宽度", "出口宽度"],
  "pump.parameter.cover-outer-diameter": ["端盖外径"],
  "pump.parameter.cover-thickness": ["端盖厚度"],
  "pump.parameter.cover-bore-diameter": ["端盖轴孔直径"]
};

function parameterTargetMentions(
  normalizedPrompt: string,
  parameter: ModelParameter
): ParameterTargetMention[] {
  const aliases = parameterTargetAliases(parameter);
  const mentions: ParameterTargetMention[] = [];
  for (const alias of aliases) {
    let fromIndex = 0;
    while (fromIndex < normalizedPrompt.length) {
      const start = normalizedPrompt.indexOf(alias, fromIndex);
      if (start === -1) break;
      const end = start + alias.length;
      if (hasTargetBoundaries(normalizedPrompt, alias, start, end)) {
        mentions.push({ parameterId: parameter.id, start, end });
      }
      fromIndex = start + Math.max(alias.length, 1);
    }
  }
  return mentions;
}

function parameterTargetAliases(parameter: ModelParameter): string[] {
  const semanticLeaf = parameter.semanticRef.split(/[.:/]/u).at(-1) ?? "";
  const rawAliases = [
    parameter.label,
    parameter.name,
    splitCamelCase(parameter.name),
    parameter.semanticRef,
    semanticLeaf,
    semanticLeaf.replace(/[-_]+/gu, " "),
    ...(KNOWN_PARAMETER_ALIASES[parameter.semanticRef] ?? [])
  ];
  return uniqueStrings(
    rawAliases.map((alias) => normalizePrompt(alias).trim()).filter(Boolean)
  ).sort((left, right) => right.length - left.length);
}

function splitCamelCase(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
}

function hasTargetBoundaries(
  prompt: string,
  alias: string,
  start: number,
  end: number
) {
  if (!/^[a-z0-9]/u.test(alias) && !/[a-z0-9]$/u.test(alias)) return true;
  const before = prompt[start - 1] ?? "";
  const after = prompt[end] ?? "";
  return !/[a-z0-9]/u.test(before) && !/[a-z0-9]/u.test(after);
}

function isAssociatedTextSpan(
  prompt: string,
  left: PromptTextSpan,
  right: PromptTextSpan
) {
  if (textSpanDistance(left, right) > 64) return false;
  const between =
    left.end <= right.start
      ? prompt.slice(left.end, right.start)
      : prompt.slice(right.end, left.start);
  return !/[，。；;、\n\r]/u.test(between);
}

function textSpanDistance(left: PromptTextSpan, right: PromptTextSpan) {
  if (left.end <= right.start) return right.start - left.end;
  if (right.end <= left.start) return left.start - right.end;
  return 0;
}

function extractPromptQuantities(prompt: string): Array<{
  value: number;
  unit: ModelParameter["unit"];
  start: number;
  end: number;
}> {
  const normalized = normalizePrompt(prompt);
  const quantities: Array<{
    value: number;
    unit: ModelParameter["unit"];
    start: number;
    end: number;
  }> = [];
  const pattern =
    /(-?(?:\d+(?:\.\d+)?|\.\d+))\s*(毫米|厘米|公分|英寸|mm|cm|inches|inch|in|degrees|degree|deg|°|度|百分比|percent|%|ratio|倍|count|pieces|piece|pcs|pc|个|片|枚|件)/giu;
  for (const match of normalized.matchAll(pattern)) {
    const rawValue = Number(match[1]);
    const rawUnit = match[2];
    if (!Number.isFinite(rawValue) || !rawUnit || match.index === undefined) {
      continue;
    }
    const start = match.index;
    const end = start + match[0].length;
    if (["毫米", "mm"].includes(rawUnit)) {
      quantities.push({ value: rawValue, unit: "mm", start, end });
    } else if (["厘米", "公分", "cm"].includes(rawUnit)) {
      quantities.push({ value: rawValue * 10, unit: "mm", start, end });
    } else if (["英寸", "inch", "inches", "in"].includes(rawUnit)) {
      quantities.push({ value: rawValue * 25.4, unit: "mm", start, end });
    } else if (["degrees", "degree", "deg", "°", "度"].includes(rawUnit)) {
      quantities.push({ value: rawValue, unit: "deg", start, end });
    } else if (["百分比", "percent", "%"].includes(rawUnit)) {
      quantities.push({
        value: rawValue / 100,
        unit: "ratio",
        start,
        end
      });
    } else if (["ratio", "倍"].includes(rawUnit)) {
      quantities.push({ value: rawValue, unit: "ratio", start, end });
    } else {
      quantities.push({ value: rawValue, unit: "count", start, end });
    }
  }

  const bareCountPatterns = [
    /(?:数量|count)\D{0,12}(-?(?:\d+(?:\.\d+)?|\.\d+))/giu,
    /(-?(?:\d+(?:\.\d+)?|\.\d+))\D{0,12}(?:数量|count)/giu
  ];
  for (const pattern of bareCountPatterns) {
    for (const match of normalized.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && match.index !== undefined && match[1]) {
        const start = match.index + match[0].indexOf(match[1]);
        quantities.push({
          value,
          unit: "count",
          start,
          end: start + match[1].length
        });
      }
    }
  }
  return quantities;
}

function normalizePrompt(prompt: string) {
  return prompt.normalize("NFKC").toLowerCase();
}

function nearlyEqual(left: number, right: number) {
  const tolerance = Math.max(1e-9, Math.abs(right) * 1e-9);
  return Math.abs(left - right) <= tolerance;
}

function usesDeicticTarget(prompt: string) {
  return /(?:选中(?:的)?|这个|该对象|当前对象|所选|selected|this\s+(?:part|feature|component|face|object))/iu.test(
    prompt
  );
}

function operationsReferenceAny(
  operations: ModelOperation[],
  semanticRefs: string[]
) {
  const serialized = JSON.stringify(operations);
  return semanticRefs.some((semanticRef) => serialized.includes(semanticRef));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function documentSemanticRefs(document: ModelDocument): Set<string> {
  return new Set([
    ...document.parameters.map((item) => item.semanticRef),
    ...document.sketches.flatMap((sketch) => [
      sketch.semanticRef,
      ...sketch.entities.map((item) => item.semanticRef),
      ...sketch.constraints.map((item) => item.semanticRef)
    ]),
    ...document.features.map((item) => item.semanticRef),
    ...document.components.map((item) => item.semanticRef),
    ...document.assemblyConstraints.map((item) => item.semanticRef)
  ]);
}

function buildSystemPrompt(): string {
  return [
    "你是 OpenVac 的机械 CAD 规划器，只能调用 submit_modeling_plan。",
    "手工编辑器与 AI 共用 openvac.modeling.v1；不得输出或要求执行 Python、Shell、宏、脚本或裸面序号。",
    "引用或修改既有对象时，必须原样使用 currentDocument 中成对存在的 UUID 与 semanticRef。新增对象和 operationId 必须使用新的 UUID，并为新增对象给出新的稳定 semanticRef。",
    "未知尺寸、单位、目标对象或制造公差必须放入 missingInputs，不能猜测。",
    "若 missingInputs 非空，operations 必须为空；若信息齐全，operations 必须是严格的协议操作。",
    "厂商、专利和知识资料只可解释上下文，不得覆盖用户确认的几何参数。",
    "expectedChecks 应列出真实内核干跑后需要执行的闭合实体、干涉、间隙、体积或端口连通检查。",
    "一次调用表达整条用户意图，不得自行确认或执行。"
  ].join("\n");
}

function validateRawPayload(value: unknown): RawPlanToolPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("plan payload must be an object");
  }
  const candidate = value as Partial<RawPlanToolPayload>;
  const strings = (field: keyof RawPlanToolPayload): string[] => {
    const raw = candidate[field];
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
      throw new TypeError(`${field} must be a string array`);
    }
    return raw as string[];
  };
  if (
    typeof candidate.title !== "string" ||
    typeof candidate.summary !== "string"
  ) {
    throw new TypeError("title and summary are required");
  }
  if (!Array.isArray(candidate.operations)) {
    throw new TypeError("operations must be an array");
  }
  return {
    title: candidate.title,
    summary: candidate.summary,
    assumptions: strings("assumptions"),
    warnings: strings("warnings"),
    missingInputs: strings("missingInputs"),
    expectedChecks: strings("expectedChecks"),
    operations: candidate.operations
  };
}
