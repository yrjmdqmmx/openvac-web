import { handleModelingJobEvents } from "@/server/modeling/api";

type Context = { params: Promise<{ jobId: string }> };

export async function GET(
  request: Request,
  context: Context
): Promise<Response> {
  const { jobId } = await context.params;
  return handleModelingJobEvents(request, jobId);
}
