import { handleGetSettings, handleUpdateSettings } from "@/server/api/admin";

export async function GET(request: Request): Promise<Response> {
  return handleGetSettings(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleUpdateSettings(request);
}
