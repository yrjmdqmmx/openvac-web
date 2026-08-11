import { z } from "zod";

import type {
  AgentV3RiskLevel,
  AnswerBlock,
  AnswerV3,
  ArtifactPart
} from "@/types/chat-v3";
import type { CalculationResult } from "@/types/chat";

import { localizeCalculations } from "./calculation-localization";
import { validateHighRiskAnswerBoundaries } from "./prompt";

const visibleText = z.string().trim().min(1).max(16_000);
const shortText = z.string().trim().min(1).max(500);
const evidenceId = z.string().regex(/^E\d+$/u);
const evidenceIds = z.array(evidenceId).max(64);

export const strictAnswerBlockSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("paragraph"), text: visibleText, evidenceIds })
    .strict(),
  z
    .object({
      type: z.literal("heading"),
      level: z.union([z.literal(2), z.literal(3)]),
      text: z.string().trim().min(1).max(240)
    })
    .strict(),
  z
    .object({
      type: z.literal("list"),
      style: z.enum(["ordered", "unordered"]),
      items: z.array(shortText).min(1).max(64),
      evidenceIds
    })
    .strict(),
  z
    .object({
      type: z.literal("table"),
      columns: z.array(shortText).min(1).max(32),
      rows: z.array(z.array(shortText).max(32)).max(500),
      evidenceIds
    })
    .strict()
    .superRefine((block, context) => {
      block.rows.forEach((row, index) => {
        if (row.length !== block.columns.length) {
          context.addIssue({
            code: "custom",
            path: ["rows", index],
            message: "表格每行的单元格数量必须与列数一致。"
          });
        }
      });
    }),
  z
    .object({
      type: z.literal("code"),
      language: z.string().trim().max(40).optional(),
      code: z.string().min(1).max(64_000)
    })
    .strict(),
  z
    .object({
      type: z.literal("callout"),
      tone: z.enum(["info", "warning", "danger"]),
      title: z.string().trim().min(1).max(160).optional(),
      body: visibleText,
      evidenceIds
    })
    .strict(),
  z
    .object({
      type: z.literal("calculation"),
      calculationId: z.string().trim().min(1).max(160),
      title: z.string().trim().min(1).max(240),
      result: z.string().trim().min(1).max(500),
      unit: z.string().trim().min(1).max(80).optional(),
      assumptions: z.array(shortText).max(32),
      warnings: z.array(shortText).max(32)
    })
    .strict(),
  z
    .object({
      type: z.literal("link_reference"),
      linkId: z.string().trim().min(1).max(160),
      label: z.string().trim().min(1).max(240)
    })
    .strict(),
  z
    .object({
      type: z.literal("artifact_reference"),
      artifactId: z.string().uuid(),
      label: z.string().trim().min(1).max(240)
    })
    .strict()
]);

export const strictAnswerV3Schema = z
  .object({
    schemaVersion: z.literal("openvac.answer.v3"),
    answerKind: z.enum(["direct", "expert", "clarification", "safe_refusal"]),
    riskLevel: z.enum(["low", "medium", "high"]),
    blocks: z.array(strictAnswerBlockSchema).min(1).max(128),
    missingInputs: z.array(shortText).max(64),
    usedEvidenceIds: evidenceIds,
    usedLinkIds: z.array(z.string().trim().min(1).max(160)).max(64)
  })
  .strict();

export const answerV3Schema = strictAnswerV3Schema;

