import { postAgentV3 } from "@/server/agent/http-v2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

/** Agent V3 is the only runtime chat path. Legacy payloads remain readable. */
export async function POST(request: Request): Promise<Response> {
  return postAgentV3(request);
}
