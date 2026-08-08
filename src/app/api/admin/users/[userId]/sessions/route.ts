import { handleRevokeUserSessions } from "@/server/api/admin";

type Context = {
  params: Promise<{ userId: string }>;
};

export async function DELETE(
  request: Request,
  context: Context
): Promise<Response> {
  const { userId } = await context.params;
  return handleRevokeUserSessions(request, userId);
}
