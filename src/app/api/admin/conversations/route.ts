import { handleListAdminConversations } from "@/server/api/admin";

export async function GET(request: Request): Promise<Response> {
  return handleListAdminConversations(request);
}
