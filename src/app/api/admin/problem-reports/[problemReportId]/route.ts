import { handleSetProblemReportStatus } from "@/server/api/admin";

type Context = {
  params: Promise<{ problemReportId: string }>;
};

export async function PATCH(
  request: Request,
  context: Context
): Promise<Response> {
  const { problemReportId } = await context.params;
  return handleSetProblemReportStatus(request, problemReportId);
}
