import {
  handleCreateModelingProject,
  handleListModelingProjects
} from "@/server/modeling/api";

export async function GET(request: Request): Promise<Response> {
  return handleListModelingProjects(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateModelingProject(request);
}
