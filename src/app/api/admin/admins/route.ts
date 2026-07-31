import {
  handleGrantAdminRole,
  handleListAdmins,
  handleRevokeAdminRole
} from "@/server/api/admin";

export async function GET(request: Request): Promise<Response> {
  return handleListAdmins(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleGrantAdminRole(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handleRevokeAdminRole(request);
}
