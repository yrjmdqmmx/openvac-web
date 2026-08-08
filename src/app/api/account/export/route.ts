import { handleExportAccountData } from "@/server/api/account-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleExportAccountData(request);
}
