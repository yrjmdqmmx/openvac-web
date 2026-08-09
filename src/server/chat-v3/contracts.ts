import { z } from "zod";

import type { MessagePart } from "@/types/chat-v3";

export const MAX_CHAT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_CHAT_STORAGE_BYTES_PER_USER = 500 * 1024 * 1024;
export const MAX_CHAT_TEXT_CHARACTERS = 16_000;

export const CHAT_ATTACHMENT_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
  "text/markdown",
  "image/jpeg",
  "image/png"
] as const;

const evidenceIds = z
  .array(z.string().regex(/^E\d+$/u))
  .max(64)
  .default([]);

export const inputMessagePartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().trim().min(1).max(MAX_CHAT_TEXT_CHARACTERS)
  }),
  z.object({
    type: z.literal("link"),
    url: z
      .url()
      .max(2_048)
      .refine((url) => new URL(url).protocol === "https:")
      .refine((url) => !hasSensitiveUrlParameters(new URL(url))),
    label: z.string().trim().min(1).max(240).optional()
  }),
  z.object({
    type: z.literal("attachment"),
    attachmentId: z.string().uuid()
  })
]);

export const inputMessagePartsSchema = z
  .array(inputMessagePartSchema)
  .min(1)
  .max(16)
  .superRefine((parts, context) => {
    const attachments = parts.filter((part) => part.type === "attachment");
    const attachmentCount = attachments.length;
    if (attachmentCount > MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
      context.addIssue({
        code: "custom",
        message: `每条消息最多包含 ${MAX_CHAT_ATTACHMENTS_PER_MESSAGE} 个附件。`
      });
    }
    const attachmentIds = attachments.map((part) => part.attachmentId);
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      context.addIssue({
        code: "custom",
        message: "同一条消息不能重复引用相同附件。"
      });
    }
    const textCharacters = parts.reduce(
      (total, part) => total + (part.type === "text" ? part.text.length : 0),
      0
    );
    if (textCharacters > MAX_CHAT_TEXT_CHARACTERS) {
      context.addIssue({
        code: "custom",
        message: `每条消息的文字总长度不能超过 ${MAX_CHAT_TEXT_CHARACTERS} 个字符。`
      });
    }
  });

export const verifiedLinkPartSchema = z
  .object({
    type: z.literal("verified_link"),
    linkId: z.string().min(1).max(160),
    url: z
      .url()
      .max(2_048)
      .refine((url) => new URL(url).protocol === "https:")
      .refine((url) => !hasSensitiveUrlParameters(new URL(url))),
    label: z.string().trim().min(1).max(240),
    hostname: z.string().trim().min(1).max(253),
    status: z.enum(["verified", "unavailable"])
  })
  .superRefine((part, context) => {
    const url = new URL(part.url);
    if (
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      url.hostname !== part.hostname
    ) {
      context.addIssue({
        code: "custom",
        message: "已验证链接的主机信息不一致。"
      });
    }
  });

export const attachmentPartSchema = z.object({
  type: z.literal("attachment"),
  attachmentId: z.string().uuid(),
  kind: z.enum(["document", "image"]),
  filename: z.string().trim().min(1).max(512),
  mimeType: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().nonnegative().max(MAX_CHAT_ATTACHMENT_BYTES),
  status: z.enum([
    "initiated",
    "uploading",
    "scanning",
    "processing",
    "ready",
    "failed",
    "deleted"
  ])
});

export const artifactPartSchema = z.object({
  type: z.literal("artifact"),
  artifactId: z.string().uuid(),
  kind: z.enum([
    "diagnosis_report",
    "selection_report",
    "inspection_checklist",
    "parameter_table"
  ]),
  title: z.string().trim().min(1).max(240),
  formats: z
    .array(z.enum(["md", "docx", "pdf", "csv"]))
    .min(1)
    .max(4),
  status: z.enum(["generating", "ready", "failed", "deleted"])
});

export const messagePartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().max(MAX_CHAT_TEXT_CHARACTERS)
  }),
  verifiedLinkPartSchema,
  attachmentPartSchema,
  z.object({
    type: z.literal("citation"),
    sourceId: z.string().min(1).max(160),
    ordinal: z.number().int().positive().max(10_000)
  }),
  artifactPartSchema
]);

export const messagePartsSchema = z.array(messagePartSchema).max(256);