export const ANSWER_V3_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "answerKind",
    "riskLevel",
    "blocks",
    "missingInputs",
    "usedEvidenceIds",
    "usedLinkIds"
  ],
  properties: {
    schemaVersion: { type: "string", const: "openvac.answer.v3" },
    answerKind: {
      type: "string",
      enum: ["direct", "expert", "clarification", "safe_refusal"]
    },
    riskLevel: { type: "string", enum: ["low", "medium", "high"] },
    blocks: {
      type: "array",
      minItems: 1,
      maxItems: 128,
      items: {
        oneOf: [
          objectSchema(["type", "text", "evidenceIds"], {
            type: { type: "string", const: "paragraph" },
            text: textSchema(1, 16_000),
            evidenceIds: evidenceIdArraySchema()
          }),
          objectSchema(["type", "level", "text"], {
            type: { type: "string", const: "heading" },
            level: { type: "integer", enum: [2, 3] },
            text: textSchema(1, 240)
          }),
          objectSchema(["type", "style", "items", "evidenceIds"], {
            type: { type: "string", const: "list" },
            style: { type: "string", enum: ["ordered", "unordered"] },
            items: {
              type: "array",
              minItems: 1,
              maxItems: 64,
              items: textSchema(1, 500)
            },
            evidenceIds: evidenceIdArraySchema()
          }),
          objectSchema(["type", "columns", "rows", "evidenceIds"], {
            type: { type: "string", const: "table" },
            columns: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              items: textSchema(1, 500)
            },
            rows: {
              type: "array",
              maxItems: 500,
              items: {
                type: "array",
                maxItems: 32,
                items: textSchema(1, 500)
              }
            },
            evidenceIds: evidenceIdArraySchema()
          }),
          objectSchema(["type", "code"], {
            type: { type: "string", const: "code" },
            language: textSchema(1, 40),
            code: textSchema(1, 64_000)
          }),
          objectSchema(["type", "tone", "body", "evidenceIds"], {
            type: { type: "string", const: "callout" },
            tone: {
              type: "string",
              enum: ["info", "warning", "danger"]
            },
            title: textSchema(1, 160),
            body: textSchema(1, 16_000),
            evidenceIds: evidenceIdArraySchema()
          }),
          objectSchema(
            [
              "type",
              "calculationId",
              "title",
              "result",
              "assumptions",
              "warnings"
            ],
            {
              type: { type: "string", const: "calculation" },
              calculationId: textSchema(1, 160),
              title: textSchema(1, 240),
              result: textSchema(1, 500),
              unit: textSchema(1, 80),
              assumptions: {
                type: "array",
                maxItems: 32,
                items: textSchema(1, 500)
              },
              warnings: {
                type: "array",
                maxItems: 32,
                items: textSchema(1, 500)
              }
            }
          ),
          objectSchema(["type", "linkId", "label"], {
            type: { type: "string", const: "link_reference" },
            linkId: textSchema(1, 160),
            label: textSchema(1, 240)
          }),
          objectSchema(["type", "artifactId", "label"], {
            type: { type: "string", const: "artifact_reference" },
            artifactId: { type: "string", format: "uuid" },
            label: textSchema(1, 240)
          })
        ]
      }
    },
    missingInputs: {
      type: "array",
      maxItems: 64,
      items: textSchema(1, 500)
    },
    usedEvidenceIds: evidenceIdArraySchema(),
    usedLinkIds: {
      type: "array",
      maxItems: 64,
      items: textSchema(1, 160)
    }
  }
} as const;

export function answerV3JsonSchemaForRisk(
  riskLevel: AgentV3RiskLevel
): Record<string, unknown> {
  return {
    ...ANSWER_V3_JSON_SCHEMA,
    properties: {
      ...ANSWER_V3_JSON_SCHEMA.properties,
      riskLevel: { type: "string", const: riskLevel }
    }
  };
}

export type AnswerV3References = {
  evidenceIds: string[];
  linkIds: string[];
  artifactIds: string[];
  calculationIds: string[];
};

export type AnswerV3ValidationInput = {
  value: unknown;
  riskLevel?: AgentV3RiskLevel;
  question?: string;
  requiresExpert?: boolean;
  minimumLinkCount?: 0 | 1;
  knownEvidenceIds?: Iterable<string>;
  knownLinkIds?: Iterable<string>;
  knownLinkBindings?: Iterable<{
    linkId: string;
    label?: string;
    evidenceIds: Iterable<string>;
  }>;
  knownArtifactIds?: Iterable<string>;
  knownCalculationIds?: Iterable<string>;
  verifiedEvidenceIds?: Iterable<string>;
  forbiddenVisibleTerms?: Iterable<string>;
};

