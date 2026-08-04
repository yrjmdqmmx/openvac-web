import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/server/db";
import { webDomainPolicies } from "@/server/db/schema";
import { SafeWebFetcher } from "@/server/knowledge/web-fetch";
import {
  getWebSearchProvider,
  type ResponsesProvider,
  type ResponsesStreamEvent,
  type ResponsesStreamRequest,
  type ResponsesUsage,
  type WebSearchResult,
  type WebSearchSource
} from "@/server/providers";
import {
  commitQuota,
  releaseQuota,
  reserveWebSearchQuota
} from "@/server/quota";
import type { SourceTrustTier } from "@/types/chat";

import { defaultTierADomains, EvidenceRegistry } from "./evidence-registry";
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

const DISCOVERY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "title", "summary"],
        properties: {
          url: { type: "string", maxLength: 2_000 },
          title: { type: "string", maxLength: 300 },
          summary: { type: "string", maxLength: 1_000 }
        }
      }
    }
  }
};

type DomainPolicy = {
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
  searched: boolean;
  provider: "deepseek-native" | "alibaba-fallback" | "none";
  invocations: WebProviderInvocation[];
};

export class WebEvidenceService {
  constructor(
    private readonly responses: ResponsesProvider,
    private readonly evidence: EvidenceRegistry,
    private readonly streamResponses: (
      request: ResponsesStreamRequest
    ) => AsyncIterable<ResponsesStreamEvent> = (request) =>
      responses.stream(request),
    private readonly observeFallback: (event: {
      status: "succeeded" | "failed";
      providerRequestId?: string;
      latencyMs: number;
      errorCode?: string;
    }) => Promise<void> = async () => undefined
  ) {}

