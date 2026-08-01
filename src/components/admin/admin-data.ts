export type AdminRow = Record<string, unknown>;

export const adminModuleConfigs = {
  users: {
    title: "用户",
    description: "查看账户状态、封禁、会话与单独加额。",
    endpoint: "/api/admin/users",
    responseKeys: ["users"],
    columns: ["email", "name", "banned", "dailyQuotaBonus", "createdAt"]
  },
  conversations: {
    title: "对话与反馈",
    description: "按状态和模型复核对话，不展示模型思维过程。",
    endpoint: "/api/admin/conversations",
    responseKeys: ["conversations"],
    columns: ["title", "userEmail", "status", "model", "updatedAt"]
  },
  "problem-reports": {
    title: "问题反馈",
    description: "复核回答、引用、系统错误和产品建议；反馈不代表承诺回复。",
    endpoint: "/api/admin/problem-reports",
    responseKeys: ["problemReports"],
    columns: [
      "category",
      "description",
      "includeContext",
      "contactType",
      "status",
      "createdAt"
    ]
  },
  sources: {
    title: "来源白名单",
    description: "维护联网权威来源、授权策略和启用状态。",
    endpoint: "/api/admin/sources",
    responseKeys: ["sources"],
    columns: [
      "kind",
      "name",
      "publisher",
      "canonicalUrl",
      "sourceTier",
      "licensePolicy",
      "rightsStatus",
      "enabled",
      "updatedAt"
    ]
  },
  prompts: {
    title: "提示词与评测",
    description: "版本化管理系统提示词、状态和发布记录。",
    endpoint: "/api/admin/prompts",
    responseKeys: ["prompts"],
    columns: ["key", "version", "status", "updatedAt"]
  },
  models: {
    title: "模型与预算",
    description: "设置模型预算、启用状态与成本上限。",
    endpoint: "/api/admin/budgets",
    responseKeys: ["models", "budgets"],
    columns: ["model", "dailyLimitCents", "monthlyLimitCents", "enabled"]
  },
  admins: {
    title: "管理员",
    description:
      "分配 owner、admin、knowledge_editor、support 和 analyst 角色。",
    endpoint: "/api/admin/admins",
    responseKeys: ["admins"],
    columns: ["email", "name", "role", "createdBy", "createdAt"]
  },
  audit: {
    title: "审计日志",
    description: "追踪所有后台读取、发布、回滚和权限变更。",
    endpoint: "/api/admin/audit",
    responseKeys: ["audit", "auditLogs"],
    columns: [
      "actorUserId",
      "actorRole",
      "action",
      "targetType",
      "targetId",
      "createdAt"
    ]
  }
} as const;

export type AdminSection = keyof typeof adminModuleConfigs;

export const adminColumnLabels: Record<string, string> = {
  email: "邮箱",
  name: "名称",
  banned: "封禁",
  dailyQuotaBonus: "每日加额",
  createdAt: "创建时间",
  title: "标题",
  userEmail: "用户",
  status: "状态",
  model: "模型",
  updatedAt: "更新时间",
  category: "问题类型",
  description: "问题描述",
  includeContext: "附带上下文",
  contactType: "联系类型",
  kind: "来源类型",
  publisher: "发布机构",
  canonicalUrl: "记录地址",
  baseUrl: "基础地址",
  sourceTier: "来源层级",
  licensePolicy: "授权策略",
  rightsStatus: "权利状态",
  enabled: "启用",
  version: "版本",
  key: "配置项",
  dailyLimitCents: "每日上限（分）",
  monthlyLimitCents: "每月上限（分）",
  role: "角色",
  createdBy: "授权人 ID",
  actorUserId: "操作者 ID",
  actorRole: "角色",
  action: "动作",
  targetType: "对象类型",
  targetId: "对象 ID"
};

function isRecord(value: unknown): value is AdminRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRows(value: unknown): AdminRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord);
}

function rowsFromRecord(
  record: AdminRow,
  responseKeys: readonly string[]
): AdminRow[] | undefined {
  const items = asRows(record.items);
  if (items) return items;

  for (const key of responseKeys) {
    const rows = asRows(record[key]);
    if (rows) return rows;
  }

  return undefined;
}

function extractRows(
  payload: unknown,
  responseKeys: readonly string[]
): AdminRow[] {
  const directRows = asRows(payload);
  if (directRows) return directRows;
  if (!isRecord(payload)) return [];

  const rootRows = rowsFromRecord(payload, responseKeys);
  if (rootRows) return rootRows;

  const dataRows = asRows(payload.data);
  if (dataRows) return dataRows;
  if (!isRecord(payload.data)) return [];

  return rowsFromRecord(payload.data, responseKeys) ?? [];
}

export function extractAdminRows(
  payload: unknown,
  section: AdminSection
): AdminRow[] {
  return extractRows(payload, adminModuleConfigs[section].responseKeys);
}

