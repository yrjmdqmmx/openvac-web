import { createHash } from "node:crypto";

import type { VerifiedLinkPart } from "@/types/chat-v3";

const WEB_LINK_BINDING_VERSION = "openvac.web-link-binding.v2";

export function webLinkBindingDigest(input: {
  evidenceId: string;
  link: Pick<VerifiedLinkPart, "linkId" | "hostname" | "label" | "url">;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: WEB_LINK_BINDING_VERSION,
        evidenceId: input.evidenceId,
        linkId: input.link.linkId,
        hostname: input.link.hostname,
        label: input.link.label,
        url: input.link.url
      })
    )
    .digest("hex");
}

export function webLinkBindingArgumentsDigest(): string {
  return createHash("sha256").update(WEB_LINK_BINDING_VERSION).digest("hex");
}