  async search(input: {
    question: string;
    userId: string;
    userPartition: string;
    clientRequestId: string;
    signal?: AbortSignal;
  }): Promise<WebEvidenceResult> {
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
          searched: false,
          provider: "none",
          invocations: []
        };
      }
      const committedReservation = await commitQuota({
        leaseId,
        userId: input.userId
      });
      if (committedReservation.status !== "committed") {
        throw new Error("SEARCH_QUOTA_COMMIT_FAILED");
      }
      committed = true;

      const policies = await loadDomainPolicies();
      const native = await this.discoverNative({ ...input, policies }).catch(
        () => undefined
      );
      if (native && native.evidenceIds.length > 0) return native;

      const fallback = await this.searchAlibaba({ ...input, policies }).catch(
        () => undefined
      );
      return (
        fallback ?? {
          evidenceIds: [],
          searched: true,
          provider: "none",
          invocations: native?.invocations ?? []
        }
      );
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
    policies: DomainPolicy[];
  }): Promise<WebEvidenceResult> {
    let outputText = "";
    let invocation: WebProviderInvocation | undefined;
    for await (const event of this.streamResponses({
      instructions: [
        "Use web search only to discover candidate sources for the user's question.",
        "Return only URL, title, and a short neutral summary. Do not answer the question.",
        "Prefer governments, regulators, standards bodies, original manufacturers, and authoritative research institutions."
      ].join("\n"),
      input: input.question,
      tools: [{ type: "web_search" }],
      toolChoice: { type: "web_search" },
      reasoningEffort: "minimal",
      textFormat: {
        type: "json_schema",
        name: "openvac_web_candidates",
        schema: DISCOVERY_JSON_SCHEMA,
        strict: true
      },
      maxOutputTokens: 2_048,
      user: input.userPartition,
      signal: input.signal
    })) {
      if (event.type === "text-delta") outputText += event.text;
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
      }
    }
    if (!invocation || invocation.status !== "completed") {
      throw new Error("NATIVE_WEB_DISCOVERY_FAILED");
    }
    const candidates = discoverySchema.parse(parseJson(outputText)).candidates;
    const accepted = candidates.flatMap((candidate) => {
      const policy = policyForUrl(candidate.url, input.policies);
      return policy ? [{ ...candidate, policy }] : [];
    });
    const evidenceIds = await this.fetchCandidates(accepted, input.signal);
    return {
      evidenceIds,
      searched: true,
      provider: "deepseek-native",
      invocations: [invocation]
    };
  }

  private async searchAlibaba(input: {
    question: string;
    signal?: AbortSignal;
    policies: DomainPolicy[];
  }): Promise<WebEvidenceResult> {
    const startedAt = Date.now();
    let result: WebSearchResult;
    try {
      const allowedDomains = input.policies.map((policy) => policy.domain);
      result = await getWebSearchProvider().search({
        query: input.question,
        allowedDomains,
        forced: true,
        signal: input.signal
      });
      await this.observeFallback({
        status: "succeeded",
        providerRequestId: result.requestId,
        latencyMs: Date.now() - startedAt
      });
    } catch (error) {
      await this.observeFallback({
        status: "failed",
        latencyMs: Date.now() - startedAt,
        errorCode:
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "ALIBABA_SEARCH_FAILED"
      });
      throw error;
    }
    const accepted = result.sources.flatMap((source) => {
      const policy = policyForUrl(source.url, input.policies);
      return policy ? [{ ...source, summary: "", policy }] : [];
    });
    return {
      evidenceIds: await this.fetchCandidates(accepted, input.signal),
      searched: result.searched,
      provider: "alibaba-fallback",
      invocations: []
    };
  }

  private async fetchCandidates(
    candidates: Array<
      Pick<WebSearchSource, "title" | "url"> & {
        summary: string;
        policy: DomainPolicy;
      }
    >,
    signal?: AbortSignal
  ): Promise<string[]> {
    if (candidates.length === 0) return [];
    const fetcher = new SafeWebFetcher({
      allowedDomains: [
        ...new Set(candidates.map((item) => item.policy.domain))
      ],
      maxBytes: 1_000_000,
      timeoutMs: 8_000,
      totalTimeoutMs: 12_000,
      maxRedirects: 2
    });
    const ids: string[] = [];
    for (const candidate of candidates.slice(0, 5)) {
      try {
        const page = await fetcher.fetch(candidate.url, signal);
        const excerpt = htmlToPlainText(page.body);
        if (excerpt.length < 80) continue;
        const excerptLimit =
          candidate.policy.licenseClass === "open" ||
          candidate.policy.licenseClass === "public_domain" ||
          candidate.policy.licenseClass === "private_authorized"
            ? 2_600
            : 480;
        const id = this.evidence.add(
          sanitizeGroundingEvidence(
            {
              citation: {
                sourceId: `web:${urlDigest(page.url)}`,
                title: candidate.title,
                publisher: new URL(page.url).hostname,
                url: page.url,
                fetchedAt: page.fetchedAt,
                licenseClass: candidate.policy.licenseClass
              },
              excerpt
            },
            excerptLimit
          ),
          {
            trustTier: candidate.policy.trustTier,
            reviewStatus: "runtime_verified",
            runtimeValidated: true
          }
        );
        if (id) ids.push(id);
      } catch {
        // Each candidate independently passes HTTPS, DNS, redirect, byte and
        // content-type checks. A rejected candidate cannot enter evidence.
      }
    }
    return ids;
  }
}

async function loadDomainPolicies(): Promise<DomainPolicy[]> {
  const configured = await db
    .select({
      domain: webDomainPolicies.domain,
      trustTier: webDomainPolicies.trustTier,
      licenseClass: webDomainPolicies.licenseClass
    })
    .from(webDomainPolicies)
    .where(eq(webDomainPolicies.enabled, true));
  const defaults: DomainPolicy[] = defaultTierADomains.map((domain) => ({
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
  policies: DomainPolicy[]
): DomainPolicy | undefined {
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

function normalizeLicense(value: string): DomainPolicy["licenseClass"] {
  return [
    "open",
    "public_domain",
    "metadata_only",
    "private_authorized",
    "unknown"
  ].includes(value)
    ? (value as DomainPolicy["licenseClass"])
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
