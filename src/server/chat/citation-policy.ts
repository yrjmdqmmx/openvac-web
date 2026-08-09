import type { Citation } from "@/types/chat";
import { hostnameAllowed, normalizeDomain } from "@/server/providers/runtime";

export function citationSourcePolicy(
  url: string,
  licenseClass: Citation["licenseClass"],
  configuredDomains = process.env.WEB_SEARCH_ALLOWED_DOMAINS ??
    process.env.ALIBABA_WEB_SEARCH_ALLOWED_DOMAINS
): NonNullable<Citation["sourcePolicy"]> {
  if (licenseClass === "private_authorized" || licenseClass === "unknown") {
    return "blocked";
  }

  const allowedDomains = (configuredDomains ?? "")
    .split(",")
    .map(normalizeDomain)
    .filter(Boolean);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "blocked";
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    !hostnameAllowed(parsed.hostname, allowedDomains)
  ) {
    return "blocked";
  }

  return {
    linkAllowed: true,
    authoritative: true,
    allowedDomains: [normalizeDomain(parsed.hostname)]
  };
}
