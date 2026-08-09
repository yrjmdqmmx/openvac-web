import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  ResponsesProvider,
  ResponsesStreamRequest
} from "@/server/providers";

import { ANSWER_V3_CASE_VERSION, ANSWER_V3_EVAL_CASES } from "./cases";
import { createFixtureEvalDependencies } from "./fixtures";
import {
  QwenTextAnswerV3Judge,
  RuntimeEvidenceCandidate,
  createRuntimeEvidenceEvalDependencies
} from "./live-adapter";
import {
  loadRuntimeEvidence,
  runtimeEvidenceSchema,
  type RuntimeEvidence
} from "./runtime-evidence";
import type { AnswerV3EvalCase, AnswerV3Judge } from "./types";

const GIT_SHA = "a".repeat(40);
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const BASE_URL = "https://staging-openvac.openvac.cn/";

describe("Answer V3 runtime-evidence adapter", () => {
  it("loads checksum-bound staging evidence and returns its candidate output unchanged", async () => {
    const source = await runtimeEvidence();
    const loaded = await writeAndLoad(source);
    const candidate = new RuntimeEvidenceCandidate(loaded);
    const testCase = ANSWER_V3_EVAL_CASES[0]!;

    const output = await candidate.execute(testCase);
    const stored = loaded.cases.find((item) => item.caseId === testCase.id)!;

    expect(output).toEqual({
      provider: stored.provider,
      model: stored.model,
      answer: stored.answer,
      verifiedLinks: stored.verifiedLinks,
      browserEvents: stored.browserEvents,
      toolAudit: stored.toolAudit,
      authorizationAudit: stored.authorizationAudit,
      observedFacts: stored.observedFacts
    });
  });

  it("does not send expected-only facts to a candidate provider", async () => {
    const evidence = await runtimeEvidence();
    const candidate = new RuntimeEvidenceCandidate(evidence);
    const source = ANSWER_V3_EVAL_CASES[0]!;
    const testCase: AnswerV3EvalCase = {
      ...source,
      expected: { ...source.expected, facts: ["EXPECTED_ONLY_SENTINEL"] }
    };

    const output = await candidate.execute(testCase);

    expect(JSON.stringify(output)).not.toContain("EXPECTED_ONLY_SENTINEL");
  });

  it.each([
    ["missing case", (value: RuntimeEvidence) => value.cases.pop()],
    [
      "wrong provider route",
      (value: RuntimeEvidence) => {
        value.cases[0]!.provider =
          value.cases[0]!.provider === "deepseek" ? "qwen" : "deepseek";
      }
    ],
    [
      "fixture model marker",
      (value: RuntimeEvidence) => {
        value.cases[0]!.model = "fixture-model";
      }
    ],
    [
      "forged observed fact",
      (value: RuntimeEvidence) => {
        value.cases[0]!.observedFacts = ["NOT_PRESENT_IN_VISIBLE_ANSWER"];
      }
    ],
    [
      "cross-run SSE",
      (value: RuntimeEvidence) => {
        value.cases[0]!.browserEvents[0]!.runId = randomUUID();
      }
    ],
    [
      "empty permission evidence",
      (value: RuntimeEvidence) => {
        const item = runtimeCase(value, "v3-document-manual-01");
        item.toolAudit = [];
        item.authorizationAudit = [];
      }
    ],
    [
      "missing required multi-turn calculator",
      (value: RuntimeEvidence) => {
        const item = runtimeCase(value, "v3-multiturn-tool-02");
        item.toolAudit = item.toolAudit.filter(
          (audit) => audit.name !== "estimate_pumpdown_time"
        );
      }
    ],
    [
      "failed required multi-turn calculator",
      (value: RuntimeEvidence) => {
        const item = runtimeCase(value, "v3-multiturn-tool-02");
        const audit = item.toolAudit.find(
          (entry) => entry.name === "estimate_pumpdown_time"
        )!;
        audit.status = "failed";
      }
    ],
    [
      "wrong permission tool",
      (value: RuntimeEvidence) => {
        const item = runtimeCase(value, "v3-document-manual-01");
        item.toolAudit[0]!.name = "wrong_attachment_tool";
      }
    ],
    [
      "duplicate expected permission tool",
      (value: RuntimeEvidence) => {
        const item = runtimeCase(value, "v3-document-manual-01");
        item.toolAudit.push({
          ...item.toolAudit[0]!,
          callId: "duplicate-call"
        });
      }
    ],
    [
      "forged DB denial",
      (value: RuntimeEvidence) => {
        const item = runtimeCase(value, "v3-multiturn-permission-01");
        (item.toolAudit as unknown[]).push({
          callId: "forged-denial",
          runId: item.runId,
          name: "read_cross_conversation_attachment",
          permission: "denied",
          executed: false,
          status: "denied",
          source: "postgres_agent_tool_call"
        });
      }
    ],
    [
      "wrong ownership denial code",
      (value: RuntimeEvidence) => {
        const outcome = runtimeCase(
          value,
          "v3-multiturn-permission-01"
        ).authorizationOutcome!;
        (outcome as unknown as { machineErrorCode: string }).machineErrorCode =
          "RATE_LIMITED";
      }
    ],
    [
      "denial query bound to the later completed run",
      (value: RuntimeEvidence) => {
        const item = runtimeCase(value, "v3-multiturn-permission-01");
        item.authorizationOutcome!.agentToolCallQueryRunId = item.runId;
        item.authorizationAudit[0]!.runId = item.runId;
      }
    ]
  ])("rejects %s without fallback", async (_label, mutate) => {
    const evidence = await runtimeEvidence();
    mutate(evidence);
    await expect(writeAndLoad(evidence)).rejects.toThrow();
  });

  it("allows unrelated real DB tool rows while exact-matching permission tools", async () => {
    const evidence = await runtimeEvidence();
    const item = runtimeCase(evidence, "v3-document-manual-01");
    item.toolAudit.push({
      callId: "extra-knowledge-call",
      runId: item.runId,
      name: "search_knowledge",
      permission: "allowed",
      executed: true,
      status: "completed",
      source: "postgres_agent_tool_call"
    });

    await expect(writeAndLoad(evidence)).resolves.toMatchObject({
      caseVersion: ANSWER_V3_CASE_VERSION
    });
  });

  it("rejects a tampered evidence file checksum", async () => {
    const evidence = await runtimeEvidence();
    const directory = await mkdtemp(
      join(tmpdir(), "openvac-runtime-evidence-")
    );
    const path = join(directory, "evidence.json");
    await writeFile(path, JSON.stringify(evidence), "utf8");

    await expect(
      loadRuntimeEvidence({
        path,
        checksumSha256: "0".repeat(64),
        gitSha: GIT_SHA,
        imageDigest: IMAGE_DIGEST,
        baseUrl: BASE_URL
      })
    ).rejects.toThrow("checksum mismatch");
  });

  it("keeps real independent judges while using runtime evidence as the candidate authority", async () => {
    const evidence = await runtimeEvidence();
    const dependencies = createRuntimeEvidenceEvalDependencies(evidence, {
      deepseekProvider: fakeDeepSeek(),
      qwenJudge: acceptingJudge("qwen"),
      deepseekJudge: acceptingJudge("deepseek"),
      userPartition: "ov1_test-partition",
      deepseekAvailable: true
    });

    expect(dependencies.candidate).toBeInstanceOf(RuntimeEvidenceCandidate);
    expect(dependencies.qwenJudge.provider).toBe("qwen");
    expect(dependencies.deepseekJudge.provider).toBe("deepseek");
  });

  it("uses an independent Qwen JSON judge and fails availability closed without a key", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toContain("/chat/completions");
        expect(init?.method).toBe("POST");
        return Response.json({
          choices: [
            { message: { content: '{"score":91,"reason":"满足量表"}' } }
          ]
        });
      }
    );
    const configured = new QwenTextAnswerV3Judge({
      apiKey: "test-key",
      model: "qwen-independent",
      fetch: fetchMock
    });
    const unavailable = new QwenTextAnswerV3Judge({ apiKey: "" });
    const testCase = ANSWER_V3_EVAL_CASES[0]!;
    const evidence = await runtimeEvidence();
    const output = await new RuntimeEvidenceCandidate(evidence).execute(
      testCase
    );

    await expect(configured.available()).resolves.toBe(true);
    await expect(unavailable.available()).resolves.toBe(false);
    await expect(configured.score({ testCase, output })).resolves.toEqual({
      score: 91,
      reason: "满足量表"
    });
    const sent = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)
    ) as { model: string; messages: Array<{ content: string }> };
    expect(sent.model).toBe("qwen-independent");
    expect(sent.messages[1]?.content).toContain(testCase.expected.facts[0]!);
  });

  it("contains no candidate-side constructors for deterministic gate evidence", async () => {
    const source = await readFile(
      new URL("./live-adapter.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toContain("browserEventsFor");
    expect(source).not.toContain("toolAuditFor");
    expect(source).not.toContain("verifiedLinksFor");
    expect(source).not.toContain("createFixtureEvalDependencies");
    expect(source).toContain("ANSWER_V3_RUNTIME_EVIDENCE");
  });
});

