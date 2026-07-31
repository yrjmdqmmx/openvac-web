import type {
  AnswerMeta,
  ChatMessage,
  Citation,
  RiskLevel
} from "@/types/chat";
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
  locator: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type StoredMessageRecord = {
  id: string;
  role: string;
  status: string;
  content: string;
  metadata: Record<string, unknown>;
};

export function serializeStoredCitation(
  citation: StoredCitationRecord,
  allowedDomains = process.env.ALIBABA_WEB_SEARCH_ALLOWED_DOMAINS
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
    licenseClass
  };
}

export function serializeStoredMessage(
  message: StoredMessageRecord,
  citations: Citation[]
): ChatMessage | null {
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }

  const result: ChatMessage = {
    id: message.id,
    role: message.role,
    content: message.content,
    status: messageStatusValue(message.status)
  };

  if (message.role === "assistant" && message.status === "completed") {
    result.meta = answerMetaValue(message.metadata, citations);
  }

  return result;
}

function answerMetaValue(
  metadata: Record<string, unknown>,
  citations: Citation[]
): AnswerMeta {
  return {
    riskLevel: riskLevelValue(metadata.riskLevel),
    missingInputs: stringArrayValue(metadata.missingInputs),
    webSearched: metadata.webSearched === true,
    citations
  };
}

function riskLevelValue(value: unknown): RiskLevel {
  return value === "medium" || value === "high" ? value : "low";
}

function messageStatusValue(value: string): NonNullable<ChatMessage["status"]> {
  if (value === "completed") return "completed";
  if (value === "failed" || value === "cancelled") return "error";
  return "streaming";
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
