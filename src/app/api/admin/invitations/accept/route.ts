import { handleAcceptAdminInvitation } from "@/server/api/admin";

export async function POST(request: Request): Promise<Response> {
  return handleAcceptAdminInvitation(request);
}