export type AnswerV3ValidationResult =
  | {
      valid: true;
      answer: AnswerV3;
      errors: [];
      references: AnswerV3References;
    }
  | {
      valid: false;
      errors: string[];
      references: AnswerV3References;
      answer?: AnswerV3;
    };

export function parseAnswerV3(value: unknown): AnswerV3 {
  return strictAnswerV3Schema.parse(value) as AnswerV3;
}

export function safeParseAnswerV3(value: unknown): AnswerV3 | undefined {
  const parsed = strictAnswerV3Schema.safeParse(value);
  return parsed.success ? (parsed.data as AnswerV3) : undefined;
}

export function answerV3Blocks(
  answer: AnswerV3
): Array<{ block: AnswerBlock; index: number }> {
  return answer.blocks.map((block, index) => ({ block, index }));
}

export function collectBlockEvidenceIds(block: AnswerBlock): string[] {
  return "evidenceIds" in block ? block.evidenceIds : [];
}

export function collectBlockLinkIds(block: AnswerBlock): string[] {
  return block.type === "link_reference" ? [block.linkId] : [];
}

export function collectBlockArtifactIds(block: AnswerBlock): string[] {
  return block.type === "artifact_reference" ? [block.artifactId] : [];
}

export function collectBlockCalculationIds(block: AnswerBlock): string[] {
  return block.type === "calculation" ? [block.calculationId] : [];
}

export function collectAnswerV3References(
  answer: AnswerV3
): AnswerV3References {
  return {
    evidenceIds: unique(answer.blocks.flatMap(collectBlockEvidenceIds)),
    linkIds: unique(answer.blocks.flatMap(collectBlockLinkIds)),
    artifactIds: unique(answer.blocks.flatMap(collectBlockArtifactIds)),
    calculationIds: unique(answer.blocks.flatMap(collectBlockCalculationIds))
  };
}

export function renderAnswerV3(
  answer: AnswerV3,
  citationNumberByEvidenceId: ReadonlyMap<string, number> = new Map()
): string {
  return answer.blocks
    .map((block) => renderBlock(block, citationNumberByEvidenceId))
    .filter(Boolean)
    .join("\n\n");
}

