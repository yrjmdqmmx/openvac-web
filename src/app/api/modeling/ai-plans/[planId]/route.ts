import { handleGetAiPlan } from "@/server/modeling/api";

type Context = { params: Promise<{ planId: string }> };

export async function GET(
  request: Request,
  context: Context
): Promise<Response> {
  const { planId } = await context.params;
  return handleGetAiPlan(request, planId);
}
