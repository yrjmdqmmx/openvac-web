import type {
  Citation,
  SourceReviewStatus,
  SourceTrustTier
} from "@/types/chat";

import type { GroundingEvidence } from "./prompt";

const TIER_A_DOMAINS = [
  "nist.gov",
  "hse.gov.uk",
  "iso.org",
  "cern.ch",
  "leybold.com",
  "leybold.cn",
  "pfeiffer-vacuum.com",
  "edwardsvacuum.com",
  "buschvacuum.com",
  "atlascopco.com"
] as const;

export type RegisteredEvidence = {
  id: string;
  evidence: GroundingEvidence;
  originalSourceId: string;
  trustTier: SourceTrustTier;
  reviewStatus: SourceReviewStatus;
  runtimeValidated: boolean;
  citationVisible: boolean;
  linkId?: string;
  linkHostname?: string;
};

export class EvidenceRegistry {
  private readonly entries = new Map<string, RegisteredEvidence>();
  private readonly byOriginalSourceId = new Map<string, string>();

  add(
    evidence: GroundingEvidence,
    policy: {
      trustTier?: SourceTrustTier;
      reviewStatus?: SourceReviewStatus;
      runtimeValidated?: boolean;
    } = {}
  ): string | undefined {
    const trustTier = policy.trustTier ?? inferTrustTier(evidence.citation.url);
    if (trustTier === "tier_c" || trustTier === "blocked") return undefined;

    const existing = this.byOriginalSourceId.get(evidence.citation.sourceId);
    if (existing) return existing;
    const id = `E${this.entries.size + 1}`;
    const entry: RegisteredEvidence = {
      id,
      evidence,
      originalSourceId: evidence.citation.sourceId,
      trustTier,
      reviewStatus:
        policy.reviewStatus ??
        (policy.runtimeValidated ? "runtime_verified" : "pending_review"),
      runtimeValidated: policy.runtimeValidated ?? false,
      citationVisible: true
    };
    this.entries.set(id, entry);
    this.byOriginalSourceId.set(entry.originalSourceId, id);
    return id;
  }

  addPrivate(input: {
    sourceId: string;
    title: string;
    excerpt: string;
    locator?: string;
    publisher?: string;
    reviewStatus?: SourceReviewStatus;
    runtimeValidated?: boolean;
  }): string {
    const existing = this.byOriginalSourceId.get(input.sourceId);
    if (existing) return existing;
    const id = `E${this.entries.size + 1}`;
    const entry: RegisteredEvidence = {
      id,
      evidence: {
        citation: {
          sourceId: input.sourceId,
          title: input.title,
          publisher: input.publisher ?? "用户私有附件",
          url: "https://private.invalid/",
          pageOrSection: input.locator,
          fetchedAt: new Date(0),
          licenseClass: "private_authorized"
        },
        excerpt: input.excerpt
      },
      originalSourceId: input.sourceId,
      trustTier: "tier_b",
      reviewStatus: input.reviewStatus ?? "pending_review",
      runtimeValidated: input.runtimeValidated ?? false,
      citationVisible: false
    };
    this.entries.set(id, entry);
    this.byOriginalSourceId.set(input.sourceId, id);
    return id;
  }

  addMany(
    evidence: GroundingEvidence[],
    policy: Parameters<EvidenceRegistry["add"]>[1] = {}
  ): string[] {
    return evidence.flatMap((item) => {
      const id = this.add(item, policy);
      return id ? [id] : [];
    });
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): RegisteredEvidence | undefined {
    return this.entries.get(id);
  }

  bindVerifiedLink(id: string, linkId: string, hostname: string): void {
    const entry = this.entries.get(id);
    if (!entry) throw new TypeError(`Unknown evidence id: ${id}`);
    entry.linkId = linkId;
    entry.linkHostname = hostname;
  }

  list(): RegisteredEvidence[] {
    return [...this.entries.values()];
  }

  citation(id: string): Citation | undefined {
    const entry = this.entries.get(id);
    if (!entry?.citationVisible) return undefined;
    return {
      ...entry.evidence.citation,
      sourceId: id,
      fetchedAt: new Date(entry.evidence.citation.fetchedAt).toISOString(),
      trustTier: entry.trustTier,
      reviewStatus: entry.reviewStatus
    };
  }

  citations(ids: Iterable<string>): Citation[] {
    const unique = [...new Set(ids)];
    return unique.flatMap((id) => {
      const citation = this.citation(id);
      return citation ? [citation] : [];
    });
  }

  modelIndex(): Array<{
    evidenceId: string;
    title: string;
    publisher: string;
    locator?: string;
    excerpt: string;
    trustTier: Exclude<SourceTrustTier, "tier_c" | "blocked">;
    reviewStatus: SourceReviewStatus;
    linkId?: string;
    linkHostname?: string;
  }> {
    return this.list().map((entry) => ({
      evidenceId: entry.id,
      title: entry.evidence.citation.title,
      publisher: entry.evidence.citation.publisher,
      locator: entry.evidence.citation.pageOrSection,
      excerpt: entry.evidence.excerpt,
      trustTier: entry.trustTier as Exclude<
        SourceTrustTier,
        "tier_c" | "blocked"
      >,
      reviewStatus: entry.reviewStatus,
      ...(entry.linkId
        ? { linkId: entry.linkId, linkHostname: entry.linkHostname }
        : {})
    }));
  }

  hasVerifiedTierA(ids: Iterable<string>): boolean {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (
        entry?.trustTier === "tier_a" &&
        (entry.reviewStatus === "reviewed" ||
          entry.reviewStatus === "runtime_verified")
      ) {
        return true;
      }
    }
    return false;
  }
}

export function inferTrustTier(url: string): SourceTrustTier {
  let hostname: string;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      (parsed.port && parsed.port !== "443")
    ) {
      return "blocked";
    }
    hostname = parsed.hostname.toLowerCase();
    if (isLocalOrPrivateHostname(hostname)) return "blocked";
  } catch {
    return "blocked";
  }
  return TIER_A_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  )
    ? "tier_a"
    : "tier_c";
}

function isLocalOrPrivateHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.endsWith(".localhost") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }
  const ipv4 = normalized.split(".").map(Number);
  if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = ipv4;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export const defaultTierADomains = [...TIER_A_DOMAINS];
