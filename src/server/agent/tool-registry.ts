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
  calculatorSchemas,
  executeCalculator,
  type CalculatorName
} from "./calculators";
import { EvidenceRegistry, inferTrustTier } from "./evidence-registry";
import { VerifiedUrlReader } from "./verified-url";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;

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
        ? [createArtifactDefinition()]
        : [])
    ];
  }

  async execute(input: {
    callId: string;
    name: string;
    arguments: string;
  }): Promise<ToolExecutionResult> {
    const isArtifactCall = input.name === "create_artifact";
    const argumentLimit = isArtifactCall
      ? MAX_ARTIFACT_SPEC_BYTES
      : MAX_ARGUMENT_BYTES;
    if (Buffer.byteLength(input.arguments, "utf8") > argumentLimit) {
      return this.output(input.callId, {
        ok: false,
        error: isArtifactCall
          ? "ARTIFACT_ARGUMENTS_TOO_LARGE"
          : "TOOL_ARGUMENTS_TOO_LARGE"
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(input.arguments);
    } catch {
      return this.output(input.callId, {
        ok: false,
        error: isArtifactCall
          ? "ARTIFACT_ARGUMENTS_JSON_INVALID"
          : "INVALID_TOOL_ARGUMENTS_JSON"
      });
    }

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = this.options?.signal
      ? AbortSignal.any([this.options.signal, timeoutSignal])
      : timeoutSignal;
    return withTimeout(
      this.executeValidated(input.callId, input.name, raw, signal),
      this.timeoutMs
    ).catch(() =>
      this.output(input.callId, {
        ok: false,
        error: "TOOL_TIMEOUT"
      })
    );
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
          [result.link]
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
    return this.output(callId, {
      ok: false,
      error: "INVALID_TOOL_ARGUMENTS",
      missingInputs: error.issues.map((issue) => issue.path.join("."))
    });
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

function createArtifactDefinition(): ResponsesFunctionTool {
  const textArray = {
    type: "array",
    maxItems: 100,
    items: { type: "string" }
  };
  return {
    type: "function",
    name: "create_artifact",
    description: "仅按用户本轮明确要求创建报告、清单或参数表产物。",
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
          enum: [
            "diagnosis_report",
            "selection_report",
            "inspection_checklist",
            "parameter_table"
          ]
        },
        title: { type: "string", minLength: 1, maxLength: 240 },
        formats: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          uniqueItems: true,
          items: { enum: ["md", "docx", "pdf", "csv"] }
        },
        summary: { type: "string", minLength: 1, maxLength: 2_000 },
        sections: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["heading", "paragraphs"],
            properties: {
              heading: { type: "string", minLength: 1, maxLength: 240 },
              paragraphs: textArray
            }
          }
        },
        tables: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["columns", "rows"],
            properties: {
              title: { type: "string", maxLength: 240 },
              columns: {
                type: "array",
                minItems: 1,
                maxItems: 32,
                items: { type: "string" }
              },
              rows: {
                type: "array",
                maxItems: 2_000,
                items: {
                  type: "array",
                  maxItems: 32,
                  items: { type: "string" }
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
