import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/server/db";
import { webDomainPolicies } from "@/server/db/schema";
import { SafeWebFetcher } from "@/server/knowledge/web-fetch";
import {
  type ResponsesProvider,
  type ResponsesStreamEvent,
  type ResponsesStreamRequest,
  type ResponsesUsage
} from "@/server/providers";
import {
  commitQuota,
  releaseQuota,
  reserveWebSearchQuota
} from "@/server/quota";
import type { SourceTrustTier } from "@/types/chat";
import type { VerifiedLinkPart } from "@/types/chat-v3";
import {
  canonicalVerifiedLinkLabel,
  VERIFIED_LINK_LABEL_FALLBACK
} from "@/server/chat-v3/verified-link-label";

import { defaultTierADomains, EvidenceRegistry } from "./evidence-registry";
import { parsePublicHttpsUrl } from "./public-url";
import { sanitizeGroundingEvidence } from "../chat/evidence";

const discoverySchema = z.object({
  candidates: z
    .array(
      z.object({
        url: z.string().url().max(2_000),
        title: z.string().trim().min(1).max(300),
        summary: z.string().trim().max(1_000).default("")
      })
    )
    .max(8)
});
const MAX_DISCOVERY_URL_CHARACTERS = 2_000;
const MAX_TEXT_DISCOVERY_CHARACTERS = 32_768;
const MAX_TEXT_URL_TOKENS = 64;

export type WebDomainPolicy = {
  domain: string;
  trustTier: SourceTrustTier;
  licenseClass:
    | "open"
    | "public_domain"
    | "metadata_only"
    | "private_authorized"
    | "unknown";
};

export type WebProviderInvocation = {
  phase: "web_discovery";
  status: "completed" | "incomplete" | "failed";
  responseId?: string;
  providerRequestId?: string;
  usage?: ResponsesUsage;
  firstEventLatencyMs?: number;
};

export type WebEvidenceResult = {
  evidenceIds: string[];
  verifiedLinks: VerifiedLinkPart[];
  searched: boolean;
  provider: "deepseek-native" | "none";
  invocations: WebProviderInvocation[];
  failureCode?:
    | "NATIVE_WEB_DISCOVERY_FAILED"
    | "NATIVE_WEB_SEARCH_COUNT_INVALID"
    | "NATIVE_WEB_CANDIDATE_PARSE_FAILED"
    | "NATIVE_WEB_CANDIDATE_MISSING"
    | "NATIVE_WEB_CANDIDATE_UNGOVERNED";
};

export class WebEvidenceService {
  constructor(
    private readonly responses: ResponsesProvider,
    private readonly evidence: EvidenceRegistry,
    private readonly streamResponses: (
      request: ResponsesStreamRequest
    ) => AsyncIterable<ResponsesStreamEvent> = (request) =>
      responses.stream(request),
    private readonly loadPolicies: () => Promise<
      WebDomainPolicy[]
    > = loadDomainPolicies
  ) {}

  async search(input: {
    question: string;
    userId: string;
    userPartition: string;
    clientRequestId: string;
    signal?: AbortSignal;
  }): Promise<WebEvidenceResult> {
    input.signal?.throwIfAborted();
    const policies = await this.loadPolicies();
    input.signal?.throwIfAborted();
    let leaseId: string | undefined;
    let committed = false;
    try {
      const reservation = await reserveWebSearchQuota({
        userId: input.userId,
        clientRequestId: `${input.clientRequestId}:web-v2`,
        metadata: { reason: "agent_v2_native_web" }
      });
      leaseId = reservation.leaseId;
      if (reservation.idempotent || reservation.status !== "reserved") {
        return {
          evidenceIds: [],
          verifiedLinks: [],
          searched: false,
          provider: "none",
          invocations: []
        };
      }
      input.signal?.throwIfAborted();
      const committedReservation = await commitQuota({
        leaseId,
        userId: input.userId
      });
      if (committedReservation.status !== "committed") {
        throw new Error("SEARCH_QUOTA_COMMIT_FAILED");
      }
      committed = true;

      let nativeFailureCode: WebEvidenceResult["failureCode"];
      const native = await this.discoverNative({ ...input, policies }).catch(
        (error: unknown) => {
          if (input.signal?.aborted) {
            throw input.signal.reason ?? error;
          }
          nativeFailureCode = nativeWebFailureCode(error);
          return undefined;
        }
      );
      if (native) return native;

      return {
        evidenceIds: [],
        verifiedLinks: [],
        searched: false,
        provider: "none",
        invocations: [],
        ...(nativeFailureCode ? { failureCode: nativeFailureCode } : {})
      };
    } finally {
      if (leaseId && !committed) {
        await releaseQuota({
          leaseId,
          userId: input.userId,
          reason: "agent_v2_search_not_started"
        }).catch(() => undefined);
      }
    }
  }

