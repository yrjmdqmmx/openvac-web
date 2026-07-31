import { z } from "zod";

import { ADMIN_ROLES } from "./types";

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

export const consultationSchema = z
  .object({
    confirmed: z.literal(true, {
      error: "提交咨询前必须由用户明确确认。"
    }),
    conversationId: z.string().uuid().optional(),
    contactName: z.string().trim().min(1).max(80),
    companyName: z.string().trim().min(1).max(160),
    contactMethod: z.enum(["phone", "email", "wechat"]),
    contactValue: z.string().trim().min(3).max(160),
    problem: z.string().trim().min(10).max(5000),
    conversationSummary: z.string().trim().min(10).max(8000)
  })
  .superRefine((value, context) => {
    if (
      value.contactMethod === "email" &&
      !z.email().safeParse(value.contactValue).success
    ) {
      context.addIssue({
        code: "custom",
        path: ["contactValue"],
        message: "邮箱格式不正确。"
      });
    }

    if (
      value.contactMethod === "phone" &&
      !/^[+0-9() -]{6,30}$/.test(value.contactValue)
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

export const feedbackStatusSchema = z.object({
  status: z.enum(["open", "reviewing", "resolved", "dismissed"]),
  note: optionalTrimmed(1000)
});

export const consultationStatusSchema = z.object({
  status: z.enum(["submitted", "contacting", "resolved", "closed"]),
  assignedTo: z.string().trim().min(1).max(128).optional(),
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

export const knowledgeReviewSchema = z.object({
  versionId: z.string().uuid(),
  expectedContentHash: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/u, "内容哈希必须是小写 SHA-256。")
});

export const sourceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  baseUrl: z.url().max(2000),
  sourceTier: z.enum([
    "open_license",
    "manufacturer_metadata",
    "standard_metadata",
    "internal"
  ]),
  licensePolicy: z.string().trim().min(1).max(500),
  notes: optionalTrimmed(2000),
  enabled: z.boolean().default(true)
});

export const sourceUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    baseUrl: z.url().max(2000).optional(),
    sourceTier: z
      .enum([
        "open_license",
        "manufacturer_metadata",
        "standard_metadata",
        "internal"
      ])
      .optional(),
    licensePolicy: z.string().trim().min(1).max(500).optional(),
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
    content: z.string().min(1).max(200_000).optional(),
    notes: optionalTrimmed(2000),
    status: z.enum(["draft", "active", "archived"]).optional()
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "至少提供一个要更新的字段。"
  );

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
