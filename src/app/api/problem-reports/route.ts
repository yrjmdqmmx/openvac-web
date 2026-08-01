import { handleCreateProblemReport } from "@/server/api/problem-reports";

export async function POST(request: Request): Promise<Response> {
  return handleCreateProblemReport(request);
}
