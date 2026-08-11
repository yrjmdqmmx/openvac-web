import { z } from "zod";

import type {
  ResponsesFunctionTool,
  ResponsesInputItem,
  VisionProvider,
  DocumentParser
} from "@/server/providers";
import { getDocumentParser, getVisionProvider } from "@/server/providers";
import { collectLocalEvidence } from "@/server/chat/evidence";
import {
  artifactSpecBaseSchema,
  artifactSpecSchema
} from "@/server/chat-v3/contracts";
import type { CalculationResult } from "@/types/chat";
import type {
  ArtifactPart,
  ArtifactSpec,
  InputMessagePart,
  VerifiedLinkPart
} from "@/types/chat-v3";

import {
  ArtifactToolService,
  hasExplicitArtifactIntent,
  hasExplicitParameterTableIntent,
  MAX_ARTIFACT_SPEC_BYTES,
  type ArtifactStorage,
  UnconfiguredArtifactStorage
} from "./artifact-tools";
import {
  AttachmentToolService,
  type AttachmentStorage,
  UnconfiguredAttachmentStorage
} from "./attachment-tools";
import {
  hasAssumptionValueText,
  hasPhysicalUnitValue,
  inspectParameterTableSemantics
} from "./artifact-semantics";
import {
  calculatorSchemas,
  executeCalculator,
  type CalculatorName
} from "./calculators";
import { EvidenceRegistry, inferTrustTier } from "./evidence-registry";
import { VerifiedUrlReader } from "./verified-url";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ARGUMENT_BYTES = 32 * 1024;
export const MAX_ARTIFACT_ARGUMENT_BYTES = MAX_ARTIFACT_SPEC_BYTES * 8;
const MAX_RESULT_BYTES = 32 * 1024;

export const ARTIFACT_PROVIDER_LIMITS = {
  rawArgumentBytes: 24 * 1024,
  visibleCharacters: 6_000,
  titleCharacters: 120,
  summaryCharacters: 600,
  sections: 4,
  paragraphsPerSection: 4,
  paragraphCharacters: 600,
  tables: 2,
  columnsPerTable: 8,
  columnHeaderCharacters: 80,
  rowsPerTable: 64,
  totalRows: 64,
  cellCharacters: 160,
  formats: 4
} as const;

export const PARAMETER_TABLE_PROVIDER_CONTRACT_VERSION =
  "openvac.parameter-table-provider.v1";

export type ArtifactProviderContract = "parameter_table";

export const ARTIFACT_PROVIDER_INSTRUCTION = [
  "create_artifact 必须只返回一个简洁、完整的函数调用。",
  "parameter_table 必须作为整体包含至少一个真实有量纲单位，并在每行 assumptionOrCondition 中写明实质假设、适用工况或待确认状态。物理量参数必须使用真实单位；型号、品牌、泵型、配置等描述参数的 unit 只能写不适用，数量和级数只能写无量纲或计数单位，压缩比、系数和效率只能写无量纲或百分比。title 或 summary 的声明不能代替表内内容。具体假设必须来自当前输入、可信证据或确定性计算；信息不足时应明确标记待确认，不得编造具体工况。",
  "专用 parameter_table provider contract 的 rows 使用 parameter、valueOrStatus、unit、assumptionOrCondition 对象；不得添加 columns 或改成 cell 数组。",
  `原始参数不得超过 ${ARTIFACT_PROVIDER_LIMITS.rawArgumentBytes} UTF-8 字节，所有字符串合计不得超过 ${ARTIFACT_PROVIDER_LIMITS.visibleCharacters} 个 Unicode 字符。`,
  `sections 最多 ${ARTIFACT_PROVIDER_LIMITS.sections} 个，每节最多 ${ARTIFACT_PROVIDER_LIMITS.paragraphsPerSection} 段；tables 最多 ${ARTIFACT_PROVIDER_LIMITS.tables} 个，每表最多 ${ARTIFACT_PROVIDER_LIMITS.columnsPerTable} 列，所有表合计最多 ${ARTIFACT_PROVIDER_LIMITS.totalRows} 行。`,
  `段落最多 ${ARTIFACT_PROVIDER_LIMITS.paragraphCharacters} 字符，列名最多 ${ARTIFACT_PROVIDER_LIMITS.columnHeaderCharacters} 字符，单元格最多 ${ARTIFACT_PROVIDER_LIMITS.cellCharacters} 字符。`
].join(" ");

const searchKnowledgeSchema = z.object({
  query: z.string().trim().min(2).max(2_000)
});
const openEvidenceSchema = z.object({
  evidenceId: z.string().regex(/^E\d+$/)
});
const readVerifiedUrlSchema = z.object({
  linkId: z.string().regex(/^L\d+$/u)
});
const searchAttachmentSchema = z.object({
  attachmentId: z.string().uuid(),
  query: z.string().trim().min(1).max(2_000)
});
const openAttachmentExcerptSchema = z.object({
  attachmentId: z.string().uuid(),
  chunkId: z.string().trim().min(1).max(240)
});
const analyzeImageSchema = z.object({
  attachmentId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(2_000)
});
const createArtifactSchema = artifactSpecBaseSchema.omit({
  sourceTurnId: true
});

const artifactProviderTableSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(ARTIFACT_PROVIDER_LIMITS.titleCharacters)
      .optional(),
    columns: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(ARTIFACT_PROVIDER_LIMITS.columnHeaderCharacters)
      )
      .min(1)
      .max(ARTIFACT_PROVIDER_LIMITS.columnsPerTable),
    rows: z
      .array(
        z
          .array(z.string().max(ARTIFACT_PROVIDER_LIMITS.cellCharacters))
          .min(1)
          .max(ARTIFACT_PROVIDER_LIMITS.columnsPerTable)
      )
      .min(1)
      .max(ARTIFACT_PROVIDER_LIMITS.rowsPerTable)
  })
  .strict();

