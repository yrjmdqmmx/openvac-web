import { createHash } from "node:crypto";

import {
  completeModelInvocation,
  failModelInvocation,
  startModelInvocation,
  type InvocationHandle
} from "@/server/operations/model-runtime";
import {
  ProviderError,
  type ResponsesInputItem,
  type ResponsesProvider,
  type ResponsesStreamEvent,
  type ResponsesStreamRequest,
  type ResponsesUsage
} from "@/server/providers";
import { QuotaExceededError } from "@/server/quota";
import type { DocumentParser, VisionProvider } from "@/server/providers";
import type {
  AgentStage,
  CalculationResult,
  Citation,
  RequestedAgentMode,
  ResolvedAgentMode,
  RiskLevel,
  WebMode
} from "@/types/chat";
import type {
  AnswerBlock,
  AnswerV3,
  ArtifactPart,
  VerifiedLinkPart
} from "@/types/chat-v3";

import {
  answerV3Blocks,
  answerV3JsonSchemaForRisk,
  buildDeterministicAttachmentScopeAnswerV3,
  buildDeterministicCalculationAnswerV3,
  buildDeterministicSafeAnswerV3,
  buildDeterministicWebUnavailableAnswerV3,
  collectAnswerV3References,
  requiresExpertAnswer,
  validateAnswerV3,
  type AnswerV3References
} from "./answer-v3";
import {
  AGENT_V3_INSTRUCTIONS,
  ContextBuilder,
  estimateTokens
} from "./context-builder";
import { EvidenceRegistry } from "./evidence-registry";
import { localizeCalculation } from "./calculation-localization";
import {
  agentRunBudgetProfile,
  effectiveAgentRunTimeoutMs,
  requiresFreshWebEvidence,
  shouldUseWeb
} from "./mode-policy";
import { RunStore, type CreatedRun } from "./run-store";
import type { ArtifactStorage } from "./artifact-tools";
import type { AttachmentStorage } from "./attachment-tools";
import { ToolRegistry, type ToolExecutionResult } from "./tool-registry";
import {
  WebEvidenceService,
  type WebDomainPolicy,
  type WebEvidenceResult
} from "./web-evidence";
import {
  webLinkBindingArgumentsDigest,
  webLinkBindingDigest
} from "./web-link-binding";

const MAX_TOOL_CALLS = 8;
const MAX_PARALLEL_TOOLS = 2;
const MAX_MODEL_REQUESTS = 6;

export type OrchestratorEvent =
  | { type: "stage"; stage: AgentStage; label: string }
  | {
      type: "tool";
      status: "started" | "completed" | "failed";
      label: string;
    }
  | {
      type: "block";
      block: AnswerBlock;
      index: number;
    }
  | { type: "citation"; citation: Citation };

export type OrchestratorResult = {
  status: "completed" | "incomplete";
  answer: AnswerV3;
  content: string;
  meta: Awaited<ReturnType<RunStore["complete"]>>["meta"];
};

export type AgentRunCounters = {
  toolRounds: number;
  toolCalls: number;
  modelRequests: number;
  retries: number;
  repairs: number;
};

export type AgentRunOrchestratorOptions = {
  attachmentStorage?: AttachmentStorage;
  artifactStorage?: ArtifactStorage;
  documentParser?: DocumentParser;
  visionProvider?: VisionProvider;
  webDomainPolicyLoader?: () => Promise<WebDomainPolicy[]>;
};

export async function persistAndPublishFinalAnswer<T>(input: {
  persist: () => Promise<T>;
  answer: AnswerV3;
  citations: Citation[];
  emit: (event: OrchestratorEvent) => void;
}): Promise<T> {
  const stored = await input.persist();
  for (const { block, index } of answerV3Blocks(input.answer)) {
    input.emit({ type: "block", block, index });
  }
  for (const citation of input.citations) {
    input.emit({ type: "citation", citation });
  }
  return stored;
}

export class AgentRunOrchestrator {
  private readonly contextBuilder = new ContextBuilder();
  private readonly evidence = new EvidenceRegistry();
  private tools!: ToolRegistry;
  private readonly calculations = new Map<
    string,
    ToolExecutionResult["calculations"][number]
  >();
  private readonly seenProviderCallIds = new Set<string>();
  private modelRequests = 0;
  private toolCalls = 0;
  private toolRounds = 0;
  private retries = 0;
  private repairs = 0;
  private toolSequence = 0;
  private webSearched = false;
  private webSearchFailure:
    "quota_exhausted" | "no_validated_evidence" | undefined;
  private readonly verifiedLinks = new Map<string, VerifiedLinkPart>();
  private readonly artifacts = new Map<string, ArtifactPart>();
  private readonly invocationByPhase = new Map<string, string>();