export function validateAnswerV3(
  input: AnswerV3ValidationInput
): AnswerV3ValidationResult {
  const parsed = strictAnswerV3Schema.safeParse(input.value);
  const emptyReferences: AnswerV3References = {
    evidenceIds: [],
    linkIds: [],
    artifactIds: [],
    calculationIds: []
  };
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "answer"}: ${issue.message}`
      ),
      references: emptyReferences
    };
  }

  const answer = parsed.data as AnswerV3;
  const references = collectAnswerV3References(answer);
  const errors: string[] = [];
  const blockLinkIds = answer.blocks.flatMap(collectBlockLinkIds);
  validateUniqueReferences(blockLinkIds, "link_reference", errors);
  validateUniqueReferences(answer.usedLinkIds, "usedLinkIds", errors);
  if (references.linkIds.length < (input.minimumLinkCount ?? 0)) {
    errors.push("回答必须选择至少一个已验证链接。");
  }
  const effectiveRisk = input.riskLevel ?? answer.riskLevel;
  if (answer.riskLevel !== effectiveRisk) {
    errors.push(
      `回答风险等级 ${answer.riskLevel} 与已判定等级 ${effectiveRisk} 不一致。`
    );
  }

  const expertRequired =
    effectiveRisk !== "low" ||
    input.requiresExpert === true ||
    (input.question
      ? requiresExpertAnswer(input.question, effectiveRisk)
      : false);
  if (expertRequired && answer.answerKind === "direct") {
    errors.push("中高风险或复杂问题不能使用 direct 回答。");
  }
  if (
    effectiveRisk === "high" &&
    !["expert", "clarification", "safe_refusal"].includes(answer.answerKind)
  ) {
    errors.push(
      "高风险问题只能使用 expert、clarification 或 safe_refusal 回答。"
    );
  }
  if (
    expertRequired &&
    answer.answerKind === "expert" &&
    references.evidenceIds.length === 0 &&
    references.calculationIds.length === 0
  ) {
    errors.push("复杂或中高风险 expert 回答至少需要证据或本地确定性计算。");
  }

  validateKnownReferences(
    unique([...references.evidenceIds, ...answer.usedEvidenceIds]),
    input.knownEvidenceIds,
    "证据",
    errors
  );
  validateKnownReferences(
    unique([...references.linkIds, ...answer.usedLinkIds]),
    input.knownLinkIds,
    "链接",
    errors
  );
  validateKnownReferences(
    references.artifactIds,
    input.knownArtifactIds,
    "制品",
    errors
  );
  validateKnownReferences(
    references.calculationIds,
    input.knownCalculationIds,
    "计算",
    errors
  );

  compareDeclaredReferences(
    answer.usedEvidenceIds,
    references.evidenceIds,
    "usedEvidenceIds",
    errors
  );
  compareDeclaredReferences(
    answer.usedLinkIds,
    references.linkIds,
    "usedLinkIds",
    errors
  );
  validateKnownLinkBindings(
    answer.blocks.flatMap((block) =>
      block.type === "link_reference"
        ? [{ linkId: block.linkId, label: block.label }]
        : []
    ),
    references.evidenceIds,
    input.knownLinkBindings,
    errors
  );

  const unsafeText = collectUserVisibleText(answer).find((text) =>
    UNSAFE_BODY_TEXT.test(text.normalize("NFKC"))
  );
  if (unsafeText) {
    errors.push(
      `回答正文包含 URL、内部字段或未受控引用标记：${unsafeText.slice(0, 80)}`
    );
  }
  const visibleText = collectUserVisibleText(answer)
    .join("\n")
    .normalize("NFKC");
  const leakedTerm = [...(input.forbiddenVisibleTerms ?? [])]
    .map((term) => term.normalize("NFKC").trim())
    .filter((term) => term.length >= 3)
    .find((term) =>
      visibleText.toLocaleLowerCase().includes(term.toLocaleLowerCase())
    );
  if (leakedTerm) {
    errors.push(`回答正文包含内部计算字段：${leakedTerm.slice(0, 80)}`);
  }

  if (effectiveRisk === "high" && answer.answerKind === "expert") {
    const verified = new Set(input.verifiedEvidenceIds ?? []);
    if (references.evidenceIds.length === 0) {
      errors.push("高风险 expert 回答至少需要一个已验证证据引用。");
    } else {
      const unverified = references.evidenceIds.filter(
        (id) => !verified.has(id)
      );
      if (unverified.length > 0) {
        errors.push(
          `高风险 expert 回答引用了未验证证据：${unique(unverified).join(", ")}`
        );
      }
    }
  }

  if (effectiveRisk === "high") {
    const boundary = validateHighRiskAnswerBoundaries(
      renderAnswerV3(answer, new Map())
    );
    if (!boundary.valid) {
      errors.push(`高风险安全边界不完整：${boundary.missing.join(",")}`);
    }
  }

  const deduped = unique(errors);
  return deduped.length > 0
    ? { valid: false, errors: deduped, references, answer }
    : { valid: true, answer, errors: [], references };
}

export function buildDeterministicSafeAnswerV3(
  risk: AgentV3RiskLevel | { level: AgentV3RiskLevel },
  reason: string
): AnswerV3 {
  const riskLevel = typeof risk === "string" ? risk : risk.level;
  const safeReason = sanitizeReason(reason);
  if (riskLevel === "high") {
    return {
      schemaVersion: "openvac.answer.v3",
      answerKind: "safe_refusal",
      riskLevel,
      blocks: [
        {
          type: "callout",
          tone: "danger",
          title: "先确保现场安全",
          body: "现有证据不足，不能给出确定性操作指令。请立即停机，并保持停机状态。切断并隔离电源、气源、热源及其他危险能源，执行本单位锁定挂牌程序。联系设备制造商、本单位安全负责人或具备资质的现场人员进行核验；不要绕过联锁或带电检查。",
          evidenceIds: []
        }
      ],
      missingInputs: [safeReason],
      usedEvidenceIds: [],
      usedLinkIds: []
    };
  }
  return {
    schemaVersion: "openvac.answer.v3",
    answerKind: "clarification",
    riskLevel,
    blocks: [
      {
        type: "paragraph",
        text: "现有信息不足以形成可核验的具体结论。请补充设备型号、工况、单位和希望确认的具体问题。",
        evidenceIds: []
      }
    ],
    missingInputs: [safeReason],
    usedEvidenceIds: [],
    usedLinkIds: []
  };
}

export function buildDeterministicWebUnavailableAnswerV3(
  risk: AgentV3RiskLevel | { level: AgentV3RiskLevel },
  reason: "quota_exhausted" | "no_validated_evidence" = "no_validated_evidence"
): AnswerV3 {
  const message =
    reason === "quota_exhausted"
      ? "本次 DeepSeek 联网搜索额度已用尽，无法核验需要联网确认的信息。请稍后重试。"
      : "本次 DeepSeek 联网搜索未获得可核验的来源，无法核验需要联网确认的信息。请稍后重试。";
  const fallback = buildDeterministicSafeAnswerV3(
    risk,
    reason === "quota_exhausted"
      ? "本次 DeepSeek 联网搜索额度已用尽，请稍后重试。"
      : "本次 DeepSeek 联网搜索未获得可核验的来源，请稍后重试。"
  );
  const notice = {
    type: "paragraph" as const,
    text: message,
    evidenceIds: []
  };
  return {
    ...fallback,
    blocks:
      fallback.riskLevel === "high" ? [notice, ...fallback.blocks] : [notice]
  };
}

export function buildDeterministicAttachmentScopeAnswerV3(
  question: string,
  riskLevel: AgentV3RiskLevel
): AnswerV3 | undefined {
  if (!isCrossConversationAttachmentRequest(question)) {
    return undefined;
  }
  if (riskLevel === "high") {
    const safetyAnswer = buildDeterministicSafeAnswerV3(
      riskLevel,
      "请在当前会话重新上传需要处理的附件。"
    );
    return {
      ...safetyAnswer,
      blocks: [
        {
          type: "paragraph",
          text: "附件仅限当前会话使用，不能读取、引用或使用另一个会话中的附件。请在当前会话重新上传需要处理的文件后再继续。",
          evidenceIds: []
        },
        ...safetyAnswer.blocks
      ]
    };
  }
  return {
    schemaVersion: "openvac.answer.v3",
    answerKind: "clarification",
    riskLevel,
    blocks: [
      {
        type: "paragraph",
        text: "附件仅限当前会话使用，不能读取、引用或使用另一个会话中的附件。请在当前会话重新上传需要处理的文件后再继续。",
        evidenceIds: []
      }
    ],
    missingInputs: ["请在当前会话重新上传需要处理的附件。"],
    usedEvidenceIds: [],
    usedLinkIds: []
  };
}

export function buildDeterministicCalculationAnswerV3(
  calculations: CalculationResult[],
  riskLevel: Exclude<AgentV3RiskLevel, "high"> = "low"
): AnswerV3 {
  if (calculations.length === 0) {
    throw new TypeError("At least one validated calculation is required.");
  }
  const localized = localizeCalculations(calculations);
  return {
    schemaVersion: "openvac.answer.v3",
    answerKind: riskLevel === "low" ? "direct" : "expert",
    riskLevel,
    blocks: localized.map((calculation) => ({
      type: "calculation" as const,
      ...calculation
    })),
    missingInputs: [],
    usedEvidenceIds: [],
    usedLinkIds: []
  };
}

export function buildDeterministicArtifactAnswerV3(
  artifact: ArtifactPart,
  riskLevel: Exclude<AgentV3RiskLevel, "high">,
  evidenceIds: readonly string[] = [],
  parameterTableContentVerified = false
): AnswerV3 {
  if (artifact.status !== "ready") {
    throw new TypeError(
      "Deterministic artifact answers require a ready artifact."
    );
  }
  const usedEvidenceIds = [...new Set(evidenceIds)].slice(0, 64);
  const fact =
    artifact.kind === "diagnosis_report"
      ? "产物包含诊断结论和检查参数。"
      : artifact.kind === "parameter_table"
        ? parameterTableContentVerified
          ? "参数表包含单位和假设。"
          : "参数表已按本轮要求生成。"
        : "产物已按本轮明确要求生成。";
  return {
    schemaVersion: "openvac.answer.v3",
    answerKind: usedEvidenceIds.length > 0 ? "expert" : "clarification",
    riskLevel,
    blocks: [
      {
        type: "paragraph",
        text: `${fact} 已生成“${artifact.title}”，可通过下方产物卡片预览或下载。`,
        evidenceIds: usedEvidenceIds
      },
      {
        type: "artifact_reference",
        artifactId: artifact.artifactId,
        label: artifact.title
      }
    ],
    missingInputs:
      usedEvidenceIds.length > 0
        ? []
        : ["当前没有可引用的受治理证据；产物仅整理用户明确要求的模板内容。"],
    usedEvidenceIds,
    usedLinkIds: []
  };
}

export function requiresExpertAnswer(
  question: string,
  risk: AgentV3RiskLevel | { level: AgentV3RiskLevel }
): boolean {
  const riskLevel = typeof risk === "string" ? risk : risk.level;
  if (riskLevel !== "low") return true;
  const normalized = question.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return COMPLEX_QUESTION.test(normalized);
}

export function requestsVerifiedLinkSelection(question: string): boolean {
  return question
    .normalize("NFKC")
    .split(/[，。；！？,.;!?]/u)
    .some(
      (clause) =>
        !/(?:不要|别|勿|禁止|避免)(?:(?:给出?|提供|附上|列出|展示|返回|查找|检索)\s*)?(?:任何)?\s*(?:(?:已验证|可核验|官方|厂家|来源)\s*)?(?:链接|网址|\burl\b)|(?:无需|不需要|不必)\s*(?:(?:给出?|提供)\s*)?(?:任何)?\s*(?:(?:已验证|可核验|官方|厂家|来源)\s*)?(?:链接|网址|\burl\b)|\b(?:do\s+not|don['’]t|without)\s+(?:(?:include|provide|show|list|return|find)\s+)?(?:(?:any|a|the)\s+)?(?:(?:verified|official|manufacturer|source)\s+)?(?:links?|urls?)\b|\b(?:include|provide|show|list|return|find)\s+no\s+(?:(?:verified|official|manufacturer|source)\s+)?(?:links?|urls?)\b/iu.test(
          clause
        ) &&
        /(?:给出|提供|附上|列出|展示|返回|查找|检索).{0,16}(?:已验证|可核验|官方|厂家|来源)?\s*(?:链接|网址|\burl\b)|(?:链接|网址|\burl\b).{0,8}(?:给我|发我|列出)|\b(?:provide|include|show|list|return|find)\b.{0,32}\b(?:links?|urls?)\b/iu.test(
          clause
        )
    );
}

const COMPLEX_QUESTION =
  /(?:故障(?:诊断|原因|排查)|选型|推荐(?:型号|泵)|采购|报价|库存|标准(?:条文|要求|编号)|GB\/T|ISO\s*\d|是否安全|能否继续运行|拆修|带电|联锁|抽空时间|有效抽速|流导|漏率|放气率|工程(?:设计|批准)|\d(?:[\d.,]*\d)?\s*(?:Pa|kPa|mbar|bar|Torr|L\/s|m3\/h|m³\/h|℃|°C|K|mm|cm|m))/iu;

const CROSS_CONVERSATION_ATTACHMENT = new RegExp(
  [
    String.raw`(?:另一个|其他|其它|别的|不同)(?:会话|对话)(?:的|中|内|里|中的|内的|里的|所属的)?\s*(?:附件|文件|文档|图片|表格|报告)`,
    String.raw`(?:附件|文件|文档|图片|表格|报告)(?:属于|来自|位于|在)\s*(?:另一个|其他|其它|别的|不同)(?:会话|对话)`,
    String.raw`\bcross[-\s]?(?:conversation|chat|thread)[-\s]+(?:attachment|file|document|image|spreadsheet|report)\b`,
    String.raw`\b(?:another|other|different)\s+(?:conversation|chat|thread)(?:'s|\s+)(?:attachment|file|document|image|spreadsheet|report)\b`,
    String.raw`\b(?:attachment|file|document|image|spreadsheet|report)\s+(?:from|in|belonging\s+to)\s+(?:another|other|different)\s+(?:conversation|chat|thread)\b`
  ].join("|"),
  "iu"
);
const ATTACHMENT_ACCESS =
  /(?:读取|打开|访问|查看|引用|使用|分析|总结|提取|发送|下载|\bread\b|\bopen\b|\baccess\b|\bview\b|\buse\b|\banaly[sz](?:e|ing)\b|\bsummari[sz](?:e|ing)\b|\bextract\b|\bsend\b|\bdownload\b)/iu;

