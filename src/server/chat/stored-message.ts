import type {
  AnswerMeta,
  ChatMessage,
  Citation,
  RiskLevel
} from "@/types/chat";
import {
  safeParseAnswerV2,
  sanitizeStoredAnswerV2
} from "@/server/agent/answer-v2";
import { safeParseAnswerV3 } from "@/server/agent/answer-v3";
import {
  inputMessagePartsSchema,
  normalizeStoredMessageParts
} from "@/server/chat-v3/contracts";
import type { AttachmentPart, MessagePart } from "@/types/chat-v3";
import { citationSourcePolicy } from "./citation-policy";

const LICENSE_CLASSES = new Set<Citation["licenseClass"]>([
  "open",
  "public_domain",
  "metadata_only",
  "private_authorized",
  "unknown"
]);

export type StoredCitationRecord = {
  id: string;
  title: string;
  url: string | null;
  license: string | null;
  trustTier?: string | null;
  reviewStatus?: string | null;
  locator: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type StoredMessageRecord = {
  id: string;
  role: string;
  status: string;
  content: string;
  metadata: Record<string, unknown>;
  answerSchemaVersion?: string | null;
  answerPayload?: Record<string, unknown> | null;
};

export function serializeStoredCitation(
  citation: StoredCitationRecord,
  allowedDomains = process.env.WEB_SEARCH_ALLOWED_DOMAINS ??
    process.env.ALIBABA_WEB_SEARCH_ALLOWED_DOMAINS
): Citation | null {
  if (!citation.url) return null;

  const licenseClass = licenseClassValue(citation.license);
  return {
    sourceId: stringValue(citation.metadata.sourceId) ?? citation.id,
    title: citation.title,
    publisher: stringValue(citation.metadata.publisher) ?? "来源发布者未标注",
    url: citation.url,
    sourcePolicy: citationSourcePolicy(
      citation.url,
      licenseClass,
      allowedDomains
    ),
    pageOrSection: stringValue(citation.locator.pageOrSection),
    fetchedAt: isoDateValue(citation.metadata.fetchedAt),
    trustTier: trustTierValue(citation.trustTier),
    reviewStatus: reviewStatusValue(citation.reviewStatus),
    licenseClass
  };
}

export function serializeStoredMessage(
  message: StoredMessageRecord,
  citations: Citation[],
  hydratedAttachments: AttachmentPart[] = []
): ChatMessage | null {
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }

  const result: ChatMessage = {
    id: message.id,
    role: message.role,
    content:
      message.content ||
      (message.status === "failed" || message.status === "cancelled"
        ? "本次回答未完成。你可以重试；失败或取消的回答不会扣除成功回答额度。"
        : ""),
    status: messageStatusValue(message.status)
  };

  const storedParts = normalizeStoredMessageParts(
    message.content,
    message.metadata.parts
  );
  const publishedParts = [
    ...normalizeStoredMessageParts("", message.metadata.verifiedLinks),
    ...normalizeStoredMessageParts("", message.metadata.artifacts)
  ];
  const hydratedById = new Map(
    hydratedAttachments.map((attachment) => [
      attachment.attachmentId,
      attachment
    ])
  );
  const restoredParts = storedParts.map((part) =>
    part.type === "attachment"
      ? (hydratedById.get(part.attachmentId) ?? part)
      : part
  );
  result.parts = dedupeMessageParts([
    ...restoredParts,
    ...publishedParts,
    ...hydratedAttachments
  ]);

  if (message.role === "user") {
    const inputParts = inputMessagePartsSchema.safeParse(
      message.metadata.inputParts
    );
    if (inputParts.success) result.inputParts = inputParts.data;
  }

  if (message.role === "assistant") {
    if (message.status === "completed" || message.status === "incomplete") {
      result.meta = answerMetaValue(
        message.metadata,
        citations,
        message.answerPayload
      );
    } else if (message.status === "failed" || message.status === "cancelled") {
      result.meta = retryMetaValue(message.metadata);
    }
  }

  return result;
}

function dedupeMessageParts(parts: MessagePart[]): MessagePart[] {
  const seen = new Set<string>();
  return parts.filter((part, index) => {
    const key =
      part.type === "attachment"
        ? `attachment:${part.attachmentId}`
        : part.type === "artifact"
          ? `artifact:${part.artifactId}`
          : part.type === "verified_link"
            ? `link:${part.linkId}`
            : part.type === "citation"
              ? `citation:${part.sourceId}:${part.ordinal}`
              : `text:${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function answerMetaValue(
  metadata: Record<string, unknown>,
  citations: Citation[],
  answerPayload?: Record<string, unknown> | null
): AnswerMeta {
  const parsedAnswer = safeParseAnswerV2(answerPayload);
  const answer = parsedAnswer
    ? sanitizeStoredAnswerV2(parsedAnswer)
    : undefined;
  const answerV3 = safeParseAnswerV3(answerPayload);
  return {
    riskLevel: riskLevelValue(metadata.riskLevel),
    missingInputs: stringArrayValue(metadata.missingInputs),
    webSearched: metadata.webSearched === true,
    citations,
    ...(answer ? { answer } : {}),
    ...(answerV3 ? { answerV3 } : {}),
    ...(stringValue(metadata.turnId)
      ? { turnId: stringValue(metadata.turnId) }
      : {}),
    ...(stringValue(metadata.runId)
      ? { runId: stringValue(metadata.runId) }
      : {}),
    ...(positiveIntegerValue(metadata.answerVersion)
      ? { answerVersion: positiveIntegerValue(metadata.answerVersion) }
      : {}),
    ...(metadata.incomplete === true ? { incomplete: true } : {})
  };
}

function retryMetaValue(metadata: Record<string, unknown>): AnswerMeta {
  const turnId = stringValue(metadata.turnId);
  const runId = stringValue(metadata.runId);
  const answerVersion = positiveIntegerValue(metadata.answerVersion);
  return {
    riskLevel: "low",
    missingInputs: [],
    webSearched: false,
    citations: [],
    ...(turnId ? { turnId } : {}),
    ...(runId ? { runId } : {}),
    ...(answerVersion ? { answerVersion } : {})
  };
}

function riskLevelValue(value: unknown): RiskLevel {
  return value === "medium" || value === "high" ? value : "low";
}

function messageStatusValue(value: string): NonNullable<ChatMessage["status"]> {
  if (value === "completed") return "completed";
  if (value === "incomplete") return "incomplete";
  if (value === "failed" || value === "cancelled") return "error";
  return "streaming";
}

function trustTierValue(
  value: string | null | undefined
): Citation["trustTier"] {
  return value === "tier_a" ||
    value === "tier_b" ||
    value === "tier_c" ||
    value === "blocked"
    ? value
    : undefined;
}

function reviewStatusValue(
  value: string | null | undefined
): Citation["reviewStatus"] {
  return value === "reviewed" ||
    value === "pending_review" ||
    value === "rejected" ||
    value === "runtime_verified"
    ? value
    : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function licenseClassValue(value: string | null): Citation["licenseClass"] {
  return value && LICENSE_CLASSES.has(value as Citation["licenseClass"])
    ? (value as Citation["licenseClass"])
    : "unknown";
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isoDateValue(value: unknown): string {
  const parsed = stringValue(value);
  if (!parsed) return new Date(0).toISOString();
  const date = new Date(parsed);
  return Number.isNaN(date.getTime())
    ? new Date(0).toISOString()
    : date.toISOString();
}