type NonDimensionalParameterCategory = "descriptor" | "count" | "ratio";

const nonDimensionalUnitValue =
  /^(?:无量纲|不适用|百分比|台|套|级|个|dimensionless|n\/?a|%)$/iu;
const chineseDescriptorParameter =
  /^(?:(?:推荐|候选|主泵|前级泵|增压泵|设备|泵组|真空泵|泵)?(?:型号|泵型号|泵型|类型|类别|品牌|厂商|制造商|系列|名称|配置|形式))$/u;
const chineseCountParameter =
  /^(?:(?:推荐|候选|主泵|前级泵|增压泵|设备|泵组|真空泵|泵)?(?:数量|台数|级数))$/u;
const chineseRatioParameter =
  /^(?:(?:额定|容积|机械|泵|泵组|系统|级间|总|理论|实际|综合|等熵|最大|最小))?(?:压缩比|比例|系数|效率)$/u;
const englishDescriptorParameter =
  /^(?:(?:recommended|candidate|primary|backing|booster|vacuum|pump|system)\s+)*(?:model(?:\s+(?:name|number|no\.?))?|type|category|brand|manufacturer|series|name|configuration|arrangement)$/iu;
const englishCountParameter =
  /^(?:(?:recommended|candidate|primary|backing|booster|vacuum|pump|system)\s+)*(?:count|quantity|stages?)$/iu;
const englishRatioParameter =
  /^(?:(?:recommended|candidate|primary|backing|booster|vacuum|pump|system|rated|volumetric|mechanical|isentropic|interstage|overall|total|theoretical|actual)\s+)*(?:compression\s+ratio|ratio|coefficient|efficiency)$/iu;
const allowedUnitByNonDimensionalCategory = {
  descriptor: /^(?:不适用|n\/?a)$/iu,
  count: /^(?:无量纲|台|套|级|个|dimensionless)$/iu,
  ratio: /^(?:无量纲|百分比|dimensionless|%)$/iu
} satisfies Record<NonDimensionalParameterCategory, RegExp>;

function nonDimensionalParameterCategory(
  parameter: string
): NonDimensionalParameterCategory | undefined {
  const normalized = parameter.normalize("NFKC").trim();
  const compact = normalized.replace(/\s+/gu, "");
  if (
    chineseDescriptorParameter.test(compact) ||
    englishDescriptorParameter.test(normalized)
  )
    return "descriptor";
  if (
    chineseCountParameter.test(compact) ||
    englishCountParameter.test(normalized)
  )
    return "count";
  if (
    chineseRatioParameter.test(compact) ||
    englishRatioParameter.test(normalized)
  )
    return "ratio";
  return undefined;
}

function hasDimensionalPhysicalUnitValue(unit: string): boolean {
  return (
    hasPhysicalUnitValue(unit) && !nonDimensionalUnitValue.test(unit.trim())
  );
}

const parameterTableProviderRowSchema = z
  .object({
    parameter: z
      .string()
      .trim()
      .min(1)
      .max(ARTIFACT_PROVIDER_LIMITS.cellCharacters),
    valueOrStatus: z
      .string()
      .trim()
      .min(1)
      .max(ARTIFACT_PROVIDER_LIMITS.cellCharacters),
    unit: z.string().trim().min(1).max(ARTIFACT_PROVIDER_LIMITS.cellCharacters),
    assumptionOrCondition: z
      .string()
      .trim()
      .min(1)
      .max(ARTIFACT_PROVIDER_LIMITS.cellCharacters)
  })
  .strict()
  .superRefine((row, context) => {
    const nonDimensionalCategory = nonDimensionalParameterCategory(
      row.parameter
    );
    if (
      nonDimensionalCategory === undefined &&
      !hasDimensionalPhysicalUnitValue(row.unit)
    ) {
      context.addIssue({
        code: "custom",
        path: ["unit"],
        message: "Provider physical-quantity row requires a dimensional unit."
      });
    }
    if (
      nonDimensionalCategory !== undefined &&
      !allowedUnitByNonDimensionalCategory[nonDimensionalCategory].test(
        row.unit.trim()
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["unit"],
        message: "Provider non-dimensional row has an invalid unit."
      });
    }
    if (!hasAssumptionValueText(row.assumptionOrCondition)) {
      context.addIssue({
        code: "custom",
        path: ["assumptionOrCondition"],
        message: "Provider parameter row requires an assumption or condition."
      });
    }
  });

export const parameterTableProviderSchema = z
  .object({
    contractVersion: z.literal(PARAMETER_TABLE_PROVIDER_CONTRACT_VERSION),
    title: z
      .string()
      .trim()
      .min(1)
      .max(ARTIFACT_PROVIDER_LIMITS.titleCharacters),
    formats: z
      .array(z.enum(["md", "docx", "pdf", "csv"]))
      .min(1)
      .max(ARTIFACT_PROVIDER_LIMITS.formats),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(ARTIFACT_PROVIDER_LIMITS.summaryCharacters),
    sections: z
      .array(
        z
          .object({
            heading: z
              .string()
              .trim()
              .min(1)
              .max(ARTIFACT_PROVIDER_LIMITS.titleCharacters),
            paragraphs: z
              .array(
                z
                  .string()
                  .trim()
                  .min(1)
                  .max(ARTIFACT_PROVIDER_LIMITS.paragraphCharacters)
              )
              .min(1)
              .max(ARTIFACT_PROVIDER_LIMITS.paragraphsPerSection)
          })
          .strict()
      )
      .max(ARTIFACT_PROVIDER_LIMITS.sections),
    tables: z
      .array(
        z
          .object({
            title: z
              .string()
              .trim()
              .min(1)
              .max(ARTIFACT_PROVIDER_LIMITS.titleCharacters),
            rows: z
              .array(parameterTableProviderRowSchema)
              .min(1)
              .max(ARTIFACT_PROVIDER_LIMITS.rowsPerTable)
          })
          .strict()
      )
      .min(1)
      .max(ARTIFACT_PROVIDER_LIMITS.tables)
  })
  .strict()
  .superRefine((spec, context) => {
    const totalRows = spec.tables.reduce(
      (sum, table) => sum + table.rows.length,
      0
    );
    if (totalRows > ARTIFACT_PROVIDER_LIMITS.totalRows) {
      context.addIssue({
        code: "custom",
        path: ["tables"],
        message: "Provider parameter tables exceed the total row limit."
      });
    }
    if (
      !spec.tables.some((table) =>
        table.rows.some(
          (row) =>
            nonDimensionalParameterCategory(row.parameter) === undefined &&
            hasDimensionalPhysicalUnitValue(row.unit)
        )
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["tables"],
        message:
          "Provider parameter tables require a dimensional physical-quantity row."
      });
    }
    if (
      visibleStringCharacters(spec) > ARTIFACT_PROVIDER_LIMITS.visibleCharacters
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Provider parameter-table content exceeds the visible text limit."
      });
    }
  });