function isCrossConversationAttachmentRequest(question: string): boolean {
  const normalized = question.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return (
    CROSS_CONVERSATION_ATTACHMENT.test(normalized) &&
    ATTACHMENT_ACCESS.test(normalized)
  );
}

const UNSAFE_BODY_TEXT =
  /(?:https?:\/\/|www\.|\[[0-9]+\]|\b(?:provider|tool|tool_call|function_call|formulaId|formulaVersion|normalizedInputs|rawArguments|schemaVersion|evidenceNotice|system\s*prompt)\b|系统提示|内部提示|(?:x-amz|x-oss)-[a-z-]*signature|ossaccesskeyid|(?:signature|expires)=[^\s&]+)/iu;

function renderBlock(
  block: AnswerBlock,
  citationNumbers: ReadonlyMap<string, number>
): string {
  switch (block.type) {
    case "paragraph":
      return appendCitations(block.text, block.evidenceIds, citationNumbers);
    case "heading":
      return `${"#".repeat(block.level)} ${block.text}`;
    case "list": {
      const items = block.items.map(
        (item, index) =>
          `${block.style === "ordered" ? `${index + 1}.` : "-"} ${item}`
      );
      return appendCitations(
        items.join("\n"),
        block.evidenceIds,
        citationNumbers
      );
    }
    case "table": {
      const escape = (value: string) =>
        value.replace(/\|/gu, "\\|").replace(/\n/gu, " ");
      const rows = [
        `| ${block.columns.map(escape).join(" | ")} |`,
        `| ${block.columns.map(() => "---").join(" | ")} |`,
        ...block.rows.map((row) => `| ${row.map(escape).join(" | ")} |`)
      ];
      return appendCitations(
        rows.join("\n"),
        block.evidenceIds,
        citationNumbers
      );
    }
    case "code":
      return `\`\`\`${block.language ?? ""}\n${block.code}\n\`\`\``;
    case "callout": {
      const body = appendCitations(
        block.body,
        block.evidenceIds,
        citationNumbers
      );
      return [block.title ? `> ${block.title}` : "", `> ${body}`]
        .filter(Boolean)
        .join("\n");
    }
    case "calculation":
      return [
        `### ${block.title}`,
        `结果：${block.result}${block.unit ? ` ${block.unit}` : ""}`,
        ...(block.assumptions.length
          ? ["假设：", ...block.assumptions.map((item) => `- ${item}`)]
          : []),
        ...(block.warnings.length
          ? ["注意：", ...block.warnings.map((item) => `- ${item}`)]
          : [])
      ].join("\n");
    case "link_reference":
      return block.label;
    case "artifact_reference":
      return block.label;
  }
}

