import { handleClearConversationData } from "@/server/api/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request): Promise<Response> {
  return handleClearConversationData(request);
}