export const createArtifactProviderSchema = z
  .object({
    schemaVersion: z.literal("openvac.artifact.v1"),
    kind: z.enum([
      "diagnosis_report",
      "selection_report",
      "inspection_checklist",
      "parameter_table"
    ]),
    title: z
      .string()
      .trim()
      .min(1)
      .max(ARTIFACT_PROVIDER_LIMITS.titleCharacters),
    formats: z
      .array(z.enum(["md", "docx", "pdf", "csv"]))
      .min(1)
      .max(ARTIFACT_PROVIDER_LIMITS.formats),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(ARTIFACT_PROVIDER_LIMITS.summaryCharacters),
    sections: z
      .array(
        z
          .object({
            heading: z
              .string()
              .trim()
              .min(1)
              .max(ARTIFACT_PROVIDER_LIMITS.titleCharacters),
            paragraphs: z
              .array(
                z
                  .string()
                  .trim()
                  .min(1)
                  .max(ARTIFACT_PROVIDER_LIMITS.paragraphCharacters)
              )
              .min(1)
              .max(ARTIFACT_PROVIDER_LIMITS.paragraphsPerSection)
          })
          .strict()
      )
      .max(ARTIFACT_PROVIDER_LIMITS.sections),
    tables: z
      .array(artifactProviderTableSchema)
      .max(ARTIFACT_PROVIDER_LIMITS.tables)
  })
  .strict()
  .superRefine((spec, context) => {
    const totalRows = spec.tables.reduce(
      (sum, table) => sum + table.rows.length,
      0
    );
    if (totalRows > ARTIFACT_PROVIDER_LIMITS.totalRows) {
      context.addIssue({
        code: "custom",
        path: ["tables"],
        message: "Provider artifact tables exceed the total row limit."
      });
    }
    if (
      visibleStringCharacters(spec) > ARTIFACT_PROVIDER_LIMITS.visibleCharacters
    ) {
      context.addIssue({
        code: "custom",
        message: "Provider artifact content exceeds the visible text limit."
      });
    }
  });

export function visibleStringCharacters(value: unknown): number {
  if (typeof value === "string") return Array.from(value).length;
  if (Array.isArray(value)) {
    return value.reduce(
      (total, item) => total + visibleStringCharacters(item),
      0
    );
  }
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce(
    (total, item) => total + visibleStringCharacters(item),
    0
  );
}

export function parameterTableProviderPayloadToArtifactArguments(
  input: z.infer<typeof parameterTableProviderSchema>
): z.infer<typeof createArtifactSchema> {
  return {
    schemaVersion: "openvac.artifact.v1",
    kind: "parameter_table",
    title: input.title,
    formats: [...input.formats],
    summary: input.summary,
    sections: input.sections.map((section) => ({
      heading: section.heading,
      paragraphs: [...section.paragraphs]
    })),
    tables: input.tables.map((table) => ({
      title: table.title,
      columns: ["参数", "数值或状态", "单位", "假设或工况"],
      rows: table.rows.map((row) => [
        row.parameter,
        row.valueOrStatus,
        row.unit,
        row.assumptionOrCondition
      ])
    }))
  };
}

function isParameterTableProviderPayload(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).contractVersion ===
      PARAMETER_TABLE_PROVIDER_CONTRACT_VERSION
  );
}

export type ToolExecutionResult = {
  ok: boolean;
  errorCode?: string;
  outputItem: ResponsesInputItem;
  attachmentMatches?: Array<{
    attachmentId: string;
    chunkId: string;
    evidenceId: string;
    pageNumber?: number;
  }>;
  evidenceIds: string[];
  calculations: CalculationResult[];
  verifiedLinks: VerifiedLinkPart[];
  artifacts: ArtifactPart[];
  missingInputs: string[];
};

export type ToolArgumentPreflight =
  | { ok: true; raw: unknown; artifactSpec?: ArtifactSpec }
  | { ok: false; result: ToolExecutionResult };

export type ToolRegistryOptions = {
  userId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  runId: string;
  turnId: string;
  question: string;
  inputParts: readonly InputMessagePart[];
  signal?: AbortSignal;
  attachmentStorage?: AttachmentStorage;
  artifactStorage?: ArtifactStorage;
  documentParser?: DocumentParser;
  visionProvider?: VisionProvider;
  attachmentService?: AttachmentToolService;
  artifactService?: ArtifactToolService;
  verifiedUrlReader?: VerifiedUrlReader;
  timeoutMs?: number;
};

export class ToolRegistry {
  readonly definitions: ResponsesFunctionTool[];
  readonly artifactProviderContract?: ArtifactProviderContract;
  private readonly options?: ToolRegistryOptions;
  private readonly attachmentIds: string[];
  private readonly attachmentService?: AttachmentToolService;
  private readonly artifactService?: ArtifactToolService;
  private readonly verifiedUrlReader?: VerifiedUrlReader;
  private readonly timeoutMs: number;

