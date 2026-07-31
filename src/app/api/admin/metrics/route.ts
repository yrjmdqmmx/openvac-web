import { handleGetMetrics } from "@/server/api/admin";

export async function GET(request: Request): Promise<Response> {
  return handleGetMetrics(request);
}
