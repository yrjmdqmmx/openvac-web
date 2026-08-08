import { handleGetKnowledgeReviewPackage } from "@/server/knowledge/automation-review-api";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  return handleGetKnowledgeReviewPackage(request, id);
}
