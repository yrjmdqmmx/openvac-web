import { handleSetUserQuota } from "@/server/api/admin";

type Context = {
  params: Promise<{ userId: string }>;
};

export async function PATCH(
  request: Request,
  context: Context
): Promise<Response> {
  const { userId } = await context.params;
  return handleSetUserQuota(request, userId);
}
