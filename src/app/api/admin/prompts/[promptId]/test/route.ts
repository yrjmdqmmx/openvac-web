import { eq } from "drizzle-orm";
import { z } from "zod";

import { executePromptEvaluation } from "@/server/admin/prompt-evaluation";
import { requireCapability } from "@/server/api/auth";
import {
  ApiError,
  jsonData,
  notFound,
  parseJson,
  withApiErrors
} from "@/server/api/errors";
import { uuidSchema } from "@/server/api/schemas";
import { apiStore } from "@/server/api/store";
import { db } from "@/server/db";
import { auditLogs, promptVersions } from "@/server/db/schema";
import {
  completeModelInvocation,
  failModelInvocation,
  startModelInvocation
} from "@/server/operations/model-runtime";
import {
  createDeepSeekUserPartition,
  getResponsesProvider
} from "@/server/providers";

const inputSchema = z
  .object({
    input: z.string().trim().min(1).max(4_000),
    confirm: z.literal("RUN_PROMPT_TEST")
  })
  .strict();

type Context = { params: Promise<{ promptId: string }> };

export const POST = withApiErrors(
  async (request: Request, context: Context): Promise<Response> => {
    const actor = await requireCapability(request, apiStore, "models:execute");
    const { promptId: rawPromptId } = await context.params;
    const promptId = uuidSchema.parse(rawPromptId);
    const input = await parseJson(request, inputSchema);
    const [prompt] = await db
      .select({
        id: promptVersions.id,
        key: promptVersions.key,
        version: promptVersions.version,
        content: promptVersions.content,
        status: promptVersions.status
      })
      .from(promptVersions)
      .where(eq(promptVersions.id, promptId))
      .limit(1);
    if (!prompt) throw notFound("提示词版本");
    if (prompt.status === "archived") {
      throw new ApiError(
        409,
        "PROMPT_VERSION_ARCHIVED",
        "已归档提示词版本不能执行新测试。"
      );
    }

    const requestId =
      request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const result = await executePromptEvaluation(
      {
        actorUserId: actor.id,
        clientRequestId: `admin-prompt-test:${requestId}`,
        userPartition: createDeepSeekUserPartition(
          actor.id,
          process.env.DEEPSEEK_USER_PARTITION_SECRET ?? ""
        ),
        prompt,
        input: input.input
      },
      {
        provider: getResponsesProvider(),
        startInvocation: startModelInvocation,
        completeInvocation: completeModelInvocation,
        failInvocation: failModelInvocation
      }
    );
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: actor.id,
      actorRole: actor.role,
      action: "prompt_version.test",
      targetType: "prompt_version",
      targetId: prompt.id,
      requestId,
      metadata: {
        promptKey: prompt.key,
        promptVersion: prompt.version,
        model: result.model,
        inputCharacters: input.input.length,
        outputCharacters: result.output.length,
        totalTokens: result.usage?.totalTokens ?? null
      },
      createdAt: new Date()
    });
    return jsonData(result);
  }
);
