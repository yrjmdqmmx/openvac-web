import {
  handleCreateKnowledgeDraft,
  handleListKnowledge
} from "@/server/api/admin";

export async function GET(request: Request): Promise<Response> {
  return handleListKnowledge(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateKnowledgeDraft(request);
}
