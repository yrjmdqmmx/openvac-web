import {
  handleDeleteAccountAvatar,
  handleGetAccountAvatar,
  handleUploadAccountAvatar
} from "@/server/account/avatar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleGetAccountAvatar(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleUploadAccountAvatar(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handleDeleteAccountAvatar(request);
}
