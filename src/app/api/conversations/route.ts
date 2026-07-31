import {
  handleCreateConversation,
  handleListConversations
} from "@/server/api/conversations";

export async function GET(request: Request): Promise<Response> {
  return handleListConversations(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateConversation(request);
}