async function runtimeEvidence(): Promise<RuntimeEvidence> {
  const fixture = createFixtureEvalDependencies();
  const cases = await Promise.all(
    ANSWER_V3_EVAL_CASES.map(async (testCase) => {
      const output = await fixture.candidate.execute(testCase);
      const runId = randomUUID();
      const chatRequestId = randomUUID();
      const conversationId = randomUUID();
      const turnId = randomUUID();
      const assistantMessageId = randomUUID();
      const browserEvents: Array<Record<string, unknown>> = [
        {
          type: "run.accepted",
          runId,
          sequence: 1,
          conversationId,
          turnId,
          userMessageId: randomUUID(),
          messageId: assistantMessageId,
          answerVersion: 1
        },
        ...output.answer.blocks.map((block, index) => ({
          type: "answer.block.committed",
          runId,
          sequence: index + 2,
          block,
          index
        })),
        {
          type: "run.completed",
          runId,
          sequence: output.answer.blocks.length + 2,
          conversationId,
          turnId,
          messageId: assistantMessageId,
          answerVersion: 1,
          answer: output.answer,
          meta: { verifiedLinks: output.verifiedLinks }
        }
      ];
      const toolAudit = output.toolAudit.map((audit, index) => ({
        callId: `call-${index}-${testCase.id}`,
        runId,
        name: audit.name,
        permission: "allowed" as const,
        executed: true as const,
        status: "completed" as const,
        source: "postgres_agent_tool_call" as const
      }));
      const crossConversation = testCase.id === "v3-multiturn-permission-01";
      const deniedClientRequestId = randomUUID();
      const deniedRunId = randomUUID();
      const authorizationAudit = (output.authorizationAudit ?? []).map(
        (audit) => ({
          ...audit,
          runId: deniedRunId,
          clientRequestId: deniedClientRequestId,
          source: "staging_http_response" as const
        })
      );
      return {
        caseId: testCase.id,
        runId,
        provider: output.provider,
        model:
          output.provider === "qwen" ? "qwen3-vl-plus" : "deepseek-v4-flash",
        answer: output.answer,
        verifiedLinks: output.verifiedLinks,
        browserEvents,
        toolAudit,
        authorizationAudit,
        ...(crossConversation
          ? {
              authorizationOutcome: {
                attempted: true as const,
                sourceConversationId: randomUUID(),
                targetConversationId: conversationId,
                attachmentId: randomUUID(),
                deniedClientRequestId,
                httpStatus: 409,
                machineErrorCode: "ATTACHMENT_BIND_CONFLICT" as const,
                outcome: "denied" as const,
                boundToTargetMessage: false as const,
                forbiddenToolExecuted: false as const,
                forbiddenAttachmentToolCallCount: 0 as const,
                agentToolCallQueryRunId: deniedRunId,
                deniedRunStatus: "failed" as const
              }
            }
          : {}),
        observedFacts: [],
        ...(output.artifactSpec ? { artifactSpec: output.artifactSpec } : {}),
        provenance: {
          fixture: false as const,
          gitSha: GIT_SHA,
          imageDigest: IMAGE_DIGEST,
          runId,
          chatRequestId,
          conversationId,
          turnId,
          assistantMessageId,
          capturedAt: "2026-08-09T00:00:00.000Z",
          chatSource: "staging_api_chat_sse" as const,
          toolAuditSource: "postgres_agent_tool_call" as const
        }
      };
    })
  );
  return runtimeEvidenceSchema.parse({
    schemaVersion: "openvac.answer-v3-runtime-evidence.v1",
    caseVersion: ANSWER_V3_CASE_VERSION,
    gitSha: GIT_SHA,
    imageDigest: IMAGE_DIGEST,
    generatedAt: "2026-08-09T00:00:00.000Z",
    source: { environment: "staging", baseUrl: BASE_URL },
    cases
  });
}

