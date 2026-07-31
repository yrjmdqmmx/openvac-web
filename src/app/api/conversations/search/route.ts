import { handleSearchConversations } from "@/server/api/conversations";

export async function GET(request: Request): Promise<Response> {
  return handleSearchConversations(request);
}
