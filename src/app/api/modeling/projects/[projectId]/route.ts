import {
  handleDeleteModelingProject,
  handleGetModelingProject,
  handleUpdateModelingProject
} from "@/server/modeling/api";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(
  request: Request,
  context: Context
): Promise<Response> {
  const { projectId } = await context.params;
  return handleGetModelingProject(request, projectId);
}

export async function PATCH(
  request: Request,
  context: Context
): Promise<Response> {
  const { projectId } = await context.params;
  return handleUpdateModelingProject(request, projectId);
}

export async function DELETE(
  request: Request,
  context: Context
): Promise<Response> {
  const { projectId } = await context.params;
  return handleDeleteModelingProject(request, projectId);
}