export const answerBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), text: z.string(), evidenceIds }),
  z.object({
    type: z.literal("heading"),
    level: z.union([z.literal(2), z.literal(3)]),
    text: z.string()
  }),
  z.object({
    type: z.literal("list"),
    style: z.enum(["ordered", "unordered"]),
    items: z.array(z.string()).min(1).max(64),
    evidenceIds
  }),
  z.object({
    type: z.literal("table"),
    columns: z.array(z.string()).min(1).max(32),
    rows: z.array(z.array(z.string()).max(32)).max(500),
    evidenceIds
  }),
  z.object({
    type: z.literal("code"),
    language: z.string().trim().max(40).optional(),
    code: z.string().max(64_000)
  }),
  z.object({
    type: z.literal("callout"),
    tone: z.enum(["info", "warning", "danger"]),
    title: z.string().trim().max(160).optional(),
    body: z.string(),
    evidenceIds
  }),
  z.object({
    type: z.literal("calculation"),
    calculationId: z.string().min(1).max(160),
    title: z.string().min(1).max(240),
    result: z.string().min(1).max(500),
    unit: z.string().max(80).optional(),
    assumptions: z.array(z.string()).max(32),
    warnings: z.array(z.string()).max(32)
  }),
  z.object({
    type: z.literal("link_reference"),
    linkId: z.string().min(1).max(160),
    label: z.string().min(1).max(240)
  }),
  z.object({
    type: z.literal("artifact_reference"),
    artifactId: z.string().uuid(),
    label: z.string().min(1).max(240)
  })
]);

export const answerV3Schema = z.object({
  schemaVersion: z.literal("openvac.answer.v3"),
  answerKind: z.enum(["direct", "expert", "clarification", "safe_refusal"]),
  riskLevel: z.enum(["low", "medium", "high"]),
  blocks: z.array(answerBlockSchema).min(1).max(128),
  missingInputs: z.array(z.string()).max(64),
  usedEvidenceIds: z.array(z.string().regex(/^E\d+$/u)).max(64),
  usedLinkIds: z.array(z.string()).max(64)
});

const artifactTableSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    columns: z.array(z.string().trim().min(1).max(240)).min(1).max(32),
    rows: z
      .array(z.array(z.string().max(10_000)).min(1).max(32))
      .min(1)
      .max(2_000)
  })
  .strict();

export const artifactSpecSchema = z
  .object({
    schemaVersion: z.literal("openvac.artifact.v1"),
    kind: z.enum([
      "diagnosis_report",
      "selection_report",
      "inspection_checklist",
      "parameter_table"
    ]),
    title: z.string().trim().min(1).max(240),
    formats: z
      .array(z.enum(["md", "docx", "pdf", "csv"]))
      .min(1)
      .max(4),
    summary: z.string().trim().min(1).max(2_000),
    sections: z
      .array(
        z
          .object({
            heading: z.string().trim().min(1).max(240),
            paragraphs: z
              .array(z.string().trim().min(1).max(10_000))
              .min(1)
              .max(100)
          })
          .strict()
      )
      .max(64),
    tables: z.array(artifactTableSchema).max(32),
    sourceTurnId: z.string().uuid()
  })
  .strict()
  .superRefine((spec, context) => {
    if (new Set(spec.formats).size !== spec.formats.length) {
      context.addIssue({
        code: "custom",
        path: ["formats"],
        message: "Artifact formats must be unique."
      });
    }

    if (spec.sections.length === 0 && spec.tables.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Artifact must contain at least one section or table."
      });
    }

    if (spec.formats.includes("csv") && spec.tables.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["formats"],
        message: "CSV artifacts require at least one table."
      });
    }

    if (spec.kind === "parameter_table" && spec.tables.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["tables"],
        message: "Parameter-table artifacts require at least one table."
      });
    }

    spec.tables.forEach((table, tableIndex) => {
      const normalizedColumns = table.columns.map((column) =>
        column.toLocaleLowerCase("zh-CN")
      );
      if (new Set(normalizedColumns).size !== normalizedColumns.length) {
        context.addIssue({
          code: "custom",
          path: ["tables", tableIndex, "columns"],
          message: "Artifact table columns must be unique."
        });
      }
      table.rows.forEach((row, rowIndex) => {
        if (row.length !== table.columns.length) {
          context.addIssue({
            code: "custom",
            path: ["tables", tableIndex, "rows", rowIndex],
            message: "Artifact table rows must match the column count."
          });
        }
      });
    });
  });

export function normalizeStoredMessageParts(
  content: string,
  parts: unknown
): MessagePart[] {
  if (Array.isArray(parts)) {
    const parsed = parts.slice(0, 256).flatMap((candidate) => {
      const result = messagePartSchema.safeParse(candidate);
      return result.success ? [result.data as MessagePart] : [];
    });
    if (parsed.length > 0) return parsed;
  }
  return content.trim() ? [{ type: "text", text: content }] : [];
}

function hasSensitiveUrlParameters(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (
      /^(?:x-amz-|x-oss-)/iu.test(key) ||
      /^(?:signature|ossaccesskeyid|accesskeyid|expires|token)$/iu.test(key)
    ) {
      return true;
    }
  }
  return false;
}
