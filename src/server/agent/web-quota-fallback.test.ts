import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/quota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/quota")>();
  return {
    ...actual,
    reserveWebSearchQuota: vi.fn(async () => {
      throw new actual.QuotaExceededError({
        resource: "web_search",
        scopeType: "user",
        limit: 5,
        resetAt: new Date("2026-08-10T00:00:00.000Z")
      });
    })
  };
});

import type { ResponsesProvider } from "@/server/providers";
import { reserveWebSearchQuota } from "@/server/quota";
import type { AnswerV3 } from "@/types/chat-v3";

import {
  AgentRunOrchestrator,
  AgentRuntimeError,
  type OrchestratorEvent
} from "./orchestrator";
import { renderAnswerV3 } from "./answer-v3";
import type { EvidenceRegistry } from "./evidence-registry";
import type { RunStore } from "./run-store";

const provider = {
  id: "deepseek-responses",
  model: "deepseek-v4-flash",
  capabilities: {},
  stream: async function* () {
    throw new Error("provider must not run after quota denial");
  }
} as unknown as ResponsesProvider;

const run = {
  runId: "00000000-0000-4000-8000-000000000001",
  conversationId: "00000000-0000-4000-8000-000000000002",
  userMessageId: "00000000-0000-4000-8000-000000000003",
  assistantMessageId: "00000000-0000-4000-8000-000000000004",
  turnId: "00000000-0000-4000-8000-000000000005",
  question: "普通问题",
  inputParts: []
};

const unverifiedCurrentAnswer: AnswerV3 = {
  schemaVersion: "openvac.answer.v3",
  answerKind: "direct",
  riskLevel: "low",
  blocks: [
    {
      type: "paragraph",
      text: "最新型号已经发布。",
      evidenceIds: []
    }
  ],
  missingInputs: [],
  usedEvidenceIds: [],
  usedLinkIds: []
};

function subject(webDomainPolicyLoader: () => Promise<[]> = async () => []) {
  const recordToolCall = vi.fn(async () => undefined);
  const events: OrchestratorEvent[] = [];
  const orchestrator = new AgentRunOrchestrator(
    provider,
    { recordToolCall } as unknown as RunStore,
    (event) => events.push(event),
    { webDomainPolicyLoader }
  );
  const invoke = orchestrator as unknown as {
    proactiveWebSearch(
      input: Record<string, unknown>,
      signal: AbortSignal
    ): Promise<void>;
    validateOrRepair(input: Record<string, unknown>): Promise<AnswerV3>;
    calculations: Map<string, unknown>;
    evidence: EvidenceRegistry;
    webSearchFailure?: "quota_exhausted" | "no_validated_evidence";
  };
  return { orchestrator, invoke, recordToolCall, events };
}

function input(webMode: "auto" | "always") {
  return {
    userId: "user-1",
    userPartition: "partition_1",
    clientRequestId: "00000000-0000-4000-8000-000000000006",
    run,
    requestedMode: "auto",
    resolvedMode: "fast",
    webMode,
    riskLevel: "low",
    signal: new AbortController().signal
  };
}

