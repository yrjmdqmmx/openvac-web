import { handleListAccountSessions } from "@/server/api/account-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleListAccountSessions(request);
}
