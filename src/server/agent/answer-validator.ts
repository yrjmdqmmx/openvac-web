import type { AnswerV2, RiskLevel } from "@/types/chat";

import { answerV2Schema, renderAnswerV2, validateAnswerV2 } from "./answer-v2";
import { EvidenceRegistry } from "./evidence-registry";
import { validateHighRiskAnswerBoundaries } from "./prompt";

const NUMBER_OR_STANDARD =
  /(?:\d(?:[\d.,]*\d)?\s*(?:Pa|kPa|mbar|bar|Torr|L\/s|m3\/h|m³\/h|℃|°C|K|mm|cm|m)|GB\/T|GB\s*\d|ISO\s*\d|标准(?:条文|编号)?|价格|库存|型号|极限压力|抽速)/iu;
const SPECIFIC_OR_CURRENT_QUESTION =
  /(?:\d(?:[\d.,]*\d)?\s*(?:Pa|kPa|mbar|bar|Torr|L\/s|m3\/h|m³\/h|℃|°C|K|mm|cm|m)|GB\/T|GB\s*\d|ISO\s*\d|标准(?:条文|编号|要求)|价格|库存|型号\s*[A-Z0-9][A-Z0-9._/-]*)/iu;
const SPECIFIC_PARAMETER_QUESTION =
  /(?:(?:这|该|本|某|型号).{0,30}(?:极限压力|抽速|功率|流量|温度|尺寸|效率|噪声|寿命)|(?:极限压力|抽速|功率|流量|温度|尺寸|效率|噪声|寿命).{0,16}(?:多少|多大|参数|数值|准确|能到|达到|是否))/u;
const UNSAFE_SOURCE_MARKER = /(?:https?:\/\/|www\.|\[\d+\])/iu;

export type AnswerValidationResult =
  { valid: true; answer: AnswerV2 } | { valid: false; errors: string[] };

export class AnswerValidator {
  validate(input: {
    value: unknown;
    evidence: EvidenceRegistry;
    riskLevel: RiskLevel;
    calculationIds: Set<string>;
    requiresEvidence: boolean;
  }): AnswerValidationResult {
    const parsed = answerV2Schema.safeParse(input.value);
    if (!parsed.success) {
      return {
        valid: false,
        errors: parsed.error.issues.map((issue) => issue.message)
      };
    }
    const answer = parsed.data;
    const evidenceValidation = validateAnswerV2(
      answer,
      input.evidence.list().map((entry) => entry.id)
    );
    const errors = [...evidenceValidation.errors];
    for (const id of answer.calculationRefs) {
      if (!input.calculationIds.has(id)) {
        errors.push(`Unknown calculation reference: ${id}`);
      }
    }

    const allClaimEvidenceIds = [
      ...answer.conclusion.flatMap((claim) => claim.evidenceIds),
      ...answer.evidence.flatMap((claim) => claim.evidenceIds)
    ];
    if (
      answer.answerKind === "grounded" &&
      allClaimEvidenceIds.length === 0 &&
      answer.calculationRefs.length === 0
    ) {
      errors.push("A grounded answer must cite evidence or a calculation.");
    }
    if (
      input.requiresEvidence &&
      !["clarification", "safe_refusal"].includes(answer.answerKind) &&
      allClaimEvidenceIds.length === 0 &&
      answer.calculationRefs.length === 0
    ) {
      errors.push("This question requires verified evidence.");
    }
    if (answer.answerKind === "general_guidance") {
      if (input.riskLevel === "high" || input.requiresEvidence) {
        errors.push("General guidance is not allowed for this risk profile.");
      }
    }
    if (
      input.riskLevel === "high" &&
      !["clarification", "safe_refusal"].includes(answer.answerKind) &&
      allClaimEvidenceIds.length === 0
    ) {
      errors.push("A high-risk answer requires verified evidence.");
    }

    const claims = [
      ...answer.conclusion.map((claim) => ({
        text: claim.text,
        evidenceIds: claim.evidenceIds
      })),
      ...answer.evidence.map((claim) => ({
        text: claim.claim,
        evidenceIds: claim.evidenceIds
      }))
    ];
    for (const claim of claims) {
      if (UNSAFE_SOURCE_MARKER.test(claim.text)) {
        errors.push(
          `Answer text must not create URLs or citation numbers: ${claim.text.slice(0, 80)}`
        );
      }
      if (
        (input.riskLevel === "high" || NUMBER_OR_STANDARD.test(claim.text)) &&
        claim.evidenceIds.length > 0 &&
        !input.evidence.hasVerifiedTierA(claim.evidenceIds)
      ) {
        errors.push(
          `High-risk, numeric, or standards claim lacks reviewed or runtime-verified Tier A evidence: ${claim.text.slice(0, 80)}`
        );
      }
    }

    if (input.riskLevel === "high") {
      const citationNumbers = new Map(
        input.evidence
          .list()
          .map((entry, index) => [entry.id, index + 1] as const)
      );
      const boundary = validateHighRiskAnswerBoundaries(
        renderAnswerV2(answer, citationNumbers)
      );
      if (!boundary.valid) {
        errors.push(
          `High-risk safety boundary is incomplete: ${boundary.missing.join(",")}`
        );
      }
    }

    return errors.length ? { valid: false, errors } : { valid: true, answer };
  }
}

export function requiresGroundedEvidence(question: string): boolean {
  return (
    SPECIFIC_OR_CURRENT_QUESTION.test(question) ||
    SPECIFIC_PARAMETER_QUESTION.test(question) ||
    /(?:故障(?:原因|结论|诊断)|是否安全|能否继续运行|选型|推荐.*泵|怎么买|采购)/u.test(
      question
    )
  );
}

export function buildDeterministicSafeAnswer(
  riskLevel: RiskLevel,
  reason: string
): AnswerV2 {
  if (riskLevel === "high") {
    return {
      schemaVersion: "openvac.answer.v2",
      answerKind: "safe_refusal",
      conclusion: [
        {
          text: "现有证据不足，不能给出继续运行、拆修或安全处置的确定性指令。请立即停止设备运行，并保持停机状态。",
          evidenceIds: []
        }
      ],
      assumptions: [],
      evidence: [],
      missingInputs: [reason],
      nextSteps: [
        "切断并隔离电源、气源、热源及其他危险能源，执行本单位锁定挂牌程序。",
        "联系设备制造商、本单位安全负责人或具备资质的现场人员进行核验；不要绕过联锁或带电检查。"
      ],
      calculationRefs: []
    };
  }
  return {
    schemaVersion: "openvac.answer.v2",
    answerKind: "clarification",
    conclusion: [
      { text: "现有信息不足以形成可核验的具体结论。", evidenceIds: [] }
    ],
    assumptions: [],
    evidence: [],
    missingInputs: [reason],
    nextSteps: ["补充设备型号、工况、单位和希望确认的具体问题后重试。"],
    calculationRefs: []
  };
}
