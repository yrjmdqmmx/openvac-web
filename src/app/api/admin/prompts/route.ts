import { handleCreatePrompt, handleListPrompts } from "@/server/api/admin";

export async function GET(request: Request): Promise<Response> {
  return handleListPrompts(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleCreatePrompt(request);
}