function appendCitations(
  text: string,
  evidenceIds: string[],
  citationNumbers: ReadonlyMap<string, number>
): string {
  const markers = unique(
    evidenceIds.flatMap((id) => {
      const number = citationNumbers.get(id);
      return number === undefined ? [] : [`[${number}]`];
    })
  ).join("");
  return markers ? `${text} ${markers}` : text;
}

function collectUserVisibleText(answer: AnswerV3): string[] {
  return [
    ...answer.missingInputs,
    ...answer.blocks.flatMap((block): string[] => {
      switch (block.type) {
        case "paragraph":
          return [block.text];
        case "heading":
          return [block.text];
        case "list":
          return block.items;
        case "table":
          return [...block.columns, ...block.rows.flat()];
        case "code":
          return [block.language ?? "", block.code];
        case "callout":
          return [block.title ?? "", block.body];
        case "calculation":
          return [
            block.title,
            block.result,
            block.unit ?? "",
            ...block.assumptions,
            ...block.warnings
          ];
        case "link_reference":
        case "artifact_reference":
          return [block.label];
      }
    })
  ];
}

function validateKnownReferences(
  references: string[],
  knownValues: Iterable<string> | undefined,
  kind: string,
  errors: string[]
): void {
  if (knownValues === undefined) return;
  const known = new Set(knownValues);
  for (const id of references) {
    if (!known.has(id)) errors.push(`回答引用了未知${kind} ${id}。`);
  }
}

