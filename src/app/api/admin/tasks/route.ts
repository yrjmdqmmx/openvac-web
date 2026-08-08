import {
  handleListAdminTasks,
  handleUpdateAdminTaskState
} from "@/server/api/admin";

export async function GET(request: Request): Promise<Response> {
  return handleListAdminTasks(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleUpdateAdminTaskState(request);
}
