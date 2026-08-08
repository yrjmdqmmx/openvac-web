import { handleClaimKnowledgeReviews } from "@/server/knowledge/automation-review-api";

export async function POST(request: Request): Promise<Response> {
  return handleClaimKnowledgeReviews(request);
}
