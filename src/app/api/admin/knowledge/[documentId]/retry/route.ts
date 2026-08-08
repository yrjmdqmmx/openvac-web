import { handleRetryKnowledgeAutomation } from "@/server/knowledge/manual-review-api";

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> }
): Promise<Response> {
  const { documentId } = await context.params;
  return handleRetryKnowledgeAutomation(request, documentId);
}
