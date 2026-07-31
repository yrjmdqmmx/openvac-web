import { handleCreateSource, handleListSources } from "@/server/api/admin";

export async function GET(request: Request): Promise<Response> {
  return handleListSources(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateSource(request);
}
