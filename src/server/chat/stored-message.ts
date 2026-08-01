import type {
  AnswerMeta,
  ChatMessage,
  Citation,
  ModelingCard,
  RiskLevel
} from "@/types/chat";
import { citationSourcePolicy } from "./citation-policy";

const MODELING_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
  const modelingCards = serializeStoredModelingCards(metadata.modelingCards);
  return {
    riskLevel: riskLevelValue(metadata.riskLevel),
    missingInputs: stringArrayValue(metadata.missingInputs),
    webSearched: metadata.webSearched === true,
    citations,
    ...(modelingCards.length ? { modelingCards } : {})
  };
}

export function serializeStoredModelingCards(
  value: unknown,
  now = new Date()
): ModelingCard[] {
  if (!Array.isArray(value)) return [];
  const cards: ModelingCard[] = [];

  for (const item of value.slice(0, 8)) {
    if (!isRecord(item)) continue;
    const title = boundedString(item.title, 255);
    const projectId = modelingUuidValue(item.projectId);
    if (!title || !projectId) continue;

    if (item.kind === "project") {
      const description = boundedString(item.description, 2_000);
      cards.push({
        kind: "project",
        projectId,
        title,
        ...(description ? { description } : {})
      });
      continue;
    }

    if (item.kind !== "artifact") continue;
    const artifactId = modelingUuidValue(item.artifactId);
    const projectTitle = boundedString(item.projectTitle, 255);
    const format = boundedString(item.format, 12);
    const sizeBytes = item.sizeBytes;
    const expiresAt = optionalFutureIsoDate(item.expiresAt, now);
    if (
      !artifactId ||
      !projectTitle ||
      !format ||
      typeof sizeBytes !== "number" ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      expiresAt === null
    ) {
      continue;
    }
    cards.push({
      kind: "artifact",
      artifactId,
      projectId,
      title,
      projectTitle,
      format,
      sizeBytes,
      ...(expiresAt ? { expiresAt } : {})
    });
  }

  return cards;
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

function boundedString(value: unknown, maximum: number): string | undefined {
  const result = stringValue(value);
  return result && Array.from(result).length <= maximum ? result : undefined;
}

function modelingUuidValue(value: unknown): string | undefined {
  const result = stringValue(value)?.toLowerCase();
  return result && MODELING_UUID_PATTERN.test(result) ? result : undefined;
}

function optionalFutureIsoDate(
  value: unknown,
  now: Date
): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  const result = stringValue(value);
  if (!result) return null;
  const parsed = new Date(result);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
    return null;
  }
  return parsed.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoDateValue(value: unknown): string {
  const parsed = stringValue(value);
  if (!parsed) return new Date(0).toISOString();
  const date = new Date(parsed);
  return Number.isNaN(date.getTime())
    ? new Date(0).toISOString()
    : date.toISOString();
}
