import { handleCreateAiPlan, handleListAiPlans } from "@/server/modeling/api";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(
  request: Request,
  context: Context
): Promise<Response> {
  const { projectId } = await context.params;
  return handleListAiPlans(request, projectId);
}

export async function POST(
  request: Request,
  context: Context
): Promise<Response> {
  const { projectId } = await context.params;
  return handleCreateAiPlan(request, projectId);
}
