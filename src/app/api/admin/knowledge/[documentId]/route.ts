import {
  handleGetKnowledgeDocument,
  handleUpdateKnowledgeDraft
} from "@/server/api/admin";

type Context = {
  params: Promise<{ documentId: string }>;
};

export async function PATCH(
  request: Request,
  context: Context
): Promise<Response> {
  const { documentId } = await context.params;
  return handleUpdateKnowledgeDraft(request, documentId);
}

export async function GET(
  request: Request,
  context: Context
): Promise<Response> {
  const { documentId } = await context.params;
  return handleGetKnowledgeDocument(request, documentId);
}
