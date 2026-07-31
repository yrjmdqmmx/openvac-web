import { handleDeleteSource, handleUpdateSource } from "@/server/api/admin";

type Context = {
  params: Promise<{ sourceId: string }>;
};

export async function PATCH(
  request: Request,
  context: Context
): Promise<Response> {
  const { sourceId } = await context.params;
  return handleUpdateSource(request, sourceId);
}

export async function DELETE(
  request: Request,
  context: Context
): Promise<Response> {
  const { sourceId } = await context.params;
  return handleDeleteSource(request, sourceId);
}