  private static readonly baseDefinitions: ResponsesFunctionTool[] = [
    {
      type: "function",
      name: "search_knowledge",
      description: "Search OpenVac's governed vacuum knowledge index.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string", minLength: 2, maxLength: 2000 } }
      },
      strict: true
    },
    {
      type: "function",
      name: "open_evidence_excerpt",
      description: "Read one excerpt already registered by the server.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["evidenceId"],
        properties: { evidenceId: { type: "string", pattern: "^E[0-9]+$" } }
      },
      strict: true
    },
    ...calculatorDefinitions()
  ];

  constructor(
    private readonly evidence: EvidenceRegistry,
    options?: ToolRegistryOptions
  ) {
    this.options = options;
    this.artifactProviderContract =
      options && hasExplicitParameterTableIntent(options.question)
        ? "parameter_table"
        : undefined;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attachmentIds = options
      ? options.inputParts.flatMap((part) =>
          part.type === "attachment" ? [part.attachmentId] : []
        )
      : [];
    let linkSequence = 0;
    const links = options
      ? options.inputParts.flatMap((part) =>
          part.type === "link"
            ? [
                {
                  linkId: `L${(linkSequence += 1)}`,
                  url: part.url,
                  label: part.label
                }
              ]
            : []
        )
      : [];
    this.verifiedUrlReader = options
      ? (options.verifiedUrlReader ??
        (links.length
          ? new VerifiedUrlReader({ turnId: options.turnId, links })
          : undefined))
      : undefined;
    this.attachmentService = options
      ? (options.attachmentService ??
        new AttachmentToolService({
          storage:
            options.attachmentStorage ?? new UnconfiguredAttachmentStorage(),
          parser: options.documentParser ?? getDocumentParser(),
          vision: options.visionProvider ?? getVisionProvider()
        }))
      : undefined;
    this.artifactService = options
      ? (options.artifactService ??
        new ArtifactToolService(
          options.artifactStorage ?? new UnconfiguredArtifactStorage()
        ))
      : undefined;
    this.definitions = [
      ...ToolRegistry.baseDefinitions,
      ...(this.verifiedUrlReader ? [readVerifiedUrlDefinition()] : []),
      ...(this.attachmentIds.length ? attachmentDefinitions() : []),
      ...(options && hasExplicitArtifactIntent(options.question)
        ? [
            this.artifactProviderContract === "parameter_table"
              ? createParameterTableArtifactDefinition()
              : createArtifactDefinition()
          ]
        : [])
    ];
  }

  async execute(input: {
    callId: string;
    name: string;
    arguments: string;
  }): Promise<ToolExecutionResult> {
    const preflight = this.preflight(input);
    if (!preflight.ok) return preflight.result;

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = this.options?.signal
      ? AbortSignal.any([this.options.signal, timeoutSignal])
      : timeoutSignal;
    return withTimeout(
      this.executeValidated(input.callId, input.name, preflight.raw, signal),
      this.timeoutMs
    ).catch(() =>
      this.output(input.callId, {
        ok: false,
        error: "TOOL_TIMEOUT"
      })
    );
  }

  preflight(input: {
    callId: string;
    name: string;
    arguments: string;
  }): ToolArgumentPreflight {
    const isArtifactCall = input.name === "create_artifact";
    const argumentLimit = isArtifactCall
      ? MAX_ARTIFACT_ARGUMENT_BYTES
      : MAX_ARGUMENT_BYTES;
    const argumentBytes = Buffer.byteLength(input.arguments, "utf8");
    if (argumentBytes > argumentLimit) {
      return {
        ok: false,
        result: this.output(input.callId, {
          ok: false,
          error: isArtifactCall
            ? "ARTIFACT_ARGUMENTS_TOO_LARGE"
            : "TOOL_ARGUMENTS_TOO_LARGE"
        })
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(input.arguments);
    } catch {
      return {
        ok: false,
        result: this.output(input.callId, {
          ok: false,
          error: isArtifactCall
            ? "ARTIFACT_ARGUMENTS_JSON_INVALID"
            : "INVALID_TOOL_ARGUMENTS_JSON"
        })
      };
    }
    if (isArtifactCall) {
      if (argumentBytes > ARTIFACT_PROVIDER_LIMITS.rawArgumentBytes) {
        return {
          ok: false,
          result: this.output(
            input.callId,
            {
              ok: false,
              error: "INVALID_TOOL_ARGUMENTS",
              missingInputs: ["providerEnvelope.rawArgumentBytes"]
            },
            [],
            [],
            ["providerEnvelope.rawArgumentBytes"]
          )
        };
      }
      if (this.artifactProviderContract === "parameter_table") {
        if (!isParameterTableProviderPayload(raw)) {
          return {
            ok: false,
            result: this.output(
              input.callId,
              {
                ok: false,
                error: "INVALID_TOOL_ARGUMENTS",
                missingInputs: ["parameterTable.providerContract"]
              },
              [],
              [],
              ["parameterTable.providerContract"]
            )
          };
        }
        const parameterTableParsed =
          parameterTableProviderSchema.safeParse(raw);
        if (!parameterTableParsed.success) {
          return {
            ok: false,
            result: this.invalid(input.callId, parameterTableParsed.error)
          };
        }
        raw = parameterTableProviderPayloadToArtifactArguments(
          parameterTableParsed.data
        );
      } else if (
        Boolean(raw) &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        (raw as Record<string, unknown>).kind === "parameter_table"
      ) {
        return {
          ok: false,
          result: this.output(
            input.callId,
            {
              ok: false,
              error: "INVALID_TOOL_ARGUMENTS",
              missingInputs: ["parameterTable.providerContract"]
            },
            [],
            [],
            ["parameterTable.providerContract"]
          )
        };
      }
      const providerParsed = createArtifactProviderSchema.safeParse(raw);
      if (!providerParsed.success) {
        return {
          ok: false,
          result: this.invalid(input.callId, providerParsed.error)
        };
      }
      const parsed = createArtifactSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, result: this.invalid(input.callId, parsed.error) };
      }
      if (this.options) {
        const candidate: ArtifactSpec = {
          ...parsed.data,
          sourceTurnId: this.options.turnId
        };
        const validated = artifactSpecSchema.safeParse(candidate);
        if (!validated.success) {
          return {
            ok: false,
            result: this.invalid(input.callId, validated.error)
          };
        }
        if (validated.data.kind === "parameter_table") {
          const semantics = inspectParameterTableSemantics(validated.data);
          const missingInputs = [
            ...(semantics.hasUnitValue ? [] : ["parameterTable.unit"]),
            ...(semantics.hasAssumptionValue
              ? []
              : ["parameterTable.assumption"])
          ];
          if (missingInputs.length > 0) {
            return {
              ok: false,
              result: this.output(
                input.callId,
                {
                  ok: false,
                  error: "INVALID_TOOL_ARGUMENTS",
                  missingInputs
                },
                [],
                [],
                missingInputs
              )
            };
          }
        }
        return { ok: true, raw, artifactSpec: validated.data };
      }
    }
    return { ok: true, raw };
  }

  private async executeValidated(
    callId: string,
    name: string,
    raw: unknown,
    signal: AbortSignal
  ): Promise<ToolExecutionResult> {
    if (name === "search_knowledge") {
      const parsed = searchKnowledgeSchema.safeParse(raw);
      if (!parsed.success) return this.invalid(callId, parsed.error);
      const result = await collectLocalEvidence(parsed.data.query, signal);
      const evidenceIds = result.evidence.flatMap((item) => {
        const inferred = inferTrustTier(item.citation.url);
        const id = this.evidence.add(item, {
          trustTier: inferred === "tier_a" ? "tier_a" : "tier_b",
          reviewStatus: item.citation.reviewStatus ?? "pending_review"
        });
        return id ? [id] : [];
      });
      return this.output(
        callId,
        {
          ok: true,
          retrievalMode: result.local.mode,
          evidence: this.evidence
            .modelIndex()
            .filter((item) => evidenceIds.includes(item.evidenceId))
        },
        evidenceIds
      );
    }
    if (name === "open_evidence_excerpt") {
      const parsed = openEvidenceSchema.safeParse(raw);
      if (!parsed.success) return this.invalid(callId, parsed.error);
      const entry = this.evidence
        .modelIndex()
        .find((item) => item.evidenceId === parsed.data.evidenceId);
      return this.output(
        callId,
        entry
          ? { ok: true, evidence: entry }
          : { ok: false, error: "UNKNOWN_EVIDENCE_ID" },
        entry ? [entry.evidenceId] : []
      );
    }
    if (name === "read_verified_url") {
      const parsed = readVerifiedUrlSchema.safeParse(raw);
      if (!parsed.success) return this.invalid(callId, parsed.error);
      if (!this.options || !this.verifiedUrlReader) {
        return this.output(callId, {
          ok: false,
          error: "LINK_NOT_AVAILABLE"
        });
      }
      try {
        const result = await this.verifiedUrlReader.read({
          turnId: this.options.turnId,
          linkId: parsed.data.linkId,
          signal
        });
        const evidenceId = this.evidence.addPrivate({
          sourceId: `turn-link:${this.options.turnId}:${result.link.linkId}`,
          title: result.link.label,
          publisher: result.link.hostname,
          excerpt: result.text,
          reviewStatus: "runtime_verified",
          runtimeValidated: true
        });
        this.evidence.bindVerifiedLink(
          evidenceId,
          result.link.linkId,
          result.link.hostname
        );
        const verifiedLink = {
          ...result.link,
          evidenceIds: [evidenceId]
        };
        return this.output(
          callId,
          {
            ok: true,
            linkId: result.link.linkId,
            evidence: this.evidence
              .modelIndex()
              .filter((entry) => entry.evidenceId === evidenceId)
          },
          [evidenceId],
          [],
          [],
          [verifiedLink]
        );
      } catch (error) {
        return this.output(callId, {
          ok: false,
          error: toolErrorCode(error)
        });
      }
    }
    if (name === "search_attachment") {
      const parsed = searchAttachmentSchema.safeParse(raw);
      if (!parsed.success) return this.invalid(callId, parsed.error);
      if (!this.options || !this.attachmentService) {
        return this.output(callId, {
          ok: false,
          error: "ATTACHMENT_NOT_AVAILABLE"
        });
      }
      try {
        const result = await this.attachmentService.search({
          userId: this.options.userId,
          conversationId: this.options.conversationId,
          messageId: this.options.userMessageId,
          allowedAttachmentIds: this.attachmentIds,
          ...parsed.data,
          signal
        });
        const evidenceIds = result.matches.map((match) =>
          this.evidence.addPrivate({
            sourceId: `attachment:${result.attachmentId}:${match.chunkId}`,
            title: "私有附件摘录",
            excerpt: match.excerpt,
            locator:
              match.pageNumber === undefined
                ? match.chunkId
                : `第 ${match.pageNumber} 页`
          })
        );
        const attachmentMatches = result.matches.map((match, index) => ({
          attachmentId: result.attachmentId,
          chunkId: match.chunkId,
          evidenceId: evidenceIds[index]!,
          ...(match.pageNumber === undefined
            ? {}
            : { pageNumber: match.pageNumber })
        }));
        const output = this.output(
          callId,
          {
            ok: true,
            matches: attachmentMatches,
            evidence: this.evidence
              .modelIndex()
              .filter((entry) => evidenceIds.includes(entry.evidenceId))
          },
          evidenceIds
        );
        return output.ok ? { ...output, attachmentMatches } : output;
      } catch (error) {
        return this.output(callId, {
          ok: false,
          error: toolErrorCode(error)
        });
      }
    }
    if (name === "open_attachment_excerpt") {
      const parsed = openAttachmentExcerptSchema.safeParse(raw);
      if (!parsed.success) return this.invalid(callId, parsed.error);
      if (!this.options || !this.attachmentService) {
        return this.output(callId, {
          ok: false,
          error: "ATTACHMENT_NOT_AVAILABLE"
        });
      }
      try {
        const result = await this.attachmentService.open({
          userId: this.options.userId,
          conversationId: this.options.conversationId,
          messageId: this.options.userMessageId,
          allowedAttachmentIds: this.attachmentIds,
          ...parsed.data,
          signal
        });
        const evidenceId = this.evidence.addPrivate({
          sourceId: `attachment:${result.attachmentId}:${result.chunkId}`,
          title: "私有附件摘录",
          excerpt: result.excerpt,
          locator:
            result.pageNumber === undefined
              ? result.chunkId
              : `第 ${result.pageNumber} 页`
        });
        return this.output(
          callId,
          {
            ok: true,
            evidence: this.evidence
              .modelIndex()
              .filter((entry) => entry.evidenceId === evidenceId)
          },
          [evidenceId]
        );
      } catch (error) {
        return this.output(callId, {
          ok: false,
          error: toolErrorCode(error)
        });
      }
    }
    if (name === "analyze_image") {
      const parsed = analyzeImageSchema.safeParse(raw);
      if (!parsed.success) return this.invalid(callId, parsed.error);
      if (!this.options || !this.attachmentService) {
        return this.output(callId, {
          ok: false,
          error: "ATTACHMENT_NOT_AVAILABLE"
        });
      }
      try {
        const result = await this.attachmentService.analyze({
          userId: this.options.userId,
          conversationId: this.options.conversationId,
          messageId: this.options.userMessageId,
          allowedAttachmentIds: this.attachmentIds,
          ...parsed.data,
          signal
        });
        const evidenceId = this.evidence.addPrivate({
          sourceId: `image-analysis:${result.attachmentId}`,
          title: "私有图片分析",
          excerpt: result.analysis
        });
        return this.output(
          callId,
          {
            ok: true,
            evidence: this.evidence
              .modelIndex()
              .filter((entry) => entry.evidenceId === evidenceId)
          },
          [evidenceId]
        );
      } catch (error) {
        return this.output(callId, {
          ok: false,
          error: toolErrorCode(error)
        });
      }
    }
    if (name === "create_artifact") {
      const parsed = createArtifactSchema.safeParse(raw);
      if (!parsed.success) return this.invalid(callId, parsed.error);
      if (
        !this.options ||
        !this.artifactService ||
        !hasExplicitArtifactIntent(this.options.question)
      ) {
        return this.output(callId, {
          ok: false,
          error: "ARTIFACT_INTENT_REQUIRED"
        });
      }
      try {
        const candidate: ArtifactSpec = {
          ...parsed.data,
          sourceTurnId: this.options.turnId
        };
        const validated = artifactSpecSchema.safeParse(candidate);
        if (!validated.success) return this.invalid(callId, validated.error);
        const spec = validated.data;
        const artifact = await this.artifactService.create({
          userId: this.options.userId,
          conversationId: this.options.conversationId,
          turnId: this.options.turnId,
          runId: this.options.runId,
          assistantMessageId: this.options.assistantMessageId,
          question: this.options.question,
          signal,
          spec
        });
        return this.output(
          callId,
          {
            ok: true,
            artifact: {
              artifactId: artifact.artifactId,
              title: artifact.title,
              formats: artifact.formats,
              status: artifact.status
            }
          },
          [],
          [],
          [],
          [],
          [artifact]
        );
      } catch (error) {
        return this.output(callId, {
          ok: false,
          error: toolErrorCode(error)
        });
      }
    }
    if (isCalculatorName(name)) {
      const result = executeCalculator(name, raw);
      return result.ok
        ? this.output(
            callId,
            { ok: true, calculation: result.calculation },
            [],
            [result.calculation]
          )
        : this.output(
            callId,
            {
              ok: false,
              error: "CALCULATION_INPUT_INVALID",
              missingInputs: result.missingInputs,
              warnings: result.warnings
            },
            [],
            [],
            result.missingInputs
          );
    }
    return this.output(callId, { ok: false, error: "UNKNOWN_TOOL" });
  }

  private invalid(callId: string, error: z.ZodError): ToolExecutionResult {
    const missingInputs = error.issues.map((issue) => issue.path.join("."));
    return this.output(
      callId,
      {
        ok: false,
        error: "INVALID_TOOL_ARGUMENTS",
        missingInputs
      },
      [],
      [],
      missingInputs
    );
  }

  private output(
    callId: string,
    value: Record<string, unknown>,
    evidenceIds: string[] = [],
    calculations: CalculationResult[] = [],
    missingInputs: string[] = [],
    verifiedLinks: VerifiedLinkPart[] = [],
    artifacts: ArtifactPart[] = []
  ): ToolExecutionResult {
    let output = JSON.stringify(value);
    let ok = value.ok === true;
    let errorCode =
      !ok && typeof value.error === "string"
        ? value.error.slice(0, 120)
        : undefined;
    if (Buffer.byteLength(output, "utf8") > MAX_RESULT_BYTES) {
      output = JSON.stringify({ ok: false, error: "TOOL_RESULT_TOO_LARGE" });
      ok = false;
      errorCode = "TOOL_RESULT_TOO_LARGE";
      evidenceIds = [];
      calculations = [];
      verifiedLinks = [];
      artifacts = [];
      missingInputs = [];
    }
    return {
      ok,
      ...(errorCode ? { errorCode } : {}),
      outputItem: { type: "function_call_output", call_id: callId, output },
      evidenceIds,
      calculations,
      verifiedLinks,
      artifacts,
      missingInputs
    };
  }
}

