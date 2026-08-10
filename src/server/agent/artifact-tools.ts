import { z } from "zod";

import { artifactSpecSchema } from "@/server/chat-v3/contracts";
import type {
  ArtifactFormat,
  ArtifactKind,
  ArtifactPart,
  ArtifactSpec,
  ArtifactStatus
} from "@/types/chat-v3";

const MAX_QUESTION_CHARACTERS = 16_000;
const MAX_ARTIFACT_SPEC_BYTES = 256 * 1024;
const UNSAFE_ARTIFACT_TEXT =
  /(?:https?:\/\/|www\.|\b(?:provider|tool_call|function_call|normalizedInputs|rawArguments|formulaId|formulaVersion|system\s*prompt)\b|系统提示|内部提示|(?:x-amz|x-oss)-[a-z-]*signature|ossaccesskeyid|(?:signature|expires)=[^\s&]+)/iu;

const artifactIdSchema = z.string().uuid();

export type ArtifactStorageCreateInput = {
  userId: string;
  conversationId: string;
  turnId: string;
  runId: string;
  assistantMessageId: string;
  signal?: AbortSignal;
  spec: ArtifactSpec;
};

export type StoredArtifact = {
  artifactId: string;
  userId: string;
  conversationId: string;
  sourceTurnId: string;
  kind: ArtifactKind;
  title: string;
  formats: ArtifactFormat[];
  status: ArtifactStatus;
  failureCode?: ArtifactGenerationFailureCode;
};

export type ArtifactGenerationFailureCode =
  | "ARTIFACT_RENDER_FAILED"
  | "ARTIFACT_PERSIST_FAILED"
  | "ARTIFACT_FINALIZE_FAILED"
  | "ARTIFACT_CLEANUP_FAILED"
  | "ARTIFACT_RUN_ABORTED";

export interface ArtifactStorage {
  create(input: ArtifactStorageCreateInput): Promise<StoredArtifact>;
}

export class UnconfiguredArtifactStorage implements ArtifactStorage {
  async create(): Promise<never> {
    throw new ArtifactToolError(
      "ARTIFACT_STORAGE_UNCONFIGURED",
      "Artifact storage is not configured."
    );
  }
}

export type CreateArtifactInput = ArtifactStorageCreateInput & {
  question: string;
};

export type CreateArtifactOutput = ArtifactPart;

export type ArtifactToolErrorCode =
  | "ARTIFACT_INTENT_REQUIRED"
  | "INVALID_ARTIFACT_SPEC"
  | "ARTIFACT_SCOPE_MISMATCH"
  | "ARTIFACT_STORAGE_UNCONFIGURED"
  | "ARTIFACT_GENERATION_FAILED"
  | ArtifactGenerationFailureCode;

export class ArtifactToolError extends Error {
  constructor(
    readonly code: ArtifactToolErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ArtifactToolError";
  }
}

export class ArtifactToolService {
  constructor(private readonly storage: ArtifactStorage) {}

  async create(input: CreateArtifactInput): Promise<CreateArtifactOutput> {
    const question = requiredText(
      input.question,
      MAX_QUESTION_CHARACTERS,
      "question"
    );
    const userId = requiredText(input.userId, 240, "userId");
    const conversationId = requiredText(
      input.conversationId,
      240,
      "conversationId"
    );
    const turnId = requiredText(input.turnId, 240, "turnId");
    const runId = requiredText(input.runId, 240, "runId");
    const assistantMessageId = requiredText(
      input.assistantMessageId,
      240,
      "assistantMessageId"
    );
    if (!hasExplicitArtifactIntent(question)) {
      throw new ArtifactToolError(
        "ARTIFACT_INTENT_REQUIRED",
        "Artifact creation requires an explicit user request."
      );
    }
    const parsed = artifactSpecSchema.strict().safeParse(input.spec);
    if (!parsed.success || parsed.data.sourceTurnId !== turnId) {
      throw new ArtifactToolError(
        "INVALID_ARTIFACT_SPEC",
        "The artifact specification is invalid for this turn."
      );
    }
    if (
      Buffer.byteLength(JSON.stringify(parsed.data), "utf8") >
      MAX_ARTIFACT_SPEC_BYTES
    ) {
      throw new ArtifactToolError(
        "INVALID_ARTIFACT_SPEC",
        "Artifact specification exceeds the server-side size limit."
      );
    }
    if (new Set(parsed.data.formats).size !== parsed.data.formats.length) {
      throw new ArtifactToolError(
        "INVALID_ARTIFACT_SPEC",
        "Artifact formats must be unique."
      );
    }
    if (
      artifactVisibleText(parsed.data).some((text) =>
        UNSAFE_ARTIFACT_TEXT.test(text)
      )
    ) {
      throw new ArtifactToolError(
        "INVALID_ARTIFACT_SPEC",
        "Artifact text contains an internal field or an unverified URL."
      );
    }
    const stored = await this.storage.create({
      userId,
      conversationId,
      turnId,
      runId,
      assistantMessageId,
      signal: input.signal,
      spec: parsed.data
    });
    if (
      !artifactIdSchema.safeParse(stored.artifactId).success ||
      stored.userId !== userId ||
      stored.conversationId !== conversationId ||
      stored.sourceTurnId !== turnId ||
      stored.kind !== parsed.data.kind ||
      stored.title !== parsed.data.title ||
      !sameStringSet(stored.formats, parsed.data.formats) ||
      !["generating", "ready", "failed", "deleted"].includes(stored.status)
    ) {
      throw new ArtifactToolError(
        "ARTIFACT_SCOPE_MISMATCH",
        "Stored artifact scope or metadata could not be verified."
      );
    }
    if (stored.status !== "ready") {
      throw new ArtifactToolError(
        stored.failureCode ?? "ARTIFACT_GENERATION_FAILED",
        "Artifact generation did not reach a downloadable state."
      );
    }
    return {
      type: "artifact",
      artifactId: stored.artifactId,
      kind: stored.kind,
      title: stored.title,
      formats: [...stored.formats],
      status: stored.status
    };
  }
}

