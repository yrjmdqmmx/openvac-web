import { createHash } from "node:crypto";

import { z } from "zod";

const httpsUrl = z
  .url()
  .refine((value) => new URL(value).protocol === "https:", {
    message: "Knowledge source links must use HTTPS."
  });

export const knowledgeCandidateSchema = z
  .object({
    sourceCanonicalUrl: httpsUrl,
    document: z.object({
      externalKey: z.string().trim().min(1).max(240),
      title: z.string().trim().min(1).max(300),
      description: z.string().trim().min(1).max(2_000),
      language: z.string().trim().min(2).max(32),
      mimeType: z.string().trim().min(1).max(160),
      tags: z.array(z.string().trim().min(1).max(80)).min(1).max(30)
    }),
    citation: z
      .object({
        ingestionMode: z.enum(["full_text", "metadata_only"]),
        licenseClass: z.enum(["open", "metadata_only"])
      })
      .loose(),
    review: z.object({
      status: z.literal("required"),
      requirements: z.array(z.string().trim().min(1).max(500)).min(1).max(20)
    }),
    sections: z
      .array(
        z
          .object({
            pageStart: z.number().int().positive().optional(),
            pageEnd: z.number().int().positive().optional(),
            sourceSection: z.string().trim().min(1).max(300).optional(),
            sectionPath: z
              .array(z.string().trim().min(1).max(200))
              .min(1)
              .max(12),
            keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(40),
            content: z.string().trim().min(40).max(10_000),
            originalExcerptPage: z.number().int().positive().optional(),
            originalExcerpt: z.string().trim().min(12).max(1_200).optional(),
            chineseStatement: z.string().trim().min(40).max(10_000).optional(),
            applicability: z.string().trim().min(20).max(2_000).optional(),
            licenseClass: z.enum(["open", "metadata_only"]).optional(),
            contentHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/u, "contentHash must be SHA-256 hex.")
              .optional(),
            reviewStatus: z.literal("required").optional(),
            auditIssue: z.string().trim().min(1).max(1_000).optional()
          })
          .superRefine((section, context) => {
            if (
              section.pageStart !== undefined &&
              section.pageEnd !== undefined &&
              section.pageEnd < section.pageStart
            ) {
              context.addIssue({
                code: "custom",
                path: ["pageEnd"],
                message: "pageEnd must not be before pageStart."
              });
            }

            const auditValues = [
              section.originalExcerptPage,
              section.originalExcerpt,
              section.chineseStatement,
              section.applicability,
              section.licenseClass,
              section.contentHash,
              section.reviewStatus
            ];
            const hasAuditValue = auditValues.some(
              (value) => value !== undefined
            );
            if (
              hasAuditValue &&
              auditValues.some((value) => value === undefined)
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "Audited sections require excerpt page, excerpt, Chinese statement, applicability, license class, content hash and review status."
              });
            }
            if (
              section.chineseStatement !== undefined &&
              section.chineseStatement !== section.content
            ) {
              context.addIssue({
                code: "custom",
                path: ["chineseStatement"],
                message:
                  "chineseStatement must equal content while the compatibility field remains in use."
              });
            }
            if (
              section.originalExcerptPage !== undefined &&
              section.pageStart !== undefined &&
              section.pageEnd !== undefined &&
              (section.originalExcerptPage < section.pageStart ||
                section.originalExcerptPage > section.pageEnd)
            ) {
              context.addIssue({
                code: "custom",
                path: ["originalExcerptPage"],
                message:
                  "originalExcerptPage must fall inside the section page range."
              });
            }
          })
      )
      .min(1)
      .max(200)
  })
  .superRefine((candidate, context) => {
    const fullText = candidate.citation.ingestionMode === "full_text";
    if (
      (fullText && candidate.citation.licenseClass !== "open") ||
      (!fullText && candidate.citation.licenseClass !== "metadata_only")
    ) {
      context.addIssue({
        code: "custom",
        path: ["citation", "licenseClass"],
        message: "licenseClass must match ingestionMode."
      });
    }

    if (fullText) {
      candidate.sections.forEach((section, index) => {
        const hasPageLocator =
          section.pageStart !== undefined && section.pageEnd !== undefined;
        if (!hasPageLocator && !section.sourceSection) {
          context.addIssue({
            code: "custom",
            path: ["sections", index],
            message:
              "Full-text evidence requires either a page range or a source section locator."
          });
        }
        if (
          hasCompleteKnowledgeSectionAudit(section) &&
          section.contentHash !==
            computeKnowledgeSectionContentHash({
              sourceCanonicalUrl: candidate.sourceCanonicalUrl,
              documentExternalKey: candidate.document.externalKey,
              section
            })
        ) {
          context.addIssue({
            code: "custom",
            path: ["sections", index, "contentHash"],
            message:
              "contentHash does not match the canonical audited section content."
          });
        }
      });
    }
  });

