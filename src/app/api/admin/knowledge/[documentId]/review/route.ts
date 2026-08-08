import { handleReviewKnowledgeDocument } from "@/server/api/admin";
import { handleGetKnowledgeSectionReview } from "@/server/knowledge/review-sections-api";

type Context = {
  params: Promise<{ documentId: string }>;
};

export async function GET(
  request: Request,
  context: Context
): Promise<Response> {
  const { documentId } = await context.params;
  return handleGetKnowledgeSectionReview(request, documentId);
}

export async function POST(
  request: Request,
  context: Context
): Promise<Response> {
  const { documentId } = await context.params;
  return handleReviewKnowledgeDocument(request, documentId);
}
