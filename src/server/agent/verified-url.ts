import { sanitizeEvidenceExcerpt } from "@/server/chat/evidence";
import {
  SafeWebFetcher,
  type SafeWebFetcherOptions
} from "@/server/knowledge/web-fetch";
import type { VerifiedLinkPart } from "@/types/chat-v3";

import { parsePublicHttpsUrl } from "./public-url";

const MAX_LINKS_PER_TURN = 16;
const MAX_LINK_ID_CHARACTERS = 160;
const MAX_LABEL_CHARACTERS = 240;
const MAX_BODY_CHARACTERS = 16_000;

export type CurrentTurnLink = {
  linkId: string;
  url: string;
  label?: string;
};

export type ReadVerifiedUrlInput = {
  turnId: string;
  linkId: string;
  signal?: AbortSignal;
};

export type ReadVerifiedUrlOutput = {
  link: VerifiedLinkPart;
  contentType: string;
  text: string;
};

export type VerifiedUrlErrorCode =
  | "INVALID_TURN_LINKS"
  | "LINK_NOT_ALLOWED"
  | "TURN_SCOPE_MISMATCH"
  | "VERIFIED_URL_UNAVAILABLE";

export class VerifiedUrlError extends Error {
  constructor(
    readonly code: VerifiedUrlErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "VerifiedUrlError";
  }
}

export interface VerifiedUrlReaderOptions {
  turnId: string;
  links: readonly CurrentTurnLink[];
  fetcherOptions?: Omit<SafeWebFetcherOptions, "allowedDomains">;
  createFetcher?: (allowedDomains: readonly string[]) => SafeWebFetcher;
}

/**
 * Reads only HTTPS links registered for one immutable turn. A new
 * SafeWebFetcher is created per link so redirects cannot jump to the host of a
 * different current-turn link.
 */
export class VerifiedUrlReader {
  private readonly turnId: string;
  private readonly links: ReadonlyMap<string, Required<CurrentTurnLink>>;
  private readonly createFetcher: (
    allowedDomains: readonly string[]
  ) => SafeWebFetcher;

  constructor(options: VerifiedUrlReaderOptions) {
    this.turnId = requiredText(options.turnId, 240, "turnId");
    if (
      !Array.isArray(options.links) ||
      options.links.length > MAX_LINKS_PER_TURN
    ) {
      throw new VerifiedUrlError(
        "INVALID_TURN_LINKS",
        "Current-turn links are invalid."
      );
    }
    const links = new Map<string, Required<CurrentTurnLink>>();
    for (const candidate of options.links) {
      const linkId = requiredText(
        candidate.linkId,
        MAX_LINK_ID_CHARACTERS,
        "linkId"
      );
      const parsed = parseTurnUrl(candidate.url);
      if (links.has(linkId)) {
        throw new VerifiedUrlError(
          "INVALID_TURN_LINKS",
          "Current-turn link identifiers must be unique."
        );
      }
      links.set(linkId, {
        linkId,
        url: parsed.href,
        label: safePublicLabel(candidate.label, parsed.hostname)
      });
    }
    this.links = links;
    this.createFetcher =
      options.createFetcher ??
      ((allowedDomains) =>
        new SafeWebFetcher({
          ...options.fetcherOptions,
          allowedDomains: [...allowedDomains]
        }));
  }

  async read(input: ReadVerifiedUrlInput): Promise<ReadVerifiedUrlOutput> {
    if (input.turnId !== this.turnId) {
      throw new VerifiedUrlError(
        "TURN_SCOPE_MISMATCH",
        "The link does not belong to this turn."
      );
    }
    const linkId = requiredText(input.linkId, MAX_LINK_ID_CHARACTERS, "linkId");
    const candidate = this.links.get(linkId);
    if (!candidate) {
      throw new VerifiedUrlError(
        "LINK_NOT_ALLOWED",
        "The link was not supplied in this turn."
      );
    }
    const sourceUrl = parseTurnUrl(candidate.url);
    try {
      const fetched = await this.createFetcher([sourceUrl.hostname]).fetch(
        sourceUrl,
        input.signal
      );
      const finalUrl = parseTurnUrl(fetched.url);
      const text = sanitizeEvidenceExcerpt(
        extractReadableText(fetched.body, fetched.contentType),
        MAX_BODY_CHARACTERS
      );
      if (!text.trim()) {
        throw new Error("The verified response contained no readable text.");
      }
      return {
        link: {
          type: "verified_link",
          linkId: candidate.linkId,
          url: finalUrl.href,
          label: candidate.label,
          hostname: finalUrl.hostname,
          status: "verified"
        },
        contentType: fetched.contentType,
        text
      };
    } catch (cause) {
      if (cause instanceof VerifiedUrlError) throw cause;
      throw new VerifiedUrlError(
        "VERIFIED_URL_UNAVAILABLE",
        "The current-turn link could not be verified safely.",
        { cause }
      );
    }
  }
}

function safePublicLabel(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const label = requiredText(value, MAX_LABEL_CHARACTERS, "label");
  return /(?:https?:\/\/|www\.|\b(?:provider|tool_call|function_call|system\s*prompt)\b|(?:signature|expires)=)/iu.test(
    label
  )
    ? fallback
    : label;
}

function parseTurnUrl(input: string): URL {
  const url = parsePublicHttpsUrl(input);
  if (!url) {
    throw new VerifiedUrlError(
      "INVALID_TURN_LINKS",
      "Current-turn links must use credential-free HTTPS on the default port."
    );
  }
  return url;
}

function extractReadableText(body: string, contentType: string): string {
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    return body.normalize("NFKC").trim();
  }
  return body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/\s+/gu, " ")
    .normalize("NFKC")
    .trim();
}

function requiredText(value: string, maximum: number, field: string): string {
  if (typeof value !== "string") {
    throw new VerifiedUrlError(
      "INVALID_TURN_LINKS",
      `${field} must be a string.`
    );
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum) {
    throw new VerifiedUrlError(
      "INVALID_TURN_LINKS",
      `${field} is outside the allowed length.`
    );
  }
  return normalized;
}