export type KnowledgeCandidate = z.infer<typeof knowledgeCandidateSchema>;

export type KnowledgeCandidateSection = KnowledgeCandidate["sections"][number];

function canonicalText(value: string): string {
  return value.replaceAll("\r\n", "\n").trim();
}

export function canonicalizeKnowledgeSectionContent(input: {
  sourceCanonicalUrl: string;
  documentExternalKey: string;
  section: KnowledgeCandidateSection;
}): string {
  const { section } = input;
  return `${JSON.stringify({
    schema: "openvac-cern-section-audit-v1",
    sourceCanonicalUrl: input.sourceCanonicalUrl,
    documentExternalKey: input.documentExternalKey,
    pageStart: section.pageStart ?? null,
    pageEnd: section.pageEnd ?? null,
    sourceSection: section.sourceSection
      ? canonicalText(section.sourceSection)
      : null,
    originalExcerptPage: section.originalExcerptPage ?? null,
    sectionPath: section.sectionPath.map(canonicalText),
    keywords: section.keywords.map(canonicalText),
    originalExcerpt: section.originalExcerpt
      ? canonicalText(section.originalExcerpt)
      : null,
    chineseStatement: section.chineseStatement
      ? canonicalText(section.chineseStatement)
      : canonicalText(section.content),
    applicability: section.applicability
      ? canonicalText(section.applicability)
      : null,
    licenseClass: section.licenseClass ?? null
  })}\n`;
}

export function computeKnowledgeSectionContentHash(input: {
  sourceCanonicalUrl: string;
  documentExternalKey: string;
  section: KnowledgeCandidateSection;
}): string {
  return createHash("sha256")
    .update(canonicalizeKnowledgeSectionContent(input), "utf8")
    .digest("hex");
}

export function hasCompleteKnowledgeSectionAudit(
  section: KnowledgeCandidateSection
): section is KnowledgeCandidateSection & {
  originalExcerptPage: number;
  originalExcerpt: string;
  chineseStatement: string;
  applicability: string;
  licenseClass: "open" | "metadata_only";
  contentHash: string;
  reviewStatus: "required";
} {
  return (
    section.originalExcerptPage !== undefined &&
    section.originalExcerpt !== undefined &&
    section.chineseStatement !== undefined &&
    section.applicability !== undefined &&
    section.licenseClass !== undefined &&
    section.contentHash !== undefined &&
    section.reviewStatus === "required"
  );
}

export function parseKnowledgeCandidate(value: unknown): KnowledgeCandidate {
  return knowledgeCandidateSchema.parse(value);
}

export function renderKnowledgeCandidate(
  candidate: KnowledgeCandidate
): string {
  return candidate.sections
    .map((section) => {
      const marker =
        section.pageStart === undefined
          ? ""
          : `<!-- openvac-page:${section.pageStart} -->\n`;
      const pageRange =
        section.pageStart === undefined
          ? ""
          : `\n\n来源页码：${section.pageStart}${
              section.pageEnd && section.pageEnd !== section.pageStart
                ? `–${section.pageEnd}`
                : ""
            }`;
      const sourceSection = section.sourceSection
        ? `\n\n来源章节：${section.sourceSection}`
        : "";
      const audit = hasCompleteKnowledgeSectionAudit(section)
        ? `\n\n原文摘录（印刷页 ${section.originalExcerptPage}）：${section.originalExcerpt}\n\n适用条件：${section.applicability}\n\n块审核：${section.reviewStatus}；许可：${section.licenseClass}；SHA-256：${section.contentHash}`
        : "";
      return `${marker}# ${section.sectionPath.join(" > ")}\n\n${section.chineseStatement ?? section.content}${pageRange}${sourceSection}${audit}\n\n关键词：${section.keywords.join("、")}`;
    })
    .join("\n\n");
}