function readVerifiedUrlDefinition(): ResponsesFunctionTool {
  return {
    type: "function",
    name: "read_verified_url",
    description: "读取本轮用户提供且通过服务端安全核验的 HTTPS 链接。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["linkId"],
      properties: { linkId: { type: "string", pattern: "^L[0-9]+$" } }
    },
    strict: true
  };
}

function attachmentDefinitions(): ResponsesFunctionTool[] {
  const attachmentId = { type: "string", format: "uuid" };
  return [
    {
      type: "function",
      name: "search_attachment",
      description: "在本轮私有文档附件的解析分块中搜索相关内容。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["attachmentId", "query"],
        properties: {
          attachmentId,
          query: { type: "string", minLength: 1, maxLength: 2_000 }
        }
      },
      strict: true
    },
    {
      type: "function",
      name: "open_attachment_excerpt",
      description: "打开本轮私有文档附件中已检索到的一个分块。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["attachmentId", "chunkId"],
        properties: {
          attachmentId,
          chunkId: { type: "string", minLength: 1, maxLength: 240 }
        }
      },
      strict: true
    },
    {
      type: "function",
      name: "analyze_image",
      description: "使用图像理解能力分析本轮私有 JPEG 或 PNG 附件。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["attachmentId", "prompt"],
        properties: {
          attachmentId,
          prompt: { type: "string", minLength: 1, maxLength: 2_000 }
        }
      },
      strict: true
    }
  ];
}

