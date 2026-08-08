import {
  handleCreateAdminInvitation,
  handleDeleteAdminInvitation,
  handleListAdminInvitations
} from "@/server/api/admin";

export async function GET(request: Request): Promise<Response> {
  return handleListAdminInvitations(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateAdminInvitation(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handleDeleteAdminInvitation(request);
}