function artifactVisibleText(spec: ArtifactSpec): string[] {
  return [
    spec.title,
    spec.summary,
    ...spec.sections.flatMap((section) => [
      section.heading,
      ...section.paragraphs
    ]),
    ...spec.tables.flatMap((table) => [
      table.title ?? "",
      ...table.columns,
      ...table.rows.flat()
    ])
  ];
}

/**
 * This is deliberately narrower than generic words such as "report" or
 * "table": both an imperative creation/export verb and an artifact noun must
 * occur close together.
 */
export function hasExplicitArtifactIntent(question: string): boolean {
  if (typeof question !== "string") return false;
  const normalized = question.normalize("NFKC").trim();
  if (!normalized || normalized.length > MAX_QUESTION_CHARACTERS) return false;
  if (
    /(?:不要|无需|不需要|不必|禁止|别|不得|没有|尚未).{0,12}(?:生成|创建|制作|导出|下载|整理成|写).{0,32}(?:报告|清单|检查表|参数表|表格|文档|PDF|DOCX|CSV|Markdown)/iu.test(
      normalized
    ) ||
    /(?:如何|怎么|怎样|是否|能否|可否|可不可以).{0,16}(?:生成|创建|制作|导出|下载).{0,32}(?:报告|清单|检查表|参数表|表格|文档|PDF|DOCX|CSV|Markdown)/iu.test(
      normalized
    ) ||
    /(?:do\s+not|don't|didn't|did\s+not|no\s+need\s+to|without|how\s+(?:do|can|to)|can\s+(?:you|i)).{0,32}(?:create|generate|export|download|make|produce|write).{0,48}(?:report|checklist|parameter table|document|pdf|docx|csv|markdown)/iu.test(
      normalized
    )
  ) {
    return false;
  }
  return (
    /(?:请|帮我|为我|我要|我需要|现在)?\s*(?:生成|创建|制作|导出|下载|整理成|写一份).{0,32}(?:诊断报告|选型报告|报告|检查清单|检查表|参数表|表格|文档|PDF|DOCX|CSV|Markdown)/iu.test(
      normalized
    ) ||
    /(?:诊断报告|选型报告|报告|检查清单|检查表|参数表|表格|文档|PDF|DOCX|CSV|Markdown).{0,16}(?:生成|创建|制作|导出|下载)/iu.test(
      normalized
    ) ||
    /(?:please\s+)?(?:create|generate|export|download|make|produce|write).{0,48}(?:diagnosis report|selection report|report|inspection checklist|checklist|parameter table|document|pdf|docx|csv|markdown)/iu.test(
      normalized
    )
  );
}

function requiredText(value: string, maximum: number, field: string): string {
  if (typeof value !== "string") {
    throw new ArtifactToolError(
      "INVALID_ARTIFACT_SPEC",
      `${field} must be a string.`
    );
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum) {
    throw new ArtifactToolError(
      "INVALID_ARTIFACT_SPEC",
      `${field} is outside the allowed length.`
    );
  }
  return normalized;
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  );
}