  constructor(
    private readonly provider: ResponsesProvider,
    private readonly store: RunStore,
    private readonly emit: (event: OrchestratorEvent) => void,
    private readonly adapters: AgentRunOrchestratorOptions = {}
  ) {}

  get counters(): AgentRunCounters {
    return {
      toolRounds: this.toolRounds,
      toolCalls: this.toolCalls,
      modelRequests: this.modelRequests,
      retries: this.retries,
      repairs: this.repairs
    };
  }

  async run(input: {
    userId: string;
    userPartition: string;
    clientRequestId: string;
    run: CreatedRun;
    requestedMode: RequestedAgentMode;
    resolvedMode: ResolvedAgentMode;
    webMode: WebMode;
    riskLevel: RiskLevel;
    signal: AbortSignal;
  }): Promise<OrchestratorResult> {
    const startedAt = Date.now();
    const budgetProfile = agentRunBudgetProfile(input.requestedMode);
    const modeTimeoutMs = effectiveAgentRunTimeoutMs(input.resolvedMode);
    const timeoutSignal = AbortSignal.timeout(modeTimeoutMs);
    const signal = AbortSignal.any([input.signal, timeoutSignal]);

    this.tools = new ToolRegistry(this.evidence, {
      userId: input.userId,
      conversationId: input.run.conversationId,
      userMessageId: input.run.userMessageId,
      assistantMessageId: input.run.assistantMessageId,
      runId: input.run.runId,
      turnId: input.run.turnId,
      question: input.run.question,
      inputParts: input.run.inputParts,
      signal,
      ...this.adapters
    });

    this.stage("analyzing", "正在分析问题风险与所需依据…");
    signal.throwIfAborted();
    await this.proactiveKnowledgeSearch(input.run, signal);
    signal.throwIfAborted();

    const shouldSearchWeb = shouldUseWeb({
      webMode: input.webMode,
      question: input.run.question,
      riskLevel: input.riskLevel,
      localEvidenceCount: this.evidence.list().length,
      resolvedMode: input.resolvedMode
    });
    if (shouldSearchWeb && this.toolCalls < MAX_TOOL_CALLS) {
      await this.proactiveWebSearch(input, signal);
    }
    signal.throwIfAborted();

    this.stage("reasoning", "正在结合对话、证据与可用工具…");
    const context = await this.contextBuilder.build({
      userId: input.userId,
      conversationId: input.run.conversationId,
      currentTurnId: input.run.turnId,
      currentUserMessageId: input.run.userMessageId,
      question: input.run.question,
      mode: input.resolvedMode,
      action: input.run.action,
      evidence: this.evidence,
      inputParts: input.run.inputParts
    });
    let currentInput = context.input;
    let outputText = "";
    let finalUsage: ResponsesUsage | undefined;
    let incomplete = false;

    while (true) {
      signal.throwIfAborted();
      this.stage("generating", "正在生成结构化回答…");
      const result = await this.requestWithOneRetry(
        input,
        currentInput,
        signal,
        `answer_${this.modelRequests + 1}`,
        this.toolRounds < budgetProfile.maxToolRounds
      );
      outputText = result.finish.outputText || result.outputText;
      finalUsage = result.finish.usage;
      if (result.finish.status === "failed") {
        throw new AgentRuntimeError(
          "PROVIDER_RESPONSE_FAILED",
          result.finish.error?.message ?? "回答模型返回失败。",
          true
        );
      }
      if (result.calls.length === 0) {
        incomplete = result.finish.status === "incomplete";
        break;
      }
      if (result.finish.status !== "completed") {
        incomplete = true;
        break;
      }
      if (this.toolRounds >= budgetProfile.maxToolRounds) {
        throw new AgentRuntimeError(
          "TOOL_ROUND_LIMIT",
          "本次工具轮次已达到安全上限。",
          false
        );
      }
      this.toolRounds += 1;
      const outputs = await this.executeToolCalls(
        input.run,
        result.calls,
        signal
      );
      currentInput = [
        ...currentInput,
        ...result.finish.continuationItems,
        ...outputs.map((output) => output.outputItem)
      ];
    }

    this.stage("validating_answer", "正在校验结构、引用与安全边界…");
    let answer = await this.validateOrRepair({
      ...input,
      currentInput,
      outputText,
      signal
    });
    if (incomplete && !answer) {
      answer = buildDeterministicSafeAnswerV3(
        input.riskLevel,
        "模型输出在完整 Answer V3 形成前中断，可使用“继续”恢复。"
      );
    }
    if (!answer) {
      throw new AgentRuntimeError(
        "ANSWER_VALIDATION_FAILED",
        "回答未通过结构、引用或安全校验。",
        false
      );
    }

    const references = collectAnswerV3References(answer);
    const usedEvidenceIds = references.evidenceIds;
    this.stage("saving", "正在保存回答与引用快照…");
    const stored = await persistAndPublishFinalAnswer({
      persist: () =>
        this.store.complete({
          userId: input.userId,
          run: input.run,
          answer,
          riskLevel: input.riskLevel,
          requestedMode: input.requestedMode,
          resolvedMode: input.resolvedMode,
          webMode: input.webMode,
          webSearched: this.webSearched,
          evidence: this.evidence,
          usedEvidenceIds,
          verifiedLinks: [...this.verifiedLinks.values()].filter((link) =>
            references.linkIds.includes(link.linkId)
          ),
          artifacts: [...this.artifacts.values()],
          context: context.disclosure,
          usage: finalUsage,
          latencyMs: Date.now() - startedAt,
          status: incomplete ? "incomplete" : "completed",
          counters: this.counters
        }),
      answer,
      citations: this.evidence.citations(usedEvidenceIds),
      emit: this.emit
    });
    return {
      status: incomplete ? "incomplete" : "completed",
      answer,
      content: stored.content,
      meta: stored.meta
    };
  }

