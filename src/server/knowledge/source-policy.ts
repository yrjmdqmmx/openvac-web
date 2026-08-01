export const KNOWLEDGE_SOURCE_TIERS = [
  "open_license",
  "metadata_only",
  "manufacturer_metadata",
  "standard_metadata",
  "internal"
] as const;

export type KnowledgeSourceTier = (typeof KNOWLEDGE_SOURCE_TIERS)[number];
export type KnowledgeIngestionMode = "full_text" | "metadata_only";

export type GovernedKnowledgeSource = {
  sourceTier: KnowledgeSourceTier;
  enabled: boolean;
  deletedAt?: Date | string | null;
  canonicalUrl: string | null;
  publisher: string | null;
  metadata: Record<string, unknown>;
};

export type KnowledgeSourcePolicyCode =
  | "KNOWLEDGE_SOURCE_REQUIRED"
  | "KNOWLEDGE_SOURCE_DISABLED"
  | "KNOWLEDGE_SOURCE_DELETED"
  | "KNOWLEDGE_SOURCE_URL_INVALID"
  | "KNOWLEDGE_SOURCE_PUBLISHER_REQUIRED"
  | "KNOWLEDGE_INGESTION_MODE_INVALID"
  | "SOURCE_LICENSE_RESTRICTED"
  | "SOURCE_RIGHTS_DECISION_REQUIRED"
  | "SOURCE_RIGHTS_DECISION_INVALID"
  | "SOURCE_COMMERCIAL_AI_RIGHTS_REQUIRED";

export class KnowledgeSourcePolicyError extends Error {
  readonly code: KnowledgeSourcePolicyCode;

  constructor(code: KnowledgeSourcePolicyCode, message: string) {
    super(message);
    this.name = "KnowledgeSourcePolicyError";
    this.code = code;
  }
}

/**
 * Fail-closed policy shared by admin publication/review and the ingestion
 * worker. Source-level booleans are retained for internal collections, but an
 * explicit rightsDecision can never be bypassed by a legacy boolean.
 */
export function assertKnowledgeSourceAuthorized(
  source: GovernedKnowledgeSource | undefined,
  citationMetadata: Record<string, unknown>
): void {
  if (!source) {
    fail("KNOWLEDGE_SOURCE_REQUIRED", "知识版本必须关联受治理的来源记录。");
  }
  if (!source.enabled) {
    fail("KNOWLEDGE_SOURCE_DISABLED", "该知识来源未启用。");
  }
  if (source.deletedAt !== null && source.deletedAt !== undefined) {
    fail("KNOWLEDGE_SOURCE_DELETED", "该知识来源已删除。");
  }

  const canonicalUrl = validHttpsUrl(source.canonicalUrl);
  if (!canonicalUrl) {
    fail(
      "KNOWLEDGE_SOURCE_URL_INVALID",
      "知识来源必须记录不含凭据的 HTTPS canonicalUrl。"
    );
  }
  if (!source.publisher?.trim()) {
    fail("KNOWLEDGE_SOURCE_PUBLISHER_REQUIRED", "知识来源必须记录发布机构。");
  }

  const ingestionMode = citationMetadata.ingestionMode;
  if (ingestionMode !== "full_text" && ingestionMode !== "metadata_only") {
    fail("KNOWLEDGE_INGESTION_MODE_INVALID", "知识版本缺少有效的入库模式。");
  }

  if (isMetadataOnlyTier(source.sourceTier)) {
    if (ingestionMode !== "metadata_only") {
      fail(
        "SOURCE_LICENSE_RESTRICTED",
        "该来源层级仅允许元数据、人工摘要与链接，不能入库全文。"
      );
    }
    return;
  }

  if (ingestionMode === "metadata_only") return;

  const decisionValue = source.metadata.rightsDecision;
  const decision = recordValue(decisionValue);
  const hasDecision = decisionValue !== null && decisionValue !== undefined;

  if (source.sourceTier === "open_license") {
    if (!hasDecision) {
      fail(
        "SOURCE_RIGHTS_DECISION_REQUIRED",
        "开放许可全文必须记录针对该页面的结构化 rightsDecision。"
      );
    }
    assertApprovedFullTextDecision(decision, canonicalUrl);
    return;
  }

  if (source.sourceTier === "internal") {
    if (hasDecision) {
      assertApprovedFullTextDecision(decision, canonicalUrl);
    }
    const structuredCommercialApproval =
      decision.commercialAiUse === "approved" ||
      decision.commercialAiRights === "approved";
    if (
      source.metadata.commercialAiRightsConfirmed !== true &&
      !structuredCommercialApproval
    ) {
      fail(
        "SOURCE_COMMERCIAL_AI_RIGHTS_REQUIRED",
        "内部全文必须记录商业 AI 使用权批准。"
      );
    }
    return;
  }

  fail("SOURCE_LICENSE_RESTRICTED", "该来源层级未获准进行全文入库。");
}

export function isMetadataOnlyTier(sourceTier: KnowledgeSourceTier): boolean {
  return (
    sourceTier === "metadata_only" ||
    sourceTier === "manufacturer_metadata" ||
    sourceTier === "standard_metadata"
  );
}

export function isKnowledgeSourceTier(
  value: unknown
): value is KnowledgeSourceTier {
  return KNOWLEDGE_SOURCE_TIERS.includes(value as KnowledgeSourceTier);
}

function assertApprovedFullTextDecision(
  decision: Record<string, unknown>,
  canonicalUrl: string
): void {
  if (
    decision.status !== "approved" ||
    decision.scope !== "full_text" ||
    decision.appliesToRecordUrl !== canonicalUrl
  ) {
    fail(
      "SOURCE_RIGHTS_DECISION_INVALID",
      "rightsDecision 必须批准全文，且仅适用于当前 canonicalUrl。"
    );
  }
}

function validHttpsUrl(value: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return null;
    }
    return value.trim();
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function fail(code: KnowledgeSourcePolicyCode, message: string): never {
  throw new KnowledgeSourcePolicyError(code, message);
}
