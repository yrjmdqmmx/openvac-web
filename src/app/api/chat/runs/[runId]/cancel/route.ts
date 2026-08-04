import { cancelAgentRunV2 } from "@/server/agent/http-v2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  return cancelAgentRunV2(request, runId);
}
