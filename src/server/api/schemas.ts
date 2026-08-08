import { z } from "zod";

import { ADMIN_ROLES, PROBLEM_REPORT_CATEGORIES } from "./types";

const optionalTrimmed = (max: number) =>
  z.string().trim().min(1).max(max).optional();

export const uuidSchema = z.string().uuid();

export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(120).optional(),
  status: z.string().trim().max(40).optional()
});

export const adminRoleMutationSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  role: z.enum(ADMIN_ROLES)
});

export const adminRoleReplaceSchema = z
  .object({
    userId: z.string().trim().min(1).max(128),
    expectedRole: z.enum(ADMIN_ROLES),
    role: z.enum(ADMIN_ROLES)
  })
  .strict()
  .refine((value) => value.expectedRole !== value.role, {
    message: "新角色必须与当前角色不同。",
    path: ["role"]
  });

export const adminInvitationCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(ADMIN_ROLES)
});

export const adminInvitationDeleteSchema = z.object({
  invitationId: uuidSchema
});

export const adminInvitationAcceptSchema = z.object({
  token: uuidSchema
});

export const adminTaskStateUpdateSchema = z
  .object({
    taskKey: z
      .string()
      .trim()
      .min(3)
      .max(300)
      .regex(
        /^(?:auth:role-conflict|feedback|problem_report|knowledge|system|budget):[^\s:][^\s]*$/u,
        "任务标识不属于允许的实时业务源。"
      ),
    expectedRevision: z.number().int().min(0),
    assigneeUserId: z.string().trim().min(1).max(128).nullable().optional(),
    status: z.enum(["open", "in_progress", "done"]).optional(),
    dueAt: z.iso.datetime().nullable().optional(),
    snoozedUntil: z.iso.datetime().nullable().optional(),
    note: z.string().trim().max(2_000).nullable().optional()
  })
  .strict()
  .refine(
    (value) =>
      value.assigneeUserId !== undefined ||
      value.status !== undefined ||
      value.dueAt !== undefined ||
      value.snoozedUntil !== undefined ||
      value.note !== undefined,
    "至少提供一个要更新的任务状态字段。"
  );

export const conversationSearchSchema = pageSchema.extend({
  q: z.string().trim().min(1).max(120)
});

export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(120).default("新对话")
});

export const renameConversationSchema = z.object({
  title: z.string().trim().min(1).max(120)
});

export const messageFeedbackSchema = z.object({
  rating: z.enum(["helpful", "not_helpful"]),
  reason: optionalTrimmed(80),
  comment: optionalTrimmed(1000)
});

export const messageReportSchema = z.object({
  category: z.enum([
    "unsafe",
    "incorrect",
    "privacy",
    "copyright",
    "spam",
    "other"
  ]),
  details: optionalTrimmed(2000)
});

export const problemReportSchema = z
  .object({
    clientRequestId: z.string().uuid(),
    conversationId: z.string().uuid().optional(),
    messageId: z.string().uuid().optional(),
    category: z.enum(PROBLEM_REPORT_CATEGORIES),
    description: z.string().trim().min(1).max(3000),
    includeContext: z.boolean().default(false),
    contactType: z.enum(["phone", "email", "wechat"]).optional(),
    contactValue: optionalTrimmed(160),
    consentToContact: z.boolean().default(false)
  })
  .superRefine((value, context) => {
    if (value.includeContext && !value.conversationId && !value.messageId) {
      context.addIssue({
        code: "custom",
        path: ["includeContext"],
        message: "勾选附带上下文时必须关联对话或消息。"
      });
    }

    if (Boolean(value.contactType) !== Boolean(value.contactValue)) {
      context.addIssue({
        code: "custom",
        path: value.contactType ? ["contactValue"] : ["contactType"],
        message: "联系类型和联系方式必须同时填写。"
      });
    }

    if ((value.contactType || value.contactValue) && !value.consentToContact) {
      context.addIssue({
        code: "custom",
        path: ["consentToContact"],
        message: "提供联系方式前必须明确同意可能的后续联系。"
      });
    }

    if (
      value.contactType === "email" &&
      !z.email().safeParse(value.contactValue).success
    ) {
      context.addIssue({
        code: "custom",
        path: ["contactValue"],
        message: "邮箱格式不正确。"
      });
    }

    if (
      value.contactType === "phone" &&
      !/^[+0-9() -]{6,30}$/.test(value.contactValue ?? "")
    ) {
      context.addIssue({
        code: "custom",
        path: ["contactValue"],
        message: "电话号码格式不正确。"
      });
    }
  });

export const userBanSchema = z
  .object({
    banned: z.boolean(),
    reason: optionalTrimmed(500),
    expiresAt: z.iso.datetime().optional()
  })
  .superRefine((value, context) => {
    if (value.banned && !value.reason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "封禁用户时必须填写原因。"
      });
    }
  });

export const userQuotaSchema = z.object({
  dailyBonus: z.number().int().min(0).max(100_000),
  reason: z.string().trim().min(3).max(500)
});

export const userSessionRevokeSchema = z
  .object({
    reason: z.string().trim().min(3).max(500)
  })
  .strict();

export const feedbackStatusSchema = z.object({
  status: z.enum(["open", "reviewing", "resolved", "dismissed"]),
  note: optionalTrimmed(1000)
});

export const problemReportStatusSchema = z.object({
  status: z.enum(["new", "reviewing", "closed"]),
  note: optionalTrimmed(2000)
});

