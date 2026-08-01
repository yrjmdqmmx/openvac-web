import { handleCancelModelingJob } from "@/server/modeling/api";

type Context = { params: Promise<{ jobId: string }> };

export async function POST(
  request: Request,
  context: Context
): Promise<Response> {
  const { jobId } = await context.params;
  return handleCancelModelingJob(request, jobId);
}
