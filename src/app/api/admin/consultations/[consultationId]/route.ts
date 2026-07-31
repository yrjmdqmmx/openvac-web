import { handleSetConsultationStatus } from "@/server/api/admin";

type Context = {
  params: Promise<{ consultationId: string }>;
};

export async function PATCH(
  request: Request,
  context: Context
): Promise<Response> {
  const { consultationId } = await context.params;
  return handleSetConsultationStatus(request, consultationId);
}
