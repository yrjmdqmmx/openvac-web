import { handleGetBudgets, handleUpdateBudgets } from "@/server/api/admin";

export async function GET(request: Request): Promise<Response> {
  return handleGetBudgets(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleUpdateBudgets(request);
}