  private async proactiveKnowledgeSearch(
    run: CreatedRun,
    signal: AbortSignal
  ): Promise<void> {
    this.stage("retrieving", "正在检索 OpenVac 知识库…");
    this.tool("started", "knowledge_search", "检索受治理的知识资料");
    const startedAt = Date.now();
    signal.throwIfAborted();
    const callId = `server_knowledge_${run.runId}`;
    const args = JSON.stringify({ query: run.question });
    const result = await this.tools.execute({
      callId,
      name: "search_knowledge",
      arguments: args
    });
    this.toolCalls += 1;
    await this.recordTool(
      run,
      1,
      callId,
      "search_knowledge",
      args,
      result,
      startedAt
    );
    this.tool(
      result.ok ? "completed" : "failed",
      "knowledge_search",
      result.ok
        ? `知识检索完成，获得 ${result.evidenceIds.length} 条可用依据`
        : "知识检索未完成，将按无本地证据策略继续"
    );
  }

  private async proactiveWebSearch(
    input: {
      userId: string;
      userPartition: string;
      clientRequestId: string;
      run: CreatedRun;
      requestedMode: RequestedAgentMode;
      resolvedMode: ResolvedAgentMode;
      webMode: WebMode;
      riskLevel: RiskLevel;
      signal: AbortSignal;
    },
    signal: AbortSignal
  ): Promise<void> {
    this.stage("searching", "正在联网发现候选来源…");
    this.tool("started", "web_search", "联网搜索候选来源");
    const startedAt = Date.now();
    const callId = `server_web_${input.run.runId}`;
    const web = new WebEvidenceService(
      this.provider,
      this.evidence,
      (request) => this.meteredStream(input, request, "web_discovery"),
      this.adapters.webDomainPolicyLoader
    );
    let result: WebEvidenceResult;
    try {
      result = await web.search({
        question: input.run.question,
        userId: input.userId,
        userPartition: input.userPartition,
        clientRequestId: input.clientRequestId,
        signal
      });
    } catch (error) {
      const quotaPolicy = webSearchQuotaPolicy(error, input.webMode);
      if (!quotaPolicy) throw error;
      this.toolCalls += 1;
      await this.store.recordToolCall({
        runId: input.run.runId,
        round: 1,
        sequence: ++this.toolSequence,
        callId,
        toolName: "web_search",
        argumentsDigest: digest(input.run.question),
        resultDigest: digest("WEB_SEARCH_QUOTA_EXCEEDED"),
        citationIds: [],
        status: "failed",
        latencyMs: Date.now() - startedAt,
        errorCode: "WEB_SEARCH_QUOTA_EXCEEDED"
      });
      this.stage("validating_sources", "正在执行来源分级与安全抓取…");
      this.tool("failed", "web_search", "联网搜索额度已用尽，未引入联网依据");
      if (quotaPolicy === "fail_required_web") {
        throw new AgentRuntimeError(
          "WEB_SEARCH_QUOTA_EXCEEDED",
          "用户明确要求联网搜索，但本次联网额度已用尽。",
          false
        );
      }
      this.webSearchFailure = "quota_exhausted";
      return;
    }
    this.toolCalls += 1;
    this.webSearched = result.searched;
    for (const link of result.verifiedLinks) {
      this.verifiedLinks.set(link.linkId, link);
    }
    if (result.evidenceIds.length === 0) {
      this.webSearchFailure ??= "no_validated_evidence";
    }
    const nativeSearchCompleted =
      result.searched && result.provider === "deepseek-native";
    await this.store.recordToolCall({
      runId: input.run.runId,
      round: 1,
      sequence: ++this.toolSequence,
      callId,
      toolName: "web_search",
      argumentsDigest: digest(input.run.question),
      resultDigest: digest(
        JSON.stringify({
          provider: result.provider,
          evidenceIds: result.evidenceIds,
          linkIds: result.verifiedLinks.map((link) => link.linkId)
        })
      ),
      citationIds: result.evidenceIds,
      status: nativeSearchCompleted ? "completed" : "failed",
      latencyMs: Date.now() - startedAt,
      errorCode: nativeSearchCompleted ? undefined : "NATIVE_WEB_SEARCH_FAILED"
    });
    for (const link of result.verifiedLinks) {
      for (const evidenceId of link.evidenceIds ?? []) {
        await this.store.recordToolCall({
          runId: input.run.runId,
          round: 1,
          sequence: ++this.toolSequence,
          callId: `server_web_link_${link.linkId}_${evidenceId}_${input.run.runId}`,
          toolName: "web_link_binding",
          argumentsDigest: webLinkBindingArgumentsDigest(),
          resultDigest: webLinkBindingDigest({ evidenceId, link }),
          citationIds: [evidenceId],
          status: "completed",
          latencyMs: 0
        });
      }
    }
    this.stage("validating_sources", "正在执行来源分级与安全抓取…");
    this.tool(
      nativeSearchCompleted ? "completed" : "failed",
      "web_search",
      result.evidenceIds.length > 0
        ? `联网与来源核验完成，保留 ${result.evidenceIds.length} 条依据`
        : nativeSearchCompleted
          ? "DeepSeek 联网已完成，但没有候选通过来源治理"
          : "DeepSeek 联网未完成，未引入联网依据"
    );
  }

