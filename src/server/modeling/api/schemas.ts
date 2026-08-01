import { z } from "zod";

import {
  modelDocumentSchema,
  modelOperationBatchSchema,
  semanticRefSchema
} from "@/lib/modeling/protocol";

export const modelingUuidSchema = z.uuid();

export const modelingPageSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20)
  })
  .strict();

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const createProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000).nullable().optional(),
    document: modelDocumentSchema,
    idempotencyKey: idempotencyKeySchema.optional()
  })
  .strict()
  .refine(
    (value) => value.document.revision === 0,
    "新项目的初始文档版本必须为 0。"
  );

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2_000).nullable().optional()
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.description !== undefined,
    "至少需要提供一个可更新字段。"
  );

export const operationBatchSchema = modelOperationBatchSchema;

export const createAiPlanSchema = z
  .object({
    baseRevisionId: modelingUuidSchema,
    prompt: z.string().trim().min(2).max(4_000),
    selectedSemanticRefs: z.array(semanticRefSchema).max(100).optional(),
    idempotencyKey: idempotencyKeySchema.optional()
  })
  .strict();

export const createModelingJobSchema = z
  .object({
    revisionId: modelingUuidSchema,
    kind: z.enum(["build", "preview", "export"]),
    formats: z
      .array(z.enum(["step", "stl", "glb"]))
      .min(1)
      .max(3)
      .transform((items) => [...new Set(items)])
      .optional(),
    validatePump: z.boolean().optional(),
    idempotencyKey: idempotencyKeySchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.kind === "preview" &&
      value.formats?.some((format) => format !== "glb")
    ) {
      context.addIssue({
        code: "custom",
        path: ["formats"],
        message: "预览任务只允许生成 GLB。"
      });
    }
  });

export const confirmAiPlanSchema = z
  .object({
    baseRevisionId: modelingUuidSchema,
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
    idempotencyKey: idempotencyKeySchema.optional()
  })
  .strict();

export const idempotencyOnlySchema = z
  .object({ idempotencyKey: idempotencyKeySchema.optional() })
  .strict();

export const STEP_IMPORT_MAX_BYTES = 50 * 1024 * 1024;

export const stepImportMimeTypeSchema = z.enum([
  "model/step",
  "application/step",
  "application/octet-stream"
]);

export const importPresignSchema = z
  .object({
    filename: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => /\.(?:step|stp)$/i.test(value), {
        message: "首版仅支持 .step 或 .stp 文件。"
      }),
    mimeType: stepImportMimeTypeSchema,
    sizeBytes: z.number().int().positive().max(STEP_IMPORT_MAX_BYTES),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    idempotencyKey: idempotencyKeySchema.optional()
  })
  .strict();

export const importCompleteSchema = z
  .object({
    objectKey: z
      .string()
      .min(1)
      .max(1_024)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\0") &&
          !value.split("/").includes(".."),
        "对象键格式无效。"
      ),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().positive().max(STEP_IMPORT_MAX_BYTES),
    idempotencyKey: idempotencyKeySchema.optional()
  })
  .strict();

export const artifactDownloadQuerySchema = z
  .object({
    expiresSeconds: z.coerce.number().int().min(1).max(900).default(300)
  })
  .strict();

export const eventStreamQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    waitMs: z.coerce.number().int().min(0).max(30_000).default(20_000)
  })
  .strict();
