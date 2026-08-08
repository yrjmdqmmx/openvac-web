import { ApiError } from "@/server/api/errors";
import type {
  InvocationHandle,
  StartInvocationInput
} from "@/server/operations/model-runtime";
import {
  ProviderError,
  type ResponsesProvider,
  type ResponsesStreamEvent,
  type ResponsesUsage
} from "@/server/providers";

export type PromptEvaluationVersion = {
  id: string;
  key: string;
  version: number;
  content: string;
};

type CompleteInput = {
  handle: InvocationHandle;
  usage?: ResponsesUsage;
  providerRequestId?: string;
  finishReason?: string;
  firstEventLatencyMs?: number;
  providerHttpStatus?: number;
};

type FailInput = {
  handle: InvocationHandle;
  errorCode: string;
  errorMessage: string;
  providerHttpStatus?: number;
  providerErrorCode?: string;
  retainReservedEstimate?: boolean;
};

export type PromptEvaluationDependencies = {
  provider: ResponsesProvider;
  startInvocation(input: StartInvocationInput): Promise<InvocationHandle>;
  completeInvocation(input: CompleteInput): Promise<void>;
  failInvocation(input: FailInput): Promise<void>;
};

export async function executePromptEvaluation(
  input: {
    actorUserId: string;
    clientRequestId: string;
    userPartition: string;
    prompt: PromptEvaluationVersion;
    input: string;
  },
  dependencies: PromptEvaluationDependencies
): Promise<{
  output: string;
  model: string;
  promptKey: string;
  promptVersion: number;
  usage?: ResponsesUsage;
}> {
  const handle = await dependencies.startInvocation({
    userId: input.actorUserId,
    clientRequestId: input.clientRequestId,
    provider: dependencies.provider.id,
    model: dependencies.provider.model,
    messages: [
      { role: "system", content: input.prompt.content },
      { role: "user", content: input.input }
    ],
    maximumOutputTokens: 512,
    promptVersionId: input.prompt.id,
    evidenceSourceIds: [],
    webSearched: false,
    protocol: "responses",
    phase: "admin_prompt_test",
    purpose: "evaluation",
    priceVersion: process.env.MODEL_PRICE_VERSION
  });

  let terminal: Extract<ResponsesStreamEvent, { type: "finish" }> | undefined;
  try {
    for await (const event of dependencies.provider.stream({
      instructions: input.prompt.content,
      input: input.input,
      toolChoice: "none",
      reasoningEffort: "none",
      maxOutputTokens: 512,
      user: input.userPartition,
      signal: AbortSignal.timeout(30_000)
    })) {
      if (event.type === "finish") terminal = event;
    }
    if (
      !terminal ||
      terminal.status !== "completed" ||
      !terminal.outputText.trim()
    ) {
      throw new ApiError(
        503,
        "PROMPT_TEST_INCOMPLETE",
        "提示词测试未产生完整结果。"
      );
    }
    await dependencies.completeInvocation({
      handle,
      usage: terminal.usage,
      providerRequestId: terminal.providerRequestId,
      finishReason: terminal.status,
      firstEventLatencyMs: terminal.firstEventLatencyMs,
      providerHttpStatus: 200
    });
    return {
      output: terminal.outputText,
      model: dependencies.provider.model,
      promptKey: input.prompt.key,
      promptVersion: input.prompt.version,
      usage: terminal.usage
    };
  } catch (error) {
    await dependencies
      .failInvocation({
        handle,
        errorCode: "ADMIN_PROMPT_TEST_FAILED",
        errorMessage:
          error instanceof Error ? error.name : "Unknown prompt test failure.",
        providerHttpStatus:
          error instanceof ProviderError ? error.status : undefined,
        providerErrorCode:
          error instanceof ProviderError ? error.name : undefined,
        retainReservedEstimate: true
      })
      .catch(() => undefined);
    if (error instanceof ApiError) throw error;
    if (error instanceof ProviderError && error.status === 401) {
      throw new ApiError(
        503,
        "PROVIDER_AUTHENTICATION_FAILED",
        "DeepSeek 身份验证失败。"
      );
    }
    if (error instanceof ProviderError && error.status === 402) {
      throw new ApiError(
        503,
        "PROVIDER_BILLING_REQUIRED",
        "DeepSeek 余额或计费状态不可用。"
      );
    }
    throw new ApiError(503, "PROMPT_TEST_FAILED", "提示词测试失败。");
  }
}
