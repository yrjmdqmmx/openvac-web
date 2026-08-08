import { describe, expect, it, vi } from "vitest";

import { executePromptEvaluation } from "./prompt-evaluation";

describe("prompt evaluation", () => {
  it("runs the selected immutable version and records the evaluation usage", async () => {
    const complete = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const stream = vi.fn(async function* () {
      yield { type: "text-delta" as const, text: "测试" };
      yield {
        type: "finish" as const,
        status: "completed" as const,
        responseId: "response-1",
        outputText: "测试结果",
        continuationItems: [],
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        providerRequestId: "provider-1"
      };
    });

    const result = await executePromptEvaluation(
      {
        actorUserId: "owner-1",
        clientRequestId: "request-1",
        userPartition: "partition-1",
        prompt: {
          id: "prompt-1",
          key: "vacuum_expert_system",
          version: 2,
          content: "只根据可靠证据回答。"
        },
        input: "扩散泵返油怎么办？"
      },
      {
        provider: {
          id: "deepseek",
          model: "deepseek-chat",
          capabilities: {} as never,
          stream
        },
        startInvocation: vi.fn(async () => ({
          id: "invocation-1",
          provider: "deepseek",
          model: "deepseek-chat",
          startedAt: new Date(),
          reservedCostMicros: 0,
          estimatedInputTokens: 12,
          maximumOutputTokens: 512,
          pricing: {
            inputMicrosPerMillionTokens: 0,
            outputMicrosPerMillionTokens: 0
          }
        })),
        completeInvocation: complete,
        failInvocation: fail
      }
    );

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: "只根据可靠证据回答。",
        input: "扩散泵返油怎么办？",
        toolChoice: "none",
        user: "partition-1"
      })
    );
    expect(result).toMatchObject({
      output: "测试结果",
      model: "deepseek-chat",
      promptVersion: 2,
      usage: { totalTokens: 16 }
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
  });
});