export const knowledgeDraftSchema = z.object({
  title: z.string().trim().min(1).max(240),
  sourceId: z.string().uuid().optional(),
  ingestionMode: z.enum(["full_text", "metadata_only"]).default("full_text"),
  content: z.string().min(1).max(2_000_000),
  citationMetadata: z.record(z.string(), z.unknown()).default({})
});

export const knowledgeDraftUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    sourceId: z.string().uuid().optional(),
    ingestionMode: z.enum(["full_text", "metadata_only"]).optional(),
    content: z.string().min(1).max(2_000_000).optional(),
    citationMetadata: z.record(z.string(), z.unknown()).optional()
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "至少提供一个要更新的字段。"
  );

export const rollbackKnowledgeSchema = z.object({
  versionId: z.string().uuid()
});

export const knowledgeReviewSchema = z
  .object({
    versionId: z.string().uuid(),
    expectedContentHash: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/u, "内容哈希必须是小写 SHA-256。"),
    decision: z.enum(["approved", "rejected"]).default("approved"),
    note: optionalTrimmed(2_000)
  })
  .superRefine((value, context) => {
    if (value.decision === "rejected" && !value.note) {
      context.addIssue({
        code: "custom",
        path: ["note"],
        message: "驳回知识时必须填写审核备注。"
      });
    }
  });

export const knowledgeSectionDecisionSchema = z
  .object({
    expectedSectionHash: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/u, "段落哈希必须是小写 SHA-256。"),
    expectedRevision: z.number().int().min(0),
    decision: z.enum(["approved", "rejected", "changes_requested"]),
    note: optionalTrimmed(2_000)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision !== "approved" && !value.note) {
      context.addIssue({
        code: "custom",
        path: ["note"],
        message: "驳回或要求修改段落时必须填写审核备注。"
      });
    }
  });

export const knowledgeSectionReviewCompleteSchema = z
  .object({
    versionId: uuidSchema,
    expectedContentHash: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/u, "内容哈希必须是小写 SHA-256。")
  })
  .strict();

const sourceKindSchema = z.enum([
  "upload",
  "manual",
  "manufacturer",
  "standard",
  "patent",
  "web"
]);

const sourceTierSchema = z.enum([
  "open_license",
  "metadata_only",
  "manufacturer_metadata",
  "standard_metadata",
  "internal"
]);

const httpsSourceUrlSchema = z
  .url()
  .max(2_000)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === ""
      );
    } catch {
      return false;
    }
  }, "来源地址必须是不含凭据的 HTTPS URL。");

const sourceRightsDecisionSchema = z.object({
  status: z.enum(["approved", "pending", "rejected"]),
  scope: z.enum(["full_text", "metadata_only"]),
  basis: z.string().trim().min(10).max(2_000),
  evidenceUrl: httpsSourceUrlSchema,
  appliesToRecordUrl: httpsSourceUrlSchema
});

export const sourceSchema = z
  .object({
    kind: sourceKindSchema,
    name: z.string().trim().min(1).max(200),
    publisher: z.string().trim().min(1).max(200),
    canonicalUrl: httpsSourceUrlSchema,
    baseUrl: httpsSourceUrlSchema,
    sourceTier: sourceTierSchema,
    licensePolicy: z.string().trim().min(1).max(500),
    rightsDecision: sourceRightsDecisionSchema.optional(),
    notes: optionalTrimmed(2000),
    enabled: z.boolean().default(true)
  })
  .superRefine((value, context) => {
    if (
      value.rightsDecision &&
      value.rightsDecision.appliesToRecordUrl !== value.canonicalUrl
    ) {
      context.addIssue({
        code: "custom",
        path: ["rightsDecision", "appliesToRecordUrl"],
        message: "权利决定必须精确对应 canonicalUrl。"
      });
    }
  });

export const sourceUpdateSchema = z
  .object({
    kind: sourceKindSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    publisher: z.string().trim().min(1).max(200).optional(),
    canonicalUrl: httpsSourceUrlSchema.optional(),
    baseUrl: httpsSourceUrlSchema.optional(),
    sourceTier: sourceTierSchema.optional(),
    licensePolicy: z.string().trim().min(1).max(500).optional(),
    rightsDecision: sourceRightsDecisionSchema.optional(),
    notes: optionalTrimmed(2000),
    enabled: z.boolean().optional()
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "至少提供一个要更新的字段。"
  );

export const promptSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
  content: z.string().min(1).max(200_000),
  notes: optionalTrimmed(2000)
});

export const promptUpdateSchema = z
  .object({
    status: z.enum(["active", "archived"])
  })
  .strict();

export const budgetsSchema = z
  .object({
    budgets: z
      .array(
        z.object({
          model: z.string().trim().min(1).max(160),
          dailyLimitCents: z.number().int().min(0).max(100_000_000),
          monthlyLimitCents: z.number().int().min(0).max(1_000_000_000),
          enabled: z.boolean()
        })
      )
      .max(100)
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.budgets.forEach((budget, index) => {
      if (seen.has(budget.model)) {
        context.addIssue({
          code: "custom",
          path: ["budgets", index, "model"],
          message: "同一模型只能配置一次预算。"
        });
      }
      seen.add(budget.model);
    });
  });

export const settingsSchema = z.object({
  settings: z
    .record(
      z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
      z.union([z.boolean(), z.number(), z.string()])
    )
    .refine(
      (value) => Object.keys(value).length <= 100,
      "单次最多更新 100 项设置。"
    )
});

export const metricsSchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional()
});