  private async discoverNative(input: {
    question: string;
    userPartition: string;
    signal?: AbortSignal;
    policies: WebDomainPolicy[];
  }): Promise<WebEvidenceResult> {
    const allowedDomains = [
      ...new Set(input.policies.map((policy) => policy.domain))
    ]
      .sort()
      .slice(0, 64);
    let outputText = "";
    let invocation: WebProviderInvocation | undefined;
    let completedSearchCalls: number | undefined;
    const annotatedSources: Array<{ url: string; title: string }> = [];
    for await (const event of this.streamResponses({
      instructions: [
        "Use web search only to discover candidate sources for the user's question.",
        "Return only URL, title, and a short neutral summary. Do not answer the question.",
        'If you emit text, use one JSON object shaped as {"candidates":[{"url":"https://...","title":"...","summary":"..."}]}.',
        "Prefer governments, regulators, standards bodies, original manufacturers, and authoritative research institutions.",
        `Only return HTTPS candidate URLs hosted on these approved authority domains: ${allowedDomains.join(", ")}.`
      ].join("\n"),
      input: input.question,
      tools: [{ type: "web_search" }],
      toolChoice: { type: "web_search" },
      reasoningEffort: "minimal",
      maxOutputTokens: 2_048,
      user: input.userPartition,
      signal: input.signal
    })) {
      if (event.type === "text-delta") outputText += event.text;
      if (event.type === "web-search-sources") {
        annotatedSources.push(...event.sources);
      }
      if (event.type === "finish") {
        outputText = event.outputText || outputText;
        invocation = {
          phase: "web_discovery",
          status: event.status,
          responseId: event.responseId,
          providerRequestId: event.providerRequestId,
          usage: event.usage,
          firstEventLatencyMs: event.firstEventLatencyMs
        };
        completedSearchCalls = event.completedWebSearchCalls;
      }
    }
    if (!invocation || invocation.status !== "completed") {
      throw new Error("NATIVE_WEB_DISCOVERY_FAILED");
    }
    if (
      !Number.isSafeInteger(completedSearchCalls) ||
      completedSearchCalls === undefined ||
      completedSearchCalls < 1 ||
      completedSearchCalls > 9
    ) {
      throw new Error("NATIVE_WEB_SEARCH_COUNT_INVALID");
    }
    let generatedCandidates: z.infer<typeof discoverySchema>["candidates"] = [];
    let candidateParseError: unknown;
    if (outputText.trim()) {
      try {
        generatedCandidates = discoverySchema.parse(
          parseJson(outputText)
        ).candidates;
      } catch (error) {
        candidateParseError = error;
      }
    }
    let accepted = governCandidates(
      [
        ...generatedCandidates,
        ...annotatedSources.map((source) => ({ ...source, summary: "" }))
      ],
      input.policies
    );
    if (accepted.length === 0 && candidateParseError) {
      const sawRawTextCandidate = hasRawTextCandidate(outputText);
      const textCandidates = [
        ...extractTextUrlCandidates(outputText),
        ...extractTextAuthorityCandidates(outputText, input.policies)
      ];
      accepted = governCandidates(textCandidates, input.policies);
      if (accepted.length === 0) {
        throw new Error(
          annotatedSources.length > 0 || sawRawTextCandidate
            ? "NATIVE_WEB_CANDIDATE_UNGOVERNED"
            : "NATIVE_WEB_CANDIDATE_MISSING"
        );
      }
    }
    const { evidenceIds, verifiedLinks } = await this.fetchCandidates(
      accepted,
      input.signal
    );
    return {
      evidenceIds,
      verifiedLinks,
      searched: true,
      provider: "deepseek-native",
      invocations: [invocation]
    };
  }

