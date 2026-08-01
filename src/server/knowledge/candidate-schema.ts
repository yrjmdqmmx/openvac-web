import { z } from "zod";

const httpsUrl = z
  .url()
  .refine((value) => new URL(value).protocol === "https:", {
    message: "Knowledge source links must use HTTPS."
  });

export const knowledgeCandidateSchema = z.object({
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
          sectionPath: z
            .array(z.string().trim().min(1).max(200))
            .min(1)
            .max(12),
          keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(40),
          content: z.string().trim().min(40).max(10_000)
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
        })
    )
    .min(1)
    .max(200)
});

export type KnowledgeCandidate = z.infer<typeof knowledgeCandidateSchema>;

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
      return `${marker}# ${section.sectionPath.join(" > ")}\n\n${section.content}${pageRange}\n\n关键词：${section.keywords.join("、")}`;
    })
    .join("\n\n");
}