  private async executeToolCalls(
    run: CreatedRun,
    calls: Array<{ callId: string; name: string; arguments: string }>,
    signal: AbortSignal
  ): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];
    for (let offset = 0; offset < calls.length; offset += MAX_PARALLEL_TOOLS) {
      const batch = calls.slice(offset, offset + MAX_PARALLEL_TOOLS);
      const resolved = await Promise.all(
        batch.map(async (call) => {
          signal.throwIfAborted();
          if (this.seenProviderCallIds.has(call.callId)) {
            return duplicateCallOutput(call.callId);
          }
          this.seenProviderCallIds.add(call.callId);
          if (this.toolCalls >= MAX_TOOL_CALLS) {
            return limitCallOutput(call.callId);
          }
          this.toolCalls += 1;
          const publicTool = publicToolKind(call.name);
          this.tool("started", publicTool, toolLabel(call.name, "started"));
          const startedAt = Date.now();
          const result = await this.tools.execute(call);
          for (const calculation of result.calculations) {
            this.calculations.set(calculation.id, calculation);
          }
          for (const link of result.verifiedLinks) {
            this.verifiedLinks.set(link.linkId, link);
          }
          for (const artifact of result.artifacts) {
            this.artifacts.set(artifact.artifactId, artifact);
          }
          await this.recordTool(
            run,
            this.toolRounds,
            call.callId,
            call.name,
            call.arguments,
            result,
            startedAt
          );
          this.tool(
            result.ok ? "completed" : "failed",
            publicTool,
            result.ok
              ? toolLabel(call.name, "completed")
              : toolLabel(call.name, "failed")
          );
          return result;
        })
      );
      results.push(...resolved);
    }
    return results;
  }

  private async recordTool(
    run: CreatedRun,
    round: number,
    callId: string,
    name: string,
    args: string,
    result: ToolExecutionResult,
    startedAt: number
  ): Promise<void> {
    await this.store.recordToolCall({
      runId: run.runId,
      round,
      sequence: ++this.toolSequence,
      callId,
      toolName: name,
      argumentsDigest: digest(args),
      resultDigest: digest(String(result.outputItem.output ?? "")),
      citationIds: result.evidenceIds,
      status: result.ok ? "completed" : "failed",
      latencyMs: Date.now() - startedAt
    });
  }

  private async validateOrRepair(input: {
    userId: string;
    userPartition: string;
    clientRequestId: string;
    run: CreatedRun;
    requestedMode: RequestedAgentMode;
    resolvedMode: ResolvedAgentMode;
    webMode: WebMode;
    riskLevel: RiskLevel;
    currentInput: ResponsesInputItem[];
    outputText: string;
    signal: AbortSignal;
  }): Promise<AnswerV3 | undefined> {
    const hasCurrentTurnAttachment = input.run.inputParts.some(
      (part) => part.type === "attachment"
    );
    const attachmentScopeAnswer = hasCurrentTurnAttachment
      ? undefined
      : buildDeterministicAttachmentScopeAnswerV3(
          input.run.question,
          input.riskLevel
        );
    if (attachmentScopeAnswer) return attachmentScopeAnswer;
    const preferCalculationAnswer =
      input.riskLevel !== "high" && this.calculations.size > 0;
    const calculationAnswer = () =>
      buildDeterministicCalculationAnswerV3(
        [...this.calculations.values()],
        input.riskLevel === "medium" ? "medium" : "low"
      );
    if (this.webSearchFailure && preferCalculationAnswer) {
      return calculationAnswer();
    }
    const requiresWebQuotaFallback = (references: AnswerV3References) =>
      Boolean(this.webSearchFailure) &&
      (input.webMode === "always" ||
        requiresFreshWebEvidence(input.run.question)) &&
      references.calculationIds.length === 0 &&
      !references.evidenceIds.some((id) => {
        const entry = this.evidence.get(id);
        return entry
          ? isCurrentTurnRuntimeEvidenceSource(entry.originalSourceId)
          : false;
      });
    const validate = (value: unknown) =>
      validateAnswerV3({
        value: localizeKnownCalculationBlocks(value, this.calculations),
        riskLevel: input.riskLevel,
        question: input.run.question,
        requiresExpert: requiresExpertAnswer(
          input.run.question,
          input.riskLevel
        ),
        knownEvidenceIds: this.evidence.list().map((entry) => entry.id),
        knownLinkIds: this.verifiedLinks.keys(),
        knownArtifactIds: this.artifacts.keys(),
        knownCalculationIds: this.calculations.keys(),
        forbiddenVisibleTerms: [...this.calculations.values()].flatMap(
          (calculation) => [
            calculation.tool,
            calculation.formulaId,
            calculation.formulaVersion,
            ...Object.keys(calculation.normalizedInputs),
            ...Object.keys(calculation.result)
          ]
        ),
        verifiedEvidenceIds: this.evidence
          .list()
          .filter(
            (entry) =>
              entry.trustTier === "tier_a" &&
              ["reviewed", "runtime_verified"].includes(entry.reviewStatus)
          )
          .map((entry) => entry.id)
      });
    let validated = validate(safeJson(input.outputText));
    if (!validated.valid) {
      // Local calculation results have already passed strict schema and
      // applicability validation. Prefer the server-owned representation over
      // spending the remaining automatic-run budget on repairing model JSON.
      if (preferCalculationAnswer) return calculationAnswer();
      if (input.riskLevel === "high") {
        return buildDeterministicSafeAnswerV3(
          input.riskLevel,
          "生成内容未通过高风险语义安全边界。"
        );
      }
      const candidateUsesGrounding = candidateUsesOnlyKnownGrounding(
        validated.references,
        this.evidence.list().map((entry) => entry.id),
        this.calculations.keys()
      );
      if (!candidateUsesGrounding) {
        return buildDeterministicSafeAnswerV3(
          input.riskLevel,
          "请补充设备型号、工况、单位和希望确认的具体问题。"
        );
      }
      const repaired = await this.repair(input, validated.errors);
      validated = validate(safeJson(repaired));
    }
    if (validated.valid) {
      return requiresWebQuotaFallback(validated.references)
        ? buildDeterministicWebUnavailableAnswerV3(
            input.riskLevel,
            this.webSearchFailure
          )
        : validated.answer;
    }
    if (preferCalculationAnswer) return calculationAnswer();
    if (
      this.webSearchFailure &&
      (input.webMode === "always" ||
        requiresFreshWebEvidence(input.run.question))
    ) {
      return buildDeterministicWebUnavailableAnswerV3(
        input.riskLevel,
        this.webSearchFailure
      );
    }
    return buildDeterministicSafeAnswerV3(
      input.riskLevel,
      "请补充设备型号、工况、单位和希望确认的具体问题。"
    );
  }

  private async repair(
    input: {
      userId: string;
      userPartition: string;
      clientRequestId: string;
      run: CreatedRun;
      requestedMode: RequestedAgentMode;
      resolvedMode: ResolvedAgentMode;
      webMode: WebMode;
      riskLevel: RiskLevel;
      outputText: string;
      signal: AbortSignal;
    },
    errors: string[]
  ): Promise<string> {
    if (this.repairs >= 1) return "";
    this.repairs += 1;
    const hasGrounding =
      this.evidence.list().length > 0 || this.calculations.size > 0;
    const expertRequired = requiresExpertAnswer(
      input.run.question,
      input.riskLevel
    );
    const hasVerifiedEvidence = this.evidence
      .list()
      .some(
        (entry) =>
          entry.trustTier === "tier_a" &&
          ["reviewed", "runtime_verified"].includes(entry.reviewStatus)
      );
    const allowedAnswerKinds =
      input.riskLevel === "high"
        ? [
            "clarification",
            "safe_refusal",
            ...(hasVerifiedEvidence ? ["expert"] : [])
          ]
        : input.riskLevel === "medium"
          ? [
              "clarification",
              "safe_refusal",
              ...(hasGrounding ? ["expert"] : [])
            ]
          : [
              ...(!expertRequired ? ["direct"] : []),
              "clarification",
              "safe_refusal",
              ...(hasGrounding ? ["expert"] : [])
            ];
    const repairInput: ResponsesInputItem[] = [
      {
        type: "message",
        role: "user",
        content: JSON.stringify({
          task: "Repair the candidate into valid openvac.answer.v3 JSON. Do not add new facts, citations, links, artifacts, or calculations.",
          requiredRiskLevel: input.riskLevel,
          allowedAnswerKinds,
          repairRules: [
            "The answer riskLevel must equal requiredRiskLevel exactly.",
            "When no allowed evidence or calculation exists, do not use answerKind expert; use clarification or safe_refusal.",
            "Do not turn a permission denial into a claim that an attachment was accessed."
          ],
          validationErrors: errors.slice(0, 20),
          allowedEvidenceIds: this.evidence.list().map((entry) => entry.id),
          allowedCalculationIds: [...this.calculations.keys()],
          allowedLinkIds: [...this.verifiedLinks.keys()],
          allowedArtifactIds: [...this.artifacts.keys()],
          candidate: input.outputText.slice(0, 32_000)
        })
      }
    ];
    const result = await this.requestWithOneRetry(
      input,
      repairInput,
      input.signal,
      "answer_repair",
      false
    );
    if (result.finish.status !== "completed") return "";
    return result.finish.outputText || result.outputText;
  }

  private async requestWithOneRetry(
    input: {
      userId: string;
      userPartition: string;
      clientRequestId: string;
      run: CreatedRun;
      requestedMode: RequestedAgentMode;
      resolvedMode: ResolvedAgentMode;
      riskLevel: RiskLevel;
    },
    modelInput: ResponsesInputItem[],
    signal: AbortSignal,
    phase: string,
    allowTools: boolean
  ): Promise<CollectedModelResponse> {
    try {
      return await this.collectModelResponse(
        input,
        modelInput,
        signal,
        phase,
        allowTools
      );
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable) throw error;
      this.retries += 1;
      return this.collectModelResponse(
        input,
        modelInput,
        signal,
        `${phase}_retry`,
        allowTools
      );
    }
  }

  private async collectModelResponse(
    input: {
      userId: string;
      userPartition: string;
      clientRequestId: string;
      run: CreatedRun;
      requestedMode: RequestedAgentMode;
      resolvedMode: ResolvedAgentMode;
      riskLevel: RiskLevel;
    },
    modelInput: ResponsesInputItem[],
    signal: AbortSignal,
    phase: string,
    allowTools: boolean
  ): Promise<CollectedModelResponse> {
    let outputText = "";
    const calls: CollectedModelResponse["calls"] = [];
    let finish: Extract<ResponsesStreamEvent, { type: "finish" }> | undefined;
    const budgetProfile = agentRunBudgetProfile(input.requestedMode);
    const request: ResponsesStreamRequest = {
      instructions: undefined,
      input: modelInput,
      tools: allowTools ? this.tools.definitions : undefined,
      toolChoice: allowTools ? "auto" : "none",
      reasoningEffort:
        input.resolvedMode === "deep"
          ? input.riskLevel === "high"
            ? "xhigh"
            : "high"
          : "low",
      textFormat: {
        type: "json_schema",
        name: "openvac_answer_v3",
        schema: answerV3JsonSchemaForRisk(input.riskLevel),
        strict: true
      },
      maxOutputTokens: readPositiveInteger(
        budgetProfile.outputTokenEnvironmentName,
        budgetProfile.outputTokenFallback
      ),
      user: input.userPartition,
      signal
    };
    // Instructions are kept out of untrusted input and applied on every call.
    request.instructions = buildAgentV3InstructionsForRisk(input.riskLevel);
    const inputBudget = budgetProfile.inputTokenBudget;
    const estimatedInputTokens = estimateTokens(
      `${request.instructions}\n${JSON.stringify(request.input)}`
    );
    if (estimatedInputTokens > inputBudget) {
      throw new AgentRuntimeError(
        "INPUT_BUDGET_EXCEEDED",
        `结构化上下文超过 ${inputBudget} token 输入上限。`,
        false
      );
    }
    for await (const event of this.meteredStream(input, request, phase)) {
      if (event.type === "text-delta") outputText += event.text;
      if (event.type === "function-call") calls.push(event);
      if (event.type === "finish") finish = event;
    }
    if (!finish) {
      throw new AgentRuntimeError(
        "MISSING_PROVIDER_TERMINAL",
        "模型流没有终态事件。",
        true
      );
    }
    return { outputText, calls, finish };
  }

  private async *meteredStream(
    input: {
      userId: string;
      clientRequestId: string;
      run: CreatedRun;
    },
    request: ResponsesStreamRequest,
    phase: string
  ): AsyncGenerator<ResponsesStreamEvent> {
    if (this.modelRequests >= MAX_MODEL_REQUESTS) {
      throw new AgentRuntimeError(
        "MODEL_REQUEST_LIMIT",
        "本次模型请求已达到安全上限。",
        false
      );
    }
    this.modelRequests += 1;
    let handle: InvocationHandle | undefined;
    let settled = false;
    const rootPhase = phase.replace(/_retry$/u, "");
    try {
      handle = await startModelInvocation({
        userId: input.userId,
        conversationId: input.run.conversationId,
        messageId: input.run.assistantMessageId,
        clientRequestId: `${input.clientRequestId}:${phase}:${this.modelRequests}`,
        provider: this.provider.id,
        model: this.provider.model,
        messages: [
          { role: "system", content: request.instructions ?? "" },
          { role: "user", content: JSON.stringify(request.input) }
        ],
        maximumOutputTokens: request.maxOutputTokens ?? 4_096,
        evidenceSourceIds: this.evidence.list().map((entry) => entry.id),
        webSearched: phase === "web_discovery",
        agentRunId: input.run.runId,
        protocol: "responses",
        phase,
        attempt: this.modelRequests,
        retryOfId: phase.endsWith("_retry")
          ? this.invocationByPhase.get(rootPhase)
          : undefined,
        purpose: phase === "web_discovery" ? "web_search" : "answer",
        priceVersion: process.env.MODEL_PRICE_VERSION
      });
      this.invocationByPhase.set(rootPhase, handle.id);
      for await (const event of this.provider.stream(request)) {
        if (event.type === "finish") {
          if (event.status === "failed") {
            await failModelInvocation({
              handle,
              errorCode: event.error?.code ?? "PROVIDER_RESPONSE_FAILED",
              errorMessage: event.error?.message ?? "Provider response failed.",
              providerHttpStatus: 200,
              providerErrorCode: event.error?.code,
              retainReservedEstimate: true
            });
          } else {
            await completeModelInvocation({
              handle,
              usage: event.usage,
              providerRequestId: event.providerRequestId,
              finishReason: event.status,
              firstEventLatencyMs: event.firstEventLatencyMs,
              providerHttpStatus: 200
            });
          }
          settled = true;
        }
        yield event;
      }
    } catch (error) {
      if (handle && !settled) {
        await failModelInvocation({
          handle,
          status: request.signal?.aborted ? "cancelled" : "failed",
          errorCode: errorCode(error),
          errorMessage: safeInternalError(error),
          providerHttpStatus:
            error instanceof ProviderError ? error.status : undefined,
          providerErrorCode:
            error instanceof ProviderError ? errorCode(error) : undefined,
          retainReservedEstimate: true
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  private stage(stage: AgentStage, label: string): void {
    this.emit({ type: "stage", stage, label });
  }

  private tool(
    status: "started" | "completed" | "failed",
    _category: string,
    label: string
  ): void {
    this.emit({ type: "tool", status, label });
  }
}

export function buildAgentV3InstructionsForRisk(riskLevel: RiskLevel): string {
  return [
    AGENT_V3_INSTRUCTIONS,
    `本轮服务端风险等级已固定为 ${riskLevel}；最终答案的 riskLevel 必须原样使用该值，不得由模型重新分类。`,
    "如果复杂或中高风险回答没有可用证据或服务端确定性计算，不得生成无依据的 expert；应使用 clarification 或 safe_refusal。"
  ].join("\n");
}

export function candidateUsesOnlyKnownGrounding(
  references: Pick<AnswerV3References, "evidenceIds" | "calculationIds">,
  knownEvidenceIds: Iterable<string>,
  knownCalculationIds: Iterable<string>
): boolean {
  const knownEvidence = new Set(knownEvidenceIds);
  const knownCalculations = new Set(knownCalculationIds);
  const evidenceIds = [...references.evidenceIds];
  const calculationIds = [...references.calculationIds];
  return (
    evidenceIds.length + calculationIds.length > 0 &&
    evidenceIds.every((id) => knownEvidence.has(id)) &&
    calculationIds.every((id) => knownCalculations.has(id))
  );
}

type CollectedModelResponse = {
  outputText: string;
  calls: Array<{ callId: string; name: string; arguments: string }>;
  finish: Extract<ResponsesStreamEvent, { type: "finish" }>;
};

export function localizeKnownCalculationBlocks(
  value: unknown,
  calculations: ReadonlyMap<string, CalculationResult>
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.blocks)) return value;
  return {
    ...record,
    blocks: record.blocks.map((block) => {
      if (typeof block !== "object" || block === null || Array.isArray(block)) {
        return block;
      }
      const blockRecord = block as Record<string, unknown>;
      if (
        blockRecord.type !== "calculation" ||
        typeof blockRecord.calculationId !== "string"
      ) {
        return block;
      }
      const calculation = calculations.get(blockRecord.calculationId);
      return calculation
        ? { type: "calculation" as const, ...localizeCalculation(calculation) }
        : block;
    })
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(
      value
        .trim()
        .replace(/^```(?:json)?\s*/iu, "")
        .replace(/\s*```$/u, "")
    );
  } catch {
    return undefined;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function duplicateCallOutput(callId: string): ToolExecutionResult {
  return deterministicToolError(callId, "DUPLICATE_CALL_ID");
}

function limitCallOutput(callId: string): ToolExecutionResult {
  return deterministicToolError(callId, "TOOL_CALL_LIMIT");
}

function deterministicToolError(
  callId: string,
  code: string
): ToolExecutionResult {
  return {
    ok: false,
    outputItem: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify({ ok: false, error: code })
    },
    evidenceIds: [],
    calculations: [],
    verifiedLinks: [],
    artifacts: [],
    missingInputs: []
  };
}

function publicToolKind(name: string): string {
  if (name === "search_knowledge" || name === "open_evidence_excerpt") {
    return "knowledge_search";
  }
  return "calculation";
}

function toolLabel(
  name: string,
  status: "started" | "completed" | "failed"
): string {
  const labels: Record<
    string,
    { started: string; completed: string; failed: string }
  > = {
    search_knowledge: {
      started: "正在补充检索知识",
      completed: "知识检索完成",
      failed: "知识检索未返回可用结果"
    },
    open_evidence_excerpt: {
      started: "正在核对证据摘录",
      completed: "证据摘录已核对",
      failed: "证据摘录暂不可用"
    },
    read_verified_url: {
      started: "正在安全核验链接内容",
      completed: "链接内容已核验",
      failed: "链接未通过安全核验"
    },
    search_attachment: {
      started: "正在检索附件内容",
      completed: "附件检索完成",
      failed: "附件检索未返回可用内容"
    },
    open_attachment_excerpt: {
      started: "正在核对附件摘录",
      completed: "附件摘录已核对",
      failed: "附件摘录暂不可用"
    },
    analyze_image: {
      started: "正在分析图片",
      completed: "图片分析完成",
      failed: "图片暂时无法分析"
    },
    create_artifact: {
      started: "正在准备所需产物",
      completed: "产物已创建",
      failed: "产物暂时无法创建"
    }
  };
  const label = labels[name];
  if (label) return label[status];
  return status === "started"
    ? "正在执行确定性工程计算"
    : status === "completed"
      ? "工程计算完成"
      : "工程计算缺少参数或超出已验证范围";
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

function safeInternalError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_000)
    : "Unknown provider error.";
}

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

export function webSearchQuotaPolicy(
  error: unknown,
  webMode: WebMode
): "continue_without_web" | "fail_required_web" | undefined {
  if (
    !(error instanceof QuotaExceededError) ||
    error.resource !== "web_search"
  ) {
    return undefined;
  }
  return webMode === "always" ? "fail_required_web" : "continue_without_web";
}

export function isCurrentTurnRuntimeEvidenceSource(sourceId: string): boolean {
  return /^(?:attachment:|image-analysis:|turn-link:)/u.test(sourceId);
}

export function isAgentRunTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}