function validateKnownLinkBindings(
  linkReferences: Array<{ linkId: string; label: string }>,
  evidenceIds: string[],
  bindings:
    | Iterable<{
        linkId: string;
        label?: string;
        evidenceIds: Iterable<string>;
      }>
    | undefined,
  errors: string[]
): void {
  if (linkReferences.length === 0) return;
  if (bindings === undefined) {
    errors.push("回答中的链接缺少已验证证据绑定映射。");
    return;
  }
  const evidenceSet = new Set(evidenceIds);
  const bindingMap = new Map<
    string,
    { evidenceIds: Set<string>; label?: string }
  >();
  for (const binding of bindings) {
    const known = bindingMap.get(binding.linkId) ?? {
      evidenceIds: new Set<string>(),
      ...(binding.label === undefined ? {} : { label: binding.label })
    };
    for (const evidenceId of binding.evidenceIds) {
      known.evidenceIds.add(evidenceId);
    }
    bindingMap.set(binding.linkId, known);
  }
  for (const reference of linkReferences) {
    const binding = bindingMap.get(reference.linkId);
    if (
      !binding ||
      ![...binding.evidenceIds].some((evidenceId) =>
        evidenceSet.has(evidenceId)
      )
    ) {
      errors.push(`链接 ${reference.linkId} 未与回答引用的已验证证据绑定。`);
    }
    if (binding?.label !== undefined && reference.label !== binding.label) {
      errors.push(`链接 ${reference.linkId} 未使用服务端核验的显示标签。`);
    }
  }
}