export function formatAdminValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string") {
    const labels: Record<string, string> = {
      answer_incorrect: "回答不正确",
      citation_problem: "引用问题",
      unsafe_answer: "可能不安全",
      system_error: "系统错误",
      product_suggestion: "产品建议",
      other: "其他",
      new: "新反馈",
      reviewing: "复核中",
      closed: "已关闭",
      email: "邮箱",
      phone: "电话",
      wechat: "微信"
    };
    if (labels[value]) return labels[value];
  }
  if (/At$/.test(key) && typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false
      });
    }
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export type KnowledgeDocumentView = {
  id: string;
  title: string;
  description?: string;
  status: string;
  sourceId?: string;
  sourceName?: string;
  sourceTier?: string;
  licensePolicy?: string;
  sourceEnabled?: boolean;
  currentVersionId?: string;
  version?: number;
  versionStatus?: string;
  ingestionMode?: string;
  language?: string;
  mimeType?: string;
  ocrConfidence?: number;
  chunkCount?: number;
  embeddedChunkCount?: number;
  embeddingStatus?: string;
  embeddingModel?: string;
  reviewStatus?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
  reviewInvalidatedAt?: string;
  contentHash?: string;
  publishReady?: boolean;
  publishBlockers: string[];
  previousPublishedVersionId?: string;
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

function recordValue(value: unknown): AdminRow {
  return isRecord(value) ? value : {};
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0
  );
}

function numberValue(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value)
  );
}

function booleanValue(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
}

function stringArray(...values: unknown[]): string[] {
  const value = values.find(Array.isArray);
  if (!value) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0
  );
}

function normalizeKnowledgeDocument(
  row: AdminRow
): KnowledgeDocumentView | undefined {
  const id = stringValue(row.id);
  const title = stringValue(row.title);
  if (!id || !title) return undefined;

  const source = recordValue(row.source);
  const version =
    typeof row.version === "object"
      ? recordValue(row.version)
      : recordValue(row.currentVersion ?? row.versionDetail);
  const documentMetadata = recordValue(row.metadata);
  const versionMetadata = recordValue(row.versionMetadata ?? version.metadata);
  const citationMetadata = recordValue(
    row.citationMetadata ?? version.citationMetadata
  );
  const review = recordValue(row.review ?? versionMetadata.review);
  const publishability = recordValue(
    row.publishability ??
      row.publication ??
      (typeof row.publishReady === "object" ? row.publishReady : undefined)
  );

  const status = stringValue(row.status) ?? "draft";
  const explicitPublishReady = booleanValue(
    row.publishReady,
    publishability.ready,
    publishability.publishReady
  );

  return {
    id,
    title,
    description: stringValue(row.description),
    status,
    sourceId: stringValue(row.sourceId, source.id),
    sourceName: stringValue(
      row.sourceName,
      row.publisher,
      source.name,
      source.publisher
    ),
    sourceTier: stringValue(row.sourceTier, source.sourceTier),
    licensePolicy: stringValue(
      row.licensePolicy,
      row.licenseClass,
      source.licensePolicy
    ),
    sourceEnabled: booleanValue(row.sourceEnabled, source.enabled),
    currentVersionId: stringValue(row.currentVersionId, version.id),
    version: numberValue(row.version, row.versionNumber, version.version),
    versionStatus: stringValue(row.versionStatus, version.status),
    ingestionMode: stringValue(
      row.ingestionMode,
      citationMetadata.ingestionMode
    ),
    language: stringValue(row.language),
    mimeType: stringValue(row.mimeType),
    ocrConfidence: numberValue(
      row.ocrConfidence,
      versionMetadata.ocrConfidence,
      documentMetadata.ocrConfidence
    ),
    chunkCount: numberValue(row.chunkCount, version.chunkCount),
    embeddedChunkCount: numberValue(
      row.embeddedChunkCount,
      version.embeddedChunkCount
    ),
    embeddingStatus: stringValue(
      row.embeddingStatus,
      versionMetadata.embeddingStatus
    ),
    embeddingModel: stringValue(
      row.embeddingModel,
      versionMetadata.embeddingModel
    ),
    reviewStatus: stringValue(
      row.reviewStatus,
      versionMetadata.reviewStatus,
      review.status
    ),
    reviewedBy: stringValue(
      row.reviewedBy,
      review.reviewedBy,
      review.reviewerName
    ),
    reviewedAt: stringValue(row.reviewedAt, review.reviewedAt),
    reviewNote: stringValue(row.reviewNote, review.note),
    reviewInvalidatedAt: stringValue(
      row.reviewInvalidatedAt,
      review.invalidatedAt
    ),
    contentHash: stringValue(row.contentHash, version.contentHash),
    publishReady:
      explicitPublishReady ?? (status === "review" ? undefined : false),
    publishBlockers: stringArray(
      row.publishBlockers,
      row.publishReasons,
      publishability.blockers,
      publishability.reasons
    ),
    previousPublishedVersionId: stringValue(
      row.previousPublishedVersionId,
      publishability.previousPublishedVersionId
    ),
    publishedAt: stringValue(row.publishedAt, version.publishedAt),
    createdAt: stringValue(row.createdAt),
    updatedAt: stringValue(row.updatedAt)
  };
}

export function normalizeKnowledgeDocuments(
  payload: unknown
): KnowledgeDocumentView[] {
  return extractRows(payload, ["documents", "knowledge"])
    .map(normalizeKnowledgeDocument)
    .filter(
      (document): document is KnowledgeDocumentView => document !== undefined
    );
}
