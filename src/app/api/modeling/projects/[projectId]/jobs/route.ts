import { handleCreateModelingJob } from "@/server/modeling/api/jobs";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await context.params;
  return handleCreateModelingJob(request, projectId);
}