function createParameterTableArtifactDefinition(): ResponsesFunctionTool {
  return {
    type: "function",
    name: "create_artifact",
    description:
      "创建一个泵组或真空系统参数表。每一行必须提供参数、数值或状态、单位、以及假设或适用工况。物理量参数必须使用真实有量纲单位；型号、品牌、泵型、配置等描述参数只能用不适用，数量和级数只能用无量纲或台/套/级/个，压缩比、系数和效率只能用无量纲或百分比。整表至少包含一行真实有量纲物理参数。每行假设或工况信息不足时可标记待用户确认。服务端只做结构映射，不会补写内容；rows 不得添加 columns 或改成 cell 数组。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [
        "contractVersion",
        "title",
        "formats",
        "summary",
        "sections",
        "tables"
      ],
      properties: {
        contractVersion: {
          type: "string",
          const: PARAMETER_TABLE_PROVIDER_CONTRACT_VERSION
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: ARTIFACT_PROVIDER_LIMITS.titleCharacters
        },
        formats: {
          type: "array",
          minItems: 1,
          maxItems: ARTIFACT_PROVIDER_LIMITS.formats,
          uniqueItems: true,
          items: {
            type: "string",
            enum: ["md", "docx", "pdf", "csv"]
          }
        },
        summary: {
          type: "string",
          minLength: 1,
          maxLength: ARTIFACT_PROVIDER_LIMITS.summaryCharacters
        },
        sections: {
          type: "array",
          maxItems: ARTIFACT_PROVIDER_LIMITS.sections,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["heading", "paragraphs"],
            properties: {
              heading: {
                type: "string",
                minLength: 1,
                maxLength: ARTIFACT_PROVIDER_LIMITS.titleCharacters
              },
              paragraphs: {
                type: "array",
                minItems: 1,
                maxItems: ARTIFACT_PROVIDER_LIMITS.paragraphsPerSection,
                items: {
                  type: "string",
                  minLength: 1,
                  maxLength: ARTIFACT_PROVIDER_LIMITS.paragraphCharacters
                }
              }
            }
          }
        },
        tables: {
          type: "array",
          minItems: 1,
          maxItems: ARTIFACT_PROVIDER_LIMITS.tables,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "rows"],
            properties: {
              title: {
                type: "string",
                minLength: 1,
                maxLength: ARTIFACT_PROVIDER_LIMITS.titleCharacters
              },
              rows: {
                type: "array",
                minItems: 1,
                maxItems: ARTIFACT_PROVIDER_LIMITS.rowsPerTable,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "parameter",
                    "valueOrStatus",
                    "unit",
                    "assumptionOrCondition"
                  ],
                  properties: {
                    parameter: {
                      type: "string",
                      minLength: 1,
                      maxLength: ARTIFACT_PROVIDER_LIMITS.cellCharacters
                    },
                    valueOrStatus: {
                      type: "string",
                      minLength: 1,
                      maxLength: ARTIFACT_PROVIDER_LIMITS.cellCharacters
                    },
                    unit: {
                      type: "string",
                      minLength: 1,
                      maxLength: ARTIFACT_PROVIDER_LIMITS.cellCharacters
                    },
                    assumptionOrCondition: {
                      type: "string",
                      minLength: 1,
                      maxLength: ARTIFACT_PROVIDER_LIMITS.cellCharacters
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    strict: true
  };
}

function createArtifactDefinition(): ResponsesFunctionTool {
  const textArray = {
    type: "array",
    minItems: 1,
    maxItems: ARTIFACT_PROVIDER_LIMITS.paragraphsPerSection,
    items: {
      type: "string",
      minLength: 1,
      maxLength: ARTIFACT_PROVIDER_LIMITS.paragraphCharacters
    }
  };
  return {
    type: "function",
    name: "create_artifact",
    description: `仅按用户本轮明确要求创建报告、清单或参数表产物。sections 与 tables 至少一个非空；选择 CSV 时必须提供至少一个非空表格，且每行单元格数必须等于列数。parameter_table 必须包含真实单位值和显式假设或适用工况内容。所有表合计最多 ${ARTIFACT_PROVIDER_LIMITS.totalRows} 行，所有字符串合计最多 ${ARTIFACT_PROVIDER_LIMITS.visibleCharacters} 个 Unicode 字符。`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "kind",
        "title",
        "formats",
        "summary",
        "sections",
        "tables"
      ],
      properties: {
        schemaVersion: { type: "string", const: "openvac.artifact.v1" },
        kind: {
          type: "string",
          enum: ["diagnosis_report", "selection_report", "inspection_checklist"]
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: ARTIFACT_PROVIDER_LIMITS.titleCharacters
        },
        formats: {
          type: "array",
          minItems: 1,
          maxItems: ARTIFACT_PROVIDER_LIMITS.formats,
          uniqueItems: true,
          items: { enum: ["md", "docx", "pdf", "csv"] }
        },
        summary: {
          type: "string",
          minLength: 1,
          maxLength: ARTIFACT_PROVIDER_LIMITS.summaryCharacters
        },
        sections: {
          type: "array",
          maxItems: ARTIFACT_PROVIDER_LIMITS.sections,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["heading", "paragraphs"],
            properties: {
              heading: {
                type: "string",
                minLength: 1,
                maxLength: ARTIFACT_PROVIDER_LIMITS.titleCharacters
              },
              paragraphs: textArray
            }
          }
        },
        tables: {
          type: "array",
          maxItems: ARTIFACT_PROVIDER_LIMITS.tables,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["columns", "rows"],
            properties: {
              title: {
                type: "string",
                minLength: 1,
                maxLength: ARTIFACT_PROVIDER_LIMITS.titleCharacters
              },
              columns: {
                type: "array",
                minItems: 1,
                maxItems: ARTIFACT_PROVIDER_LIMITS.columnsPerTable,
                uniqueItems: true,
                items: {
                  type: "string",
                  minLength: 1,
                  maxLength: ARTIFACT_PROVIDER_LIMITS.columnHeaderCharacters
                }
              },
              rows: {
                type: "array",
                minItems: 1,
                maxItems: ARTIFACT_PROVIDER_LIMITS.rowsPerTable,
                items: {
                  type: "array",
                  minItems: 1,
                  maxItems: ARTIFACT_PROVIDER_LIMITS.columnsPerTable,
                  items: {
                    type: "string",
                    maxLength: ARTIFACT_PROVIDER_LIMITS.cellCharacters
                  }
                }
              }
            }
          }
        }
      }
    },
    strict: true
  };
}

