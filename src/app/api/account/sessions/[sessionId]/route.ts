import { handleRevokeAccountSession } from "@/server/api/account-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
): Promise<Response> {
  const { sessionId } = await context.params;
  return handleRevokeAccountSession(request, sessionId);
}
