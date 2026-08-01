import { handleDownloadModelingArtifact } from "@/server/modeling/api";

type Context = { params: Promise<{ artifactId: string }> };

export async function GET(
  request: Request,
  context: Context
): Promise<Response> {
  const { artifactId } = await context.params;
  return handleDownloadModelingArtifact(request, artifactId);
}
