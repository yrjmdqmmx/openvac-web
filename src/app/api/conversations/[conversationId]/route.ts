import {
  handleDeleteConversation,
  handleGetConversation,
  handleRenameConversation
} from "@/server/api/conversations";

type Context = {
  params: Promise<{ conversationId: string }>;
};

export async function GET(
  request: Request,
  context: Context
): Promise<Response> {
  const { conversationId } = await context.params;
  return handleGetConversation(request, conversationId);
}

export async function PATCH(
  request: Request,
  context: Context
): Promise<Response> {
  const { conversationId } = await context.params;
  return handleRenameConversation(request, conversationId);
}

export async function DELETE(
  request: Request,
  context: Context
): Promise<Response> {
  const { conversationId } = await context.params;
  return handleDeleteConversation(request, conversationId);
}
