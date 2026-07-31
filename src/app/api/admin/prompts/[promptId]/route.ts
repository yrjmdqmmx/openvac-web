import { handleUpdatePrompt } from "@/server/api/admin";

type Context = {
  params: Promise<{ promptId: string }>;
};

export async function PATCH(
  request: Request,
  context: Context
): Promise<Response> {
  const { promptId } = await context.params;
  return handleUpdatePrompt(request, promptId);
}
