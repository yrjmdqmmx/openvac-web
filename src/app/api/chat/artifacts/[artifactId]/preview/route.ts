import { handlePreviewChatArtifact } from "@/server/chat-attachments/artifact-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ artifactId: string }> };

export async function GET(
  request: Request,
  context: Context
): Promise<Response> {
  const { artifactId } = await context.params;
  return handlePreviewChatArtifact(request, artifactId);
}
