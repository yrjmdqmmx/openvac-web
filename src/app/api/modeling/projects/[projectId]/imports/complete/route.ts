import { handleCompleteModelingImport } from "@/server/modeling/api";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(
  request: Request,
  context: Context
): Promise<Response> {
  const { projectId } = await context.params;
  return handleCompleteModelingImport(request, projectId);
}
