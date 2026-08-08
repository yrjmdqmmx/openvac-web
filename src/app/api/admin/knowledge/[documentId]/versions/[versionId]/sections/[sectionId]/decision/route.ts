import { handleKnowledgeSectionDecision } from "@/server/knowledge/review-sections-api";

type Context = {
  params: Promise<{
    documentId: string;
    versionId: string;
    sectionId: string;
  }>;
};

export async function POST(
  request: Request,
  context: Context
): Promise<Response> {
  return handleKnowledgeSectionDecision(request, await context.params);
}
