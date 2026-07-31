import { handleReviewKnowledgeDocument } from "@/server/api/admin";

type Context = {
  params: Promise<{ documentId: string }>;
};

export async function POST(
  request: Request,
  context: Context
): Promise<Response> {
  const { documentId } = await context.params;
  return handleReviewKnowledgeDocument(request, documentId);
}