  private async fetchCandidates(
    candidates: Array<{
      title: string;
      url: string;
      summary: string;
      policy: WebDomainPolicy;
    }>,
    signal?: AbortSignal
  ): Promise<{
    evidenceIds: string[];
    verifiedLinks: VerifiedLinkPart[];
  }> {
    if (candidates.length === 0) {
      return { evidenceIds: [], verifiedLinks: [] };
    }
    const ids: string[] = [];
    const verifiedLinks: VerifiedLinkPart[] = [];
    for (const candidate of candidates.slice(0, 5)) {
      try {
        const fetcher = new SafeWebFetcher({
          allowedDomains: [candidate.policy.domain],
          maxBytes: 1_000_000,
          timeoutMs: 8_000,
          totalTimeoutMs: 12_000,
          maxRedirects: 2
        });
        const page = await fetcher.fetch(candidate.url, signal);
        const publicUrl = parsePublicHttpsUrl(page.url);
        const finalPolicy = publicUrl
          ? policyForUrl(publicUrl.href, [candidate.policy])
          : undefined;
        if (!publicUrl || !finalPolicy) continue;
        const excerpt = htmlToPlainText(page.body);
        if (excerpt.length < 80) continue;
        const excerptLimit =
          finalPolicy.licenseClass === "open" ||
          finalPolicy.licenseClass === "public_domain" ||
          finalPolicy.licenseClass === "private_authorized"
            ? 2_600
            : 480;
        const sanitizedEvidence = sanitizeGroundingEvidence(
          {
            citation: {
              sourceId: `web:${urlDigest(publicUrl.href)}`,
              title: candidate.title,
              publisher: publicUrl.hostname,
              url: publicUrl.href,
              fetchedAt: page.fetchedAt,
              licenseClass: finalPolicy.licenseClass
            },
            excerpt
          },
          excerptLimit
        );
        const finalLabel = canonicalVerifiedLinkLabel(
          sanitizedEvidence.citation.title
        );
        sanitizedEvidence.citation.title = finalLabel;
        const id = this.evidence.add(sanitizedEvidence, {
          trustTier: finalPolicy.trustTier,
          reviewStatus: "runtime_verified",
          runtimeValidated: true
        });
        if (id && !ids.includes(id)) {
          const hostname = publicUrl.hostname.toLowerCase();
          const linkId = `W${verifiedLinks.length + 1}`;
          this.evidence.bindVerifiedLink(id, linkId, hostname);
          ids.push(id);
          verifiedLinks.push({
            type: "verified_link",
            linkId,
            url: publicUrl.href,
            label: finalLabel,
            hostname,
            status: "verified",
            evidenceIds: [id]
          });
        }
      } catch {
        // Each candidate independently passes HTTPS, DNS, redirect, byte and
        // content-type checks. A rejected candidate cannot enter evidence.
      }
    }
    return { evidenceIds: ids, verifiedLinks };
  }
}

function nativeWebFailureCode(
  error: unknown
): NonNullable<WebEvidenceResult["failureCode"]> {
  if (
    error instanceof Error &&
    error.message === "NATIVE_WEB_SEARCH_COUNT_INVALID"
  ) {
    return "NATIVE_WEB_SEARCH_COUNT_INVALID";
  }
  if (
    error instanceof Error &&
    (error.message === "NATIVE_WEB_CANDIDATE_MISSING" ||
      error.message === "NATIVE_WEB_CANDIDATE_UNGOVERNED")
  ) {
    return error.message;
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return "NATIVE_WEB_CANDIDATE_PARSE_FAILED";
  }
  return "NATIVE_WEB_DISCOVERY_FAILED";
}

