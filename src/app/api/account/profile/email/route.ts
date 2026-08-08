import { handleChangeAccountEmail } from "@/server/api/account-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleChangeAccountEmail(request);
}
