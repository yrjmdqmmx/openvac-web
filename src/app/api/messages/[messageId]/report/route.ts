import { handleMessageReport } from "@/server/api/messages";

type Context = {
  params: Promise<{ messageId: string }>;
};

export async function POST(
  request: Request,
  context: Context
): Promise<Response> {
  const { messageId } = await context.params;
  return handleMessageReport(request, messageId);
}
