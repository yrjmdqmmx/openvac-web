export type CitationLinkPolicy = {
  linkAllowed?: boolean;
  authoritative?: boolean;
  allowedDomains?: readonly string[];
};

export type CitationLinkInput = {
  url: string;
  sourcePolicy?: CitationLinkPolicy | "authoritative" | "reference" | "blocked";
  allowedDomains?: readonly string[];
};

export type CitationLinkDecision =
  | {
      allowed: true;
      authoritative: boolean;
      href: string;
    }
  | {
      allowed: false;
      authoritative: false;
      href?: undefined;
    };

export type VerifiedLinkPartInput = {
  url: string;
  hostname: string;
  status: "verified" | "unavailable";
};

/**
 * Treat citation metadata as untrusted even after server-side validation.
 * Links fail closed unless the server explicitly permits them and supplies a
 * domain allowlist that matches the final, parsed HTTPS hostname.
 */
export function evaluateCitationLink(
  citation: CitationLinkInput
): CitationLinkDecision {
  const policy = normalizePolicy(citation.sourcePolicy);
  if (!policy.linkAllowed) {
    return denied();
  }

  const allowedDomains = [
    ...(policy.allowedDomains ?? []),
    ...(citation.allowedDomains ?? [])
  ]
    .map(normalizeDomain)
    .filter((domain): domain is string => Boolean(domain));

  if (allowedDomains.length === 0) {
    return denied();
  }

  const rawUrl = citation.url;
  if (
    rawUrl !== rawUrl.trim() ||
    /[\u0000-\u001f\u007f]/.test(rawUrl) ||
    rawUrl.includes("\\") ||
    rawUrl.startsWith("//")
  ) {
    return denied();
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return denied();
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    !hostnameAllowed(parsed.hostname, allowedDomains)
  ) {
    return denied();
  }

  return {
    allowed: true,
    authoritative: policy.authoritative,
    href: parsed.toString()
  };
}

/**
 * V3 answer blocks contain link IDs, never hrefs. A link becomes clickable only
 * when the server-normalized part is verified and its parsed HTTPS hostname
 * still matches the separately supplied hostname.
 */
export function evaluateVerifiedLinkPart(
  link: VerifiedLinkPartInput
): CitationLinkDecision {
  if (link.status !== "verified") return denied();
  const normalizedHostname = normalizeDomain(link.hostname);
  if (!normalizedHostname) return denied();

  const rawUrl = link.url;
  if (
    rawUrl !== rawUrl.trim() ||
    /[\u0000-\u001f\u007f]/.test(rawUrl) ||
    rawUrl.includes("\\") ||
    rawUrl.startsWith("//")
  ) {
    return denied();
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return denied();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    parsed.hostname.toLowerCase() !== normalizedHostname
  ) {
    return denied();
  }

  return { allowed: true, authoritative: false, href: parsed.toString() };
}

function normalizePolicy(
  policy: CitationLinkInput["sourcePolicy"]
): Required<Pick<CitationLinkPolicy, "linkAllowed" | "authoritative">> &
  Pick<CitationLinkPolicy, "allowedDomains"> {
  if (policy === "authoritative") {
    return { linkAllowed: true, authoritative: true };
  }
  if (policy === "reference") {
    return { linkAllowed: true, authoritative: false };
  }
  if (!policy || policy === "blocked") {
    return { linkAllowed: false, authoritative: false };
  }
  return {
    linkAllowed: policy.linkAllowed === true,
    authoritative: policy.authoritative === true,
    allowedDomains: policy.allowedDomains
  };
}

function normalizeDomain(value: string): string | undefined {
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("@") ||
    trimmed.includes(":") ||
    trimmed.includes("*")
  ) {
    return undefined;
  }

  try {
    const parsed = new URL(`https://${trimmed}`);
    if (
      parsed.hostname !== trimmed ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/"
    ) {
      return undefined;
    }
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

function hostnameAllowed(
  hostname: string,
  allowedDomains: readonly string[]
): boolean {
  const normalized = hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
  return allowedDomains.some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`)
  );
}

function denied(): CitationLinkDecision {
  return { allowed: false, authoritative: false };
}
