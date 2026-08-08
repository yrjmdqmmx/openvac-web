import { handleInitiateKnowledgeOriginalUpload } from "@/server/knowledge/original-upload-api";

export async function POST(request: Request): Promise<Response> {
  return handleInitiateKnowledgeOriginalUpload(request);
}
