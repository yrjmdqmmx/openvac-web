import { handleListModelingRevisions } from "@/server/modeling/api";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(
  request: Request,
  context: Context
): Promise<Response> {
  const { projectId } = await context.params;
  return handleListModelingRevisions(request, projectId);
}
