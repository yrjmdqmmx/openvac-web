import { hostnameAllowed, normalizeDomain } from "../providers/runtime";
import type { ModelingCard } from "@/types/chat";

export type LicenseClass =
  "open" | "public_domain" | "metadata_only" | "private_authorized" | "unknown";

export interface Citation {
  sourceId: string;
  title: string;
  publisher: string;
  url: string;
  pageOrSection?: string;
  fetchedAt: string | Date;
  licenseClass: LicenseClass;
  reviewStatus?: "reviewed" | "pending_review";
}

export interface AnswerMeta {
  riskLevel: "low" | "medium" | "high";
  missingInputs: string[];
  webSearched: boolean;
  citations: Citation[];
  modelingCards?: ModelingCard[];
}

export interface CitationValidationOptions {
  allowedDomains?: string[];
  knownSourceIds?: Iterable<string>;
  requireEveryCitationUsed?: boolean;
}

export interface CitationValidationResult {
  valid: boolean;
  errors: string[];
  usedCitationNumbers: number[];
}

export function selectCitationPrefix<T>(
  items: readonly T[],
  usedCitationNumbers: readonly number[]
): T[] {
  const lastUsed = usedCitationNumbers.reduce(
    (maximum, value) => Math.max(maximum, value),
    0
  );
  return items.slice(0, Math.min(items.length, lastUsed));
}

const CITATION_MARKER = /\[(\d+)\]/g;

export function validateCitations(
  answer: string,
  citations: Citation[],
  options: CitationValidationOptions = {}
): CitationValidationResult {
  const errors: string[] = [];
  const knownSourceIds = options.knownSourceIds
    ? new Set(options.knownSourceIds)
    : undefined;
  const allowedDomains = options.allowedDomains
    ?.map(normalizeDomain)
    .filter(Boolean);
  const seenSourceIds = new Set<string>();

  citations.forEach((citation, index) => {
    const label = `Citation ${index + 1}`;
    if (
      !citation.sourceId.trim() ||
      !citation.title.trim() ||
      !citation.publisher.trim()
    ) {
      errors.push(`${label} is missing required source metadata.`);
    }
    if (seenSourceIds.has(citation.sourceId)) {
      errors.push(`${label} duplicates sourceId ${citation.sourceId}.`);
    }
    seenSourceIds.add(citation.sourceId);
    if (knownSourceIds && !knownSourceIds.has(citation.sourceId)) {
      errors.push(`${label} references an unknown sourceId.`);
    }

    let url: URL | undefined;
    try {
      url = new URL(citation.url);
    } catch {
      errors.push(`${label} has an invalid URL.`);
    }
    if (url?.protocol !== "https:") {
      errors.push(`${label} must use HTTPS.`);
    }
    if (
      url &&
      allowedDomains?.length &&
      !hostnameAllowed(url.hostname, allowedDomains)
    ) {
      errors.push(`${label} is outside the source-domain whitelist.`);
    }
    if (!isValidDate(citation.fetchedAt)) {
      errors.push(`${label} has an invalid fetchedAt value.`);
    }
  });

  const used = new Set<number>();
  for (const match of answer.matchAll(CITATION_MARKER)) {
    const number = Number(match[1]);
    used.add(number);
    if (number < 1 || number > citations.length) {
      errors.push(`Answer references missing citation [${number}].`);
    }
  }
  if (citations.length > 0 && used.size === 0) {
    errors.push("Evidence was supplied but the answer contains no citations.");
  }
  if (options.requireEveryCitationUsed) {
    citations.forEach((_citation, index) => {
      if (!used.has(index + 1)) {
        errors.push(`Citation ${index + 1} is not referenced by the answer.`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    usedCitationNumbers: [...used].sort((left, right) => left - right)
  };
}

function isValidDate(value: string | Date): boolean {
  const date = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(date.getTime());
}
