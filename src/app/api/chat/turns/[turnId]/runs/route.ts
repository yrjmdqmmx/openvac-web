import { postAgentActionV2 } from "@/server/agent/http-v2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(
  request: Request,
  context: { params: Promise<{ turnId: string }> }
) {
  const { turnId } = await context.params;
  return postAgentActionV2(request, turnId);
}
