import { handleImportKnowledgeCandidate } from "@/server/api/admin";

export async function POST(request: Request): Promise<Response> {
  return handleImportKnowledgeCandidate(request);
}
