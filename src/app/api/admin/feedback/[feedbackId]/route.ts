import { handleSetFeedbackStatus } from "@/server/api/admin";

type Context = {
  params: Promise<{ feedbackId: string }>;
};

export async function PATCH(
  request: Request,
  context: Context
): Promise<Response> {
  const { feedbackId } = await context.params;
  return handleSetFeedbackStatus(request, feedbackId);
}
