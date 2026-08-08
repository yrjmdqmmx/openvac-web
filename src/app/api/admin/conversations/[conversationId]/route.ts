import { handleGetAdminConversation } from "@/server/api/admin";

type Context = { params: Promise<{ conversationId: string }> };

export async function GET(
  request: Request,
  context: Context
): Promise<Response> {
  const { conversationId } = await context.params;
  return handleGetAdminConversation(request, conversationId);
}