describe("Agent V3 proactive web quota fallback", () => {
  it("does not reserve web quota when domain policy loading fails", async () => {
    const { invoke, recordToolCall } = subject(async () =>
      Promise.reject(new Error("policy database unavailable"))
    );
    const automatic = input("auto");
    vi.mocked(reserveWebSearchQuota).mockClear();

    await expect(
      invoke.proactiveWebSearch(automatic, automatic.signal)
    ).rejects.toThrow("policy database unavailable");
    expect(reserveWebSearchQuota).not.toHaveBeenCalled();
    expect(recordToolCall).not.toHaveBeenCalled();
  });

  it("does not reserve web quota after the run was cancelled", async () => {
    const { invoke, recordToolCall } = subject();
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const cancelled = { ...input("auto"), signal: controller.signal };
    vi.mocked(reserveWebSearchQuota).mockClear();

    await expect(
      invoke.proactiveWebSearch(cancelled, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(reserveWebSearchQuota).not.toHaveBeenCalled();
    expect(recordToolCall).not.toHaveBeenCalled();
  });

  it("records an automatic-search failure and continues without web evidence", async () => {
    const { orchestrator, invoke, recordToolCall, events } = subject();

    await expect(
      invoke.proactiveWebSearch(input("auto"), input("auto").signal)
    ).resolves.toBeUndefined();
    expect(recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "web_search",
        status: "failed",
        errorCode: "WEB_SEARCH_QUOTA_EXCEEDED",
        citationIds: []
      })
    );
    expect(orchestrator.counters.toolCalls).toBe(1);
    expect(events).toContainEqual({
      type: "tool",
      status: "failed",
      label: "联网搜索额度已用尽，未引入联网依据"
    });

    const answer = await invoke.validateOrRepair({
      ...input("auto"),
      run: { ...run, question: "目前有什么新型号？" },
      currentInput: [],
      outputText: JSON.stringify(unverifiedCurrentAnswer)
    });
    expect(renderAnswerV3(answer)).toContain("无法核验");
    expect(renderAnswerV3(answer)).not.toContain("最新型号已经发布");
  });

  it("keeps a validated server calculation when automatic web search is unavailable", async () => {
    const { invoke } = subject();
    const automatic = input("auto");
    await invoke.proactiveWebSearch(automatic, automatic.signal);
    invoke.calculations.set("calc_1", {
      id: "calc_1",
      tool: "estimate_pumpdown_time",
      formulaId: "p(t)=peq+(p0-peq)exp(-St/V)",
      formulaVersion: "1.1.0",
      normalizedInputs: {
        volumeM3: 0.1,
        speedM3S: 0.01,
        initialPa: 100,
        targetPa: 1,
        gasLoadPaM3S: 0
      },
      result: {
        reachable: true,
        equilibriumPressurePa: 0,
        time: 46.051702,
        unit: "s"
      },
      assumptions: ["容器充分混合；抽速与气载恒定。"],
      warnings: [],
      sourceIds: []
    });

    const answer = await invoke.validateOrRepair({
      ...automatic,
      riskLevel: "medium",
      run: {
        ...run,
        question: "估算从 100 Pa 抽到 1 Pa 的理想抽空时间。"
      },
      currentInput: [],
      outputText: "{}"
    });
    expect(answer.answerKind).toBe("expert");
    expect(renderAnswerV3(answer)).toContain("46.051702 秒");
    expect(renderAnswerV3(answer)).not.toContain("无法核验");
  });

  it("keeps ordinary non-time-sensitive answers after automatic quota exhaustion", async () => {
    const { invoke } = subject();
    const automatic = input("auto");
    await invoke.proactiveWebSearch(automatic, automatic.signal);
    const ordinary = {
      ...unverifiedCurrentAnswer,
      blocks: [
        {
          type: "paragraph" as const,
          text: "真空是低于环境压力的气体状态。",
          evidenceIds: []
        }
      ]
    };

    const answer = await invoke.validateOrRepair({
      ...automatic,
      run: { ...run, question: "什么是真空？" },
      currentInput: [],
      outputText: JSON.stringify(ordinary)
    });
    expect(renderAnswerV3(answer)).toContain("低于环境压力");
    expect(renderAnswerV3(answer)).not.toContain("无法核验");
  });

  it("accepts current-turn private evidence for a time-sensitive prompt", async () => {
    const { invoke } = subject();
    const automatic = input("auto");
    await invoke.proactiveWebSearch(automatic, automatic.signal);
    const evidenceId = invoke.evidence.addPrivate({
      sourceId: "attachment:file-1:chunk-1",
      title: "当前会话附件",
      excerpt: "当前附件记录的型号是 OV-100。"
    });
    const grounded: AnswerV3 = {
      ...unverifiedCurrentAnswer,
      blocks: [
        {
          type: "paragraph",
          text: "当前附件记录的型号是 OV-100。",
          evidenceIds: [evidenceId]
        }
      ],
      usedEvidenceIds: [evidenceId]
    };

    const answer = await invoke.validateOrRepair({
      ...automatic,
      run: { ...run, question: "当前附件记录了什么型号？" },
      currentInput: [],
      outputText: JSON.stringify(grounded)
    });
    expect(renderAnswerV3(answer)).toContain("OV-100");
    expect(renderAnswerV3(answer)).not.toContain("无法核验");
  });

  it("fails closed when forced DeepSeek web search produced no validated evidence", async () => {
    const { invoke } = subject();
    invoke.webSearchFailure = "no_validated_evidence";
    const required = input("always");

    const answer = await invoke.validateOrRepair({
      ...required,
      run: { ...run, question: "解释真空。" },
      currentInput: [],
      outputText: JSON.stringify(unverifiedCurrentAnswer)
    });
    expect(renderAnswerV3(answer)).toContain("DeepSeek 联网搜索");
    expect(renderAnswerV3(answer)).toContain("无法核验");
    expect(renderAnswerV3(answer)).not.toContain("最新型号已经发布");
  });

  it("fails explicitly when the user required web search", async () => {
    const { invoke, recordToolCall } = subject();
    const required = input("always");

    await expect(
      invoke.proactiveWebSearch(required, required.signal)
    ).rejects.toMatchObject({
      code: "WEB_SEARCH_QUOTA_EXCEEDED",
      retryable: false
    } satisfies Partial<AgentRuntimeError>);
    expect(recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "WEB_SEARCH_QUOTA_EXCEEDED" })
    );
  });
});