async function writeAndLoad(evidence: RuntimeEvidence) {
  const directory = await mkdtemp(join(tmpdir(), "openvac-runtime-evidence-"));
  const path = join(directory, "evidence.json");
  const bytes = Buffer.from(JSON.stringify(evidence), "utf8");
  await writeFile(path, bytes);
  return loadRuntimeEvidence({
    path,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    gitSha: GIT_SHA,
    imageDigest: IMAGE_DIGEST,
    baseUrl: BASE_URL
  });
}

function fakeDeepSeek(): ResponsesProvider {
  return {
    id: "deepseek-responses",
    model: "deepseek-v4-flash",
    capabilities: {
      protocol: "responses",
      semanticTerminalEvents: true,
      reasoningItems: true,
      functionTools: true,
      parallelFunctionCalls: true,
      nativeWebSearch: true,
      structuredOutputs: true
    },
    async *stream(_request: ResponsesStreamRequest) {
      void _request;
      yield {
        type: "finish",
        status: "completed",
        responseId: "judge-response",
        outputText: '{"score":95,"reason":"accepted"}',
        continuationItems: []
      };
    }
  };
}

function acceptingJudge(provider: "qwen" | "deepseek"): AnswerV3Judge {
  return {
    provider,
    model: `${provider}-independent-test`,
    available: async () => true,
    score: async () => ({ score: 95, reason: "accepted" })
  };
}

function runtimeCase(evidence: RuntimeEvidence, caseId: string) {
  const item = evidence.cases.find((candidate) => candidate.caseId === caseId);
  if (!item) throw new Error(`Missing runtime case ${caseId}`);
  return item;
}
