import {
  handleGetAccountProfile,
  handleUpdateAccountProfile
} from "@/server/api/account-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleGetAccountProfile(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleUpdateAccountProfile(request);
}