function calculatorDefinitions(): ResponsesFunctionTool[] {
  const quantitySchema = {
    type: "object",
    additionalProperties: false,
    required: ["value", "unit"],
    properties: { value: { type: "number" }, unit: { type: "string" } }
  };
  const parameters: Record<CalculatorName, Record<string, unknown>> = {
    convert_vacuum_units: {
      type: "object",
      additionalProperties: false,
      required: ["quantity", "value", "fromUnit", "toUnit"],
      properties: {
        quantity: { enum: ["pressure", "pumping_speed", "throughput"] },
        value: { type: "number" },
        fromUnit: { type: "string" },
        toUnit: { type: "string" }
      }
    },
    calculate_throughput: objectSchema(["pressure", "pumpingSpeed"], {
      pressure: quantitySchema,
      pumpingSpeed: quantitySchema,
      outputUnit: { type: "string" }
    }),
    calculate_effective_pumping_speed: objectSchema(
      ["pumpSpeed", "conductance"],
      {
        pumpSpeed: quantitySchema,
        conductance: quantitySchema,
        outputUnit: { type: "string" }
      }
    ),
    estimate_pumpdown_time: objectSchema(
      ["volume", "pumpingSpeed", "initialPressure", "targetPressure"],
      {
        volume: quantitySchema,
        pumpingSpeed: quantitySchema,
        initialPressure: quantitySchema,
        targetPressure: quantitySchema,
        gasLoad: quantitySchema,
        outputUnit: { enum: ["s", "min", "h"] }
      }
    ),
    classify_flow_regime: objectSchema(
      ["meanFreePath", "characteristicLength"],
      {
        meanFreePath: quantitySchema,
        characteristicLength: quantitySchema
      }
    ),
    calculate_orifice_or_tube_conductance: objectSchema(
      ["geometry", "diameter", "regime"],
      {
        geometry: { enum: ["circular_orifice", "straight_circular_tube"] },
        diameter: quantitySchema,
        length: quantitySchema,
        regime: { enum: ["molecular", "viscous", "transition"] },
        meanPressure: quantitySchema,
        dynamicViscosityPaS: { type: "number", exclusiveMinimum: 0 },
        gas: { type: "string" },
        temperatureK: { type: "number", exclusiveMinimum: 0 },
        outputUnit: { type: "string" }
      }
    ),
    combine_parallel_pumps: objectSchema(["pumps"], {
      pumps: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: objectSchema(["speed"], {
          speed: quantitySchema,
          conductance: quantitySchema
        })
      },
      outputUnit: { type: "string" }
    }),
    estimate_leak_or_outgassing_load: objectSchema([], {
      leakRate: quantitySchema,
      outgassingRate: quantitySchema,
      surfaceArea: quantitySchema,
      outputUnit: { type: "string" }
    })
  };
  return (Object.keys(calculatorSchemas) as CalculatorName[]).map((name) => ({
    type: "function",
    name,
    description: `Run deterministic OpenVac calculation: ${name}.`,
    parameters: parameters[name],
    strict: true
  }));
}

function toolErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return "TOOL_TIMEOUT";
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code.slice(0, 120);
  }
  return "TOOL_EXECUTION_FAILED";
}

function objectSchema(required: string[], properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required, properties };
}

function isCalculatorName(name: string): name is CalculatorName {
  return Object.prototype.hasOwnProperty.call(calculatorSchemas, name);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("tool timeout")), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
