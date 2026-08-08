import { handleCompleteKnowledgeOriginalUpload } from "@/server/knowledge/original-upload-api";

export async function POST(
  request: Request,
  context: { params: Promise<{ versionId: string }> }
): Promise<Response> {
  const { versionId } = await context.params;
  return handleCompleteKnowledgeOriginalUpload(request, versionId);
}
