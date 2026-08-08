import { handleSubmitKnowledgeReviewResult } from "@/server/knowledge/automation-review-api";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  return handleSubmitKnowledgeReviewResult(request, id);
}
