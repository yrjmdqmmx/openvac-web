import { z } from "zod";

import type {
  AnswerSectionName,
  AnswerSectionValue,
  AnswerV2
} from "@/types/chat";

const boundedText = z.string().trim().min(1).max(4_000);
const evidenceId = z.string().trim().min(1).max(200);
const LEGACY_TOOL_LABELS: Readonly<Record<string, string>> = {
  convert_vacuum_units: "真空单位换算",
  calculate_throughput: "气体流量计算",
  calculate_effective_pumping_speed: "有效抽速计算",
  estimate_pumpdown_time: "抽空时间估算",
  classify_flow_regime: "流态判定",
  calculate_orifice_or_tube_conductance: "孔口或管道流导计算",
  combine_parallel_pumps: "并联泵有效抽速计算",
  estimate_leak_or_outgassing_load: "漏气与放气负载估算"
};
const LEGACY_INTERNAL_TEXT =
  /\b(?:provider|tool_call|function_call|formulaId|formulaVersion|normalizedInputs|rawArguments|system\s*prompt)\b|系统提示|内部提示|(?:x-amz|x-oss)-[a-z-]*signature|ossaccesskeyid/iu;

const answerClaimSchema = z.object({
  text: boundedText,
  evidenceIds: z.array(evidenceId).max(12)
});

const answerEvidenceSchema = z.object({
  claim: boundedText,
  evidenceIds: z.array(evidenceId).min(1).max(12)
});

export const answerV2Schema = z.object({
  schemaVersion: z.literal("openvac.answer.v2"),
  answerKind: z.enum([
    "grounded",
    "general_guidance",
    "clarification",
    "safe_refusal"
  ]),
  conclusion: z.array(answerClaimSchema).min(1).max(8),
  assumptions: z.array(boundedText).max(16),
  evidence: z.array(answerEvidenceSchema).max(20),
  missingInputs: z.array(boundedText).max(16),
  nextSteps: z.array(boundedText).max(16),
  calculationRefs: z.array(z.string().trim().min(1).max(100)).max(12)
});

export const ANSWER_V2_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "answerKind",
    "conclusion",
    "assumptions",
    "evidence",
    "missingInputs",
    "nextSteps",
    "calculationRefs"
  ],
  properties: {
    schemaVersion: { type: "string", const: "openvac.answer.v2" },
    answerKind: {
      type: "string",
      enum: ["grounded", "general_guidance", "clarification", "safe_refusal"]
    },
    conclusion: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "evidenceIds"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 4_000 },
          evidenceIds: {
            type: "array",
            maxItems: 12,
            items: { type: "string", minLength: 1, maxLength: 200 }
          }
        }
      }
    },
    assumptions: {
      type: "array",
      maxItems: 16,
      items: { type: "string", minLength: 1, maxLength: 4_000 }
    },
    evidence: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "evidenceIds"],
        properties: {
          claim: { type: "string", minLength: 1, maxLength: 4_000 },
          evidenceIds: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: { type: "string", minLength: 1, maxLength: 200 }
          }
        }
      }
    },
    missingInputs: {
      type: "array",
      maxItems: 16,
      items: { type: "string", minLength: 1, maxLength: 4_000 }
    },
    nextSteps: {
      type: "array",
      maxItems: 16,
      items: { type: "string", minLength: 1, maxLength: 4_000 }
    },
    calculationRefs: {
      type: "array",
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 100 }
    }
  }
} as const;

export type AnswerV2Validation = {
  valid: boolean;
  errors: string[];
  usedEvidenceIds: string[];
};

export function parseAnswerV2(value: unknown): AnswerV2 {
  return answerV2Schema.parse(value);
}

export function safeParseAnswerV2(value: unknown): AnswerV2 | undefined {
  const parsed = answerV2Schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function sanitizeStoredAnswerV2(answer: AnswerV2): AnswerV2 {
  const sanitize = (value: string): string => {
    let text = value;
    for (const [internalName, localizedName] of Object.entries(
      LEGACY_TOOL_LABELS
    )) {
      text = text.replaceAll(internalName, localizedName);
    }
    return LEGACY_INTERNAL_TEXT.test(text)
      ? "旧回答中的内部运行信息已隐藏。"
      : text;
  };
  return {
    ...answer,
    conclusion: answer.conclusion.map((claim) => ({
      ...claim,
      text: sanitize(claim.text)
    })),
    assumptions: answer.assumptions.map(sanitize),
    evidence: answer.evidence.map((item) => ({
      ...item,
      claim: sanitize(item.claim)
    })),
    missingInputs: answer.missingInputs.map(sanitize),
    nextSteps: answer.nextSteps.map(sanitize)
  };
}

export function validateAnswerV2(
  answer: AnswerV2,
  knownEvidenceIds: Iterable<string>
): AnswerV2Validation {
  const known = new Set(knownEvidenceIds);
  const used = new Set<string>();
  const errors: string[] = [];

  for (const item of [
    ...answer.conclusion,
    ...answer.evidence.map((entry) => ({
      text: entry.claim,
      evidenceIds: entry.evidenceIds
    }))
  ]) {
    for (const id of item.evidenceIds) {
      used.add(id);
      if (!known.has(id)) errors.push(`回答引用了未知证据 ${id}。`);
    }
  }

  if (
    answer.answerKind === "grounded" &&
    used.size === 0 &&
    answer.calculationRefs.length === 0
  ) {
    errors.push("有依据回答至少需要一个证据引用或确定性计算。");
  }
  if (
    answer.answerKind === "general_guidance" &&
    answer.evidence.some((item) => item.evidenceIds.length === 0)
  ) {
    errors.push("一般性说明中的 evidence 项必须引用已知证据或省略该项。");
  }

  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    usedEvidenceIds: [...used]
  };
}

export function answerSections(answer: AnswerV2): Array<{
  section: AnswerSectionName;
  value: AnswerSectionValue;
}> {
  return [
    { section: "conclusion", value: answer.conclusion },
    { section: "assumptions", value: answer.assumptions },
    { section: "evidence", value: answer.evidence },
    { section: "missingInputs", value: answer.missingInputs },
    { section: "nextSteps", value: answer.nextSteps }
  ];
}

export function renderAnswerV2(
  answer: AnswerV2,
  citationNumberByEvidenceId: ReadonlyMap<string, number>
): string {
  const claimText = (text: string, ids: string[]) => {
    const markers = [
      ...new Set(
        ids
          .map((id) => citationNumberByEvidenceId.get(id))
          .filter((value): value is number => value !== undefined)
      )
    ]
      .sort((left, right) => left - right)
      .map((value) => `[${value}]`)
      .join("");
    return `${text}${markers ? ` ${markers}` : ""}`;
  };

  return [
    "## 结论",
    answer.conclusion
      .map((item) => claimText(item.text, item.evidenceIds))
      .join("\n\n"),
    "## 采用的条件/假设",
    renderList(answer.assumptions, "未采用额外假设。"),
    "## 依据与来源",
    answer.evidence.length
      ? answer.evidence
          .map((item) => `- ${claimText(item.claim, item.evidenceIds)}`)
          .join("\n")
      : "暂无可核验的直接证据；以上内容仅作一般性说明。",
    "## 仍缺少的信息",
    renderList(answer.missingInputs, "当前问题无需补充信息。"),
    "## 建议下一步",
    renderList(answer.nextSteps, "如工况发生变化，请重新核对输入条件。")
  ].join("\n\n");
}

function renderList(items: string[], empty: string): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : empty;
}
