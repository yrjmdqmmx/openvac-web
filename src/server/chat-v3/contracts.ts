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
      .refine((url) => new URL(url).protocol === "https:"),
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
    const attachmentCount = parts.filter(
      (part) => part.type === "attachment"
    ).length;
    if (attachmentCount > MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
      context.addIssue({
        code: "custom",
        message: `每条消息最多包含 ${MAX_CHAT_ATTACHMENTS_PER_MESSAGE} 个附件。`
      });
    }
  });

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

const artifactTableSchema = z.object({
  title: z.string().trim().max(240).optional(),
  columns: z.array(z.string()).min(1).max(32),
  rows: z.array(z.array(z.string()).max(32)).max(2_000)
});

export const artifactSpecSchema = z.object({
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
      z.object({
        heading: z.string().trim().min(1).max(240),
        paragraphs: z.array(z.string()).max(100)
      })
    )
    .max(64),
  tables: z.array(artifactTableSchema).max(32),
  sourceTurnId: z.string().uuid()
});

export function normalizeStoredMessageParts(
  content: string,
  parts: unknown
): MessagePart[] {
  if (Array.isArray(parts) && parts.length > 0) {
    return parts as MessagePart[];
  }
  return content.trim() ? [{ type: "text", text: content }] : [];
}