function governCandidates(
  candidates: Array<{ url: string; title: string; summary: string }>,
  policies: WebDomainPolicy[]
) {
  const seen = new Set<string>();
  const accepted: Array<{
    url: string;
    title: string;
    summary: string;
    policy: WebDomainPolicy;
  }> = [];
  for (const candidate of candidates) {
    if (candidate.url.length > MAX_DISCOVERY_URL_CHARACTERS) continue;
    const publicUrl = parsePublicHttpsUrl(candidate.url);
    if (
      !publicUrl ||
      publicUrl.href.length > MAX_DISCOVERY_URL_CHARACTERS ||
      seen.has(publicUrl.href)
    ) {
      continue;
    }
    const policy = policyForUrl(publicUrl.href, policies);
    if (!policy) continue;
    seen.add(publicUrl.href);
    accepted.push({
      url: publicUrl.href,
      title: sanitizeCandidateTitle(candidate.title, publicUrl),
      summary: candidate.summary.trim().slice(0, 1_000),
      policy
    });
    if (accepted.length === 8) break;
  }
  return accepted;
}

function extractTextUrlCandidates(
  value: string
): z.infer<typeof discoverySchema>["candidates"] {
  const candidates: z.infer<typeof discoverySchema>["candidates"] = [];
  const urlPattern = /https:\/\/[^\s<>"'`]+/giu;
  let inspected = 0;
  const scanValue = value.slice(
    0,
    MAX_TEXT_DISCOVERY_CHARACTERS + MAX_DISCOVERY_URL_CHARACTERS + 1
  );
  for (const match of scanValue.matchAll(urlPattern)) {
    if (
      match.index === undefined ||
      match.index >= MAX_TEXT_DISCOVERY_CHARACTERS
    ) {
      break;
    }
    inspected += 1;
    if (inspected > MAX_TEXT_URL_TOKENS) break;
    const parsed = parseTextCandidateUrl(match[0]);
    if (!parsed || candidates.some((item) => item.url === parsed.href)) {
      continue;
    }
    candidates.push({
      url: parsed.href,
      title: parsed.hostname,
      summary: ""
    });
    if (candidates.length === 32) break;
  }
  return candidates;
}

function extractTextAuthorityCandidates(
  value: string,
  policies: WebDomainPolicy[]
): z.infer<typeof discoverySchema>["candidates"] {
  const candidates: z.infer<typeof discoverySchema>["candidates"] = [];
  const seen = new Set<string>();
  const scanValue = value.slice(
    0,
    MAX_TEXT_DISCOVERY_CHARACTERS + MAX_DISCOVERY_URL_CHARACTERS + 1
  );
  let inspected = 0;
  for (const match of scanValue.matchAll(/\S+/gu)) {
    if (
      match.index === undefined ||
      match.index >= MAX_TEXT_DISCOVERY_CHARACTERS
    ) {
      break;
    }
    const token = normalizeAuthorityToken(match[0]);
    if (!token) continue;
    inspected += 1;
    if (inspected > MAX_TEXT_URL_TOKENS) break;
    const parsed = parseTextCandidateUrl(`https://${token}`);
    if (
      !parsed ||
      !policyForUrl(parsed.href, policies) ||
      seen.has(parsed.href)
    ) {
      continue;
    }
    seen.add(parsed.href);
    candidates.push({
      url: parsed.href,
      title: parsed.hostname,
      summary: ""
    });
    if (candidates.length === 32) return candidates;
  }
  return candidates;
}

function hasRawTextCandidate(value: string): boolean {
  const scanValue = value
    .slice(0, MAX_TEXT_DISCOVERY_CHARACTERS + MAX_DISCOVERY_URL_CHARACTERS + 1)
    .toLowerCase();
  if (/https?:\/\/\S+/u.test(scanValue)) return true;
  for (const match of scanValue.matchAll(/\S+/gu)) {
    const token = normalizeAuthorityToken(match[0]);
    if (!token) continue;
    try {
      const hostname = new URL(`https://${token}`).hostname.toLowerCase();
      const labels = hostname.split(".");
      if (
        labels.length >= 2 &&
        labels.every((label) => /^[a-z0-9-]{1,63}$/u.test(label)) &&
        /^[a-z]{2,63}$/u.test(labels.at(-1) ?? "")
      ) {
        return true;
      }
    } catch {
      // A malformed token is not a raw authority candidate.
    }
  }
  return false;
}

function trimAuthorityToken(value: string): string {
  const withoutOpeningWrapper = value.replace(/^[([{<"'“‘（【《]+/gu, "");
  return trimTrailingUrlPunctuation(withoutOpeningWrapper).replace(
    /[>"'”’）】》]+$/gu,
    ""
  );
}

function normalizeAuthorityToken(value: string): string | undefined {
  const token = trimAuthorityToken(value);
  if (
    !token ||
    !token.includes(".") ||
    token.includes("://") ||
    token.startsWith("//")
  ) {
    return undefined;
  }
  return token;
}

function parseTextCandidateUrl(value: string): URL | undefined {
  const trimmed = trimTrailingUrlPunctuation(value);
  if (trimmed.length > MAX_DISCOVERY_URL_CHARACTERS) return undefined;
  const parsed = parsePublicHttpsUrl(trimmed);
  return parsed && parsed.href.length <= MAX_DISCOVERY_URL_CHARACTERS
    ? parsed
    : undefined;
}

function trimTrailingUrlPunctuation(value: string): string {
  let trimmed = value.replace(/[.,;:!?，。；：！？、]+$/gu, "");
  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"]
  ] as const) {
    while (
      trimmed.endsWith(close) &&
      countCharacter(trimmed, close) > countCharacter(trimmed, open)
    ) {
      trimmed = trimmed.slice(0, -1);
    }
  }
  return trimmed;
}

function countCharacter(value: string, expected: string): number {
  let count = 0;
  for (const character of value) {
    if (character === expected) count += 1;
  }
  return count;
}

function sanitizeCandidateTitle(value: string, url: URL): string {
  const title = value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return title.toLocaleLowerCase() === url.hostname.toLocaleLowerCase()
    ? VERIFIED_LINK_LABEL_FALLBACK
    : canonicalVerifiedLinkLabel(title);
}

async function loadDomainPolicies(): Promise<WebDomainPolicy[]> {
  const configured = await db
    .select({
      domain: webDomainPolicies.domain,
      trustTier: webDomainPolicies.trustTier,
      licenseClass: webDomainPolicies.licenseClass
    })
    .from(webDomainPolicies)
    .where(eq(webDomainPolicies.enabled, true));
  const defaults: WebDomainPolicy[] = defaultTierADomains.map((domain) => ({
    domain,
    trustTier: "tier_a",
    licenseClass: domain.endsWith(".gov") ? "public_domain" : "metadata_only"
  }));
  const byDomain = new Map(defaults.map((policy) => [policy.domain, policy]));
  for (const policy of configured) {
    if (!isAllowedFinalTier(policy.trustTier)) continue;
    byDomain.set(policy.domain.toLowerCase(), {
      domain: policy.domain.toLowerCase(),
      trustTier: policy.trustTier,
      licenseClass: normalizeLicense(policy.licenseClass)
    });
  }
  return [...byDomain.values()];
}

function policyForUrl(
  url: string,
  policies: WebDomainPolicy[]
): WebDomainPolicy | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443")
  ) {
    return undefined;
  }
  const hostname = parsed.hostname.toLowerCase();
  return policies.find(
    (policy) =>
      hostname === policy.domain || hostname.endsWith(`.${policy.domain}`)
  );
}

function isAllowedFinalTier(tier: string): tier is "tier_a" | "tier_b" {
  return tier === "tier_a" || tier === "tier_b";
}

function normalizeLicense(value: string): WebDomainPolicy["licenseClass"] {
  return [
    "open",
    "public_domain",
    "metadata_only",
    "private_authorized",
    "unknown"
  ].includes(value)
    ? (value as WebDomainPolicy["licenseClass"])
    : "unknown";
}

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  return JSON.parse(unfenced);
}

function htmlToPlainText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
}

function urlDigest(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 24);
}