function compareDeclaredReferences(
  declared: string[],
  collected: string[],
  field: string,
  errors: string[]
): void {
  const declaredSet = new Set(declared);
  const collectedSet = new Set(collected);
  const missing = collected.filter((id) => !declaredSet.has(id));
  const unused = declared.filter((id) => !collectedSet.has(id));
  if (missing.length > 0) {
    errors.push(`${field} 未声明正文引用：${unique(missing).join(", ")}`);
  }
  if (unused.length > 0) {
    errors.push(
      `${field} 声明了正文未使用的引用：${unique(unused).join(", ")}`
    );
  }
}

function validateUniqueReferences(
  references: string[],
  field: string,
  errors: string[]
): void {
  if (new Set(references).size !== references.length) {
    errors.push(`${field} 不得重复声明同一链接。`);
  }
}

function sanitizeReason(reason: string): string {
  const normalized = reason.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || UNSAFE_BODY_TEXT.test(normalized)) {
    return "缺少可核验的必要信息。";
  }
  return normalized.slice(0, 500);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function textSchema(minLength: number, maxLength: number) {
  return { type: "string", minLength, maxLength } as const;
}

function evidenceIdArraySchema() {
  return {
    type: "array",
    maxItems: 64,
    items: { type: "string", pattern: "^E\\d+$" }
  } as const;
}

function objectSchema<
  const Required extends readonly string[],
  const Properties extends Record<string, unknown>
>(required: Required, properties: Properties) {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties
  } as const;
}
