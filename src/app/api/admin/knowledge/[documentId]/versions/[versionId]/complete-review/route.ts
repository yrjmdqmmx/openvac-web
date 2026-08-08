import { handleCompleteKnowledgeSectionReview } from "@/server/knowledge/review-sections-api";

type Context = {
  params: Promise<{ documentId: string; versionId: string }>;
};

export async function POST(
  request: Request,
  context: Context
): Promise<Response> {
  return handleCompleteKnowledgeSectionReview(request, await context.params);
}
