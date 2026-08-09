import { handleGetChatAttachmentStatus } from "@/server/chat-attachments/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ attachmentId: string }> };

export async function GET(
  request: Request,
  context: Context
): Promise<Response> {
  const { attachmentId } = await context.params;
  return handleGetChatAttachmentStatus(request, attachmentId);
}
