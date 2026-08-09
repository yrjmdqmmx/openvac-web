import { handleInitiateChatAttachment } from "@/server/chat-attachments/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleInitiateChatAttachment(request);
}
