import { handleConfirmAiPlan } from "@/server/modeling/api";

type Context = { params: Promise<{ planId: string }> };

export async function POST(
  request: Request,
  context: Context
): Promise<Response> {
  const { planId } = await context.params;
  return handleConfirmAiPlan(request, planId);
}
