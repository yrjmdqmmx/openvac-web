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
  type ResponsesTool,
  type ResponsesToolChoice,
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
  ArtifactSpec,
  InputMessagePart,
  VerifiedLinkPart
} from "@/types/chat-v3";

import {
  answerV3Blocks,
  answerV3JsonSchemaForRisk,
  buildDeterministicArtifactAnswerV3,
  buildDeterministicAttachmentScopeAnswerV3,
  buildDeterministicCalculationAnswerV3,
  buildDeterministicSafeAnswerV3,
  buildDeterministicWebUnavailableAnswerV3,
  collectAnswerV3References,
  requestsVerifiedLinkSelection,
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
import {
  hasExplicitArtifactIntent,
  type ArtifactStorage
} from "./artifact-tools";
import { parameterTableIncludesUnitsAndAssumptions } from "./artifact-semantics";
import type { AttachmentStorage } from "./attachment-tools";
import {
  ARTIFACT_PROVIDER_INSTRUCTION,
  MAX_ARTIFACT_ARGUMENT_BYTES,
  ToolRegistry,
  type ToolExecutionResult
} from "./tool-registry";
import {
  answerUsesOnlyProjectedCalculations,
  boundCalculationIdFromToolResult,
  buildTrustedCalculationFinalInput,
  calculationsForProjection,
  trustedPumpdownEligibilityFailure,
  trustedPumpdownProjectionFromToolTurn
} from "./trusted-calculation-projection";
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
const EXPLICIT_ARTIFACT_RUN_TIMEOUT_FLOOR_MS = 300_000;
const NON_REPEATABLE_TOOL_NAMES = new Set(["create_artifact"]);
export const MAX_ARTIFACT_PROVIDER_OUTPUT_TOKENS = 8_192;
const FRESH_ARTIFACT_ARGUMENT_REPAIR_INSTRUCTION =
  "上一次 create_artifact 参数不是合法 JSON。重新生成一个简洁、完整、符合 provider envelope 的单一 create_artifact 调用；不得复述、猜测或引用上一次调用的参数。";
const CONTINUATION_ARTIFACT_ARGUMENT_REPAIR_INSTRUCTION =
  "上一次 create_artifact 参数未通过本地安全校验。根据已配对的工具结果中列出的缺失路径重新生成一个简洁、完整、符合 provider envelope 的单一 create_artifact 调用；不得忽略单位、假设或适用工况要求。";

export type ArtifactArgumentRecoveryMode =
  "fresh_json_invalid" | "continuation_invalid_arguments";

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
  private readonly attemptedNonRepeatableToolNames = new Set<string>();
  private readonly serverBlockedCallableToolNames = new Set<string>();
  private modelRequests = 0;
  private toolCalls = 0;
  private toolRounds = 0;
  private retries = 0;
  private repairs = 0;
  private artifactArgumentRepairs = 0;
  private pendingArtifactArgumentRecovery?: ArtifactArgumentRecoveryMode;
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
      repairs: this.repairs + this.artifactArgumentRepairs
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
    const modeTimeoutMs = selectAgentRunTimeoutMs(
      input.resolvedMode,
      input.run.question
    );
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
    if (
      shouldBlockArtifactCreation(
        input.run.question,
        input.riskLevel,
        input.run.inputParts
      )
    ) {
      this.serverBlockedCallableToolNames.add("create_artifact");
    }

    this.stage("analyzing", "正在分析问题风险与所需依据…");
    signal.throwIfAborted();
    await this.proactiveKnowledgeSearch(input.run, signal);
    signal.throwIfAborted();
    await this.proactiveAttachmentEvidence(input.run, signal);
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
    const originalContextInput = [...context.input];
    let currentInput = originalContextInput;
    let outputText = "";
    let finalUsage: ResponsesUsage | undefined;
    let incomplete = false;
    let forceToolFreeAnswer = false;
    let projectedCalculationIds: Set<string> | undefined;

    while (true) {
      signal.throwIfAborted();
      this.stage("generating", "正在生成结构化回答…");
      const toolRoundLimit = selectAnswerToolRoundLimit(
        budgetProfile.maxToolRounds,
        this.tools.definitions,
        this.calculations.values(),
        input.run.inputParts
      );
      const requestInput = [...currentInput];
      const artifactRecoveryMode = this.pendingArtifactArgumentRecovery;
      this.pendingArtifactArgumentRecovery = undefined;
      let result: CollectedModelResponse;
      try {
        result = await this.requestWithOneRetry(
          input,
          requestInput,
          signal,
          artifactRecoveryMode
            ? `answer_artifact_${artifactRecoveryMode}`
            : `answer_${this.modelRequests + 1}`,
          !forceToolFreeAnswer && this.toolRounds < toolRoundLimit,
          artifactRecoveryMode
        );
      } catch (error) {
        if (
          forceToolFreeAnswer &&
          projectedCalculationIds &&
          error instanceof ProviderError &&
          (error.status === 400 || error.status === 422)
        ) {
          const calculations = calculationsForProjection(
            projectedCalculationIds,
            this.calculations
          );
          if (!calculations) throw error;
          outputText = JSON.stringify(
            buildDeterministicCalculationAnswerV3(
              calculations,
              input.riskLevel === "medium" ? "medium" : "low"
            )
          );
          incomplete = false;
          break;
        }
        throw error;
      }
      outputText = result.finish.outputText || result.outputText;
      finalUsage = result.finish.usage;
      if (result.finish.status === "failed") {
        if (
          forceToolFreeAnswer &&
          projectedCalculationIds &&
          safeProviderTerminalErrorCode(result.finish.error?.code) ===
            "PROVIDER_REQUEST_INVALID"
        ) {
          const calculations = calculationsForProjection(
            projectedCalculationIds,
            this.calculations
          );
          if (calculations) {
            outputText = JSON.stringify(
              buildDeterministicCalculationAnswerV3(
                calculations,
                input.riskLevel === "medium" ? "medium" : "low"
              )
            );
            incomplete = false;
            break;
          }
        }
        throw new AgentRuntimeError(
          "PROVIDER_RESPONSE_FAILED",
          "回答模型返回失败。",
          true
        );
      }
      const requiresTrustedProjection =
        this.provider.capabilities.forcedFunctionResultTransport ===
          "fresh_trusted_projection" &&
        result.forcedFunctionName === "estimate_pumpdown_time";
      assertAuthorizedFunctionCalls(result.calls, result.callableFunctionNames);
      if (result.calls.length === 0 && result.forcedFunctionName) {
        throw new AgentRuntimeError(
          "REQUIRED_TOOL_NOT_COMPLETED",
          "模型未返回已强制要求的工具调用。",
          false
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
      let executionCalls = result.calls;
      if (requiresTrustedProjection) {
        if (result.calls.length !== 1) {
          throw new AgentRuntimeError(
            "TRUSTED_CALCULATION_PROJECTION_CALL_COUNT_MISMATCH",
            "可信计算投影要求恰好一个已授权计算调用。",
            false
          );
        }
        const trustedArguments = extractTrustedPumpdownArguments(
          input.run.question,
          currentInput
        );
        if (!trustedArguments) {
          throw new AgentRuntimeError(
            "TRUSTED_CALCULATION_PROJECTION_INPUT_EXTRACTION_FAILED",
            "无法从明确的当前和承接参数中构建可信计算输入。",
            false
          );
        }
        executionCalls = [
          {
            ...result.calls[0]!,
            arguments: JSON.stringify(trustedArguments)
          }
        ];
      }
      if (this.toolRounds >= toolRoundLimit) {
        throw new AgentRuntimeError(
          "TOOL_ROUND_LIMIT",
          "本次工具轮次已达到安全上限。",
          false
        );
      }
      const artifactCallIndex = executionCalls.findIndex(
        (call) => call.name === "create_artifact"
      );
      assertSingleArtifactCall(executionCalls);
      let validatedArtifactSpec: ArtifactSpec | undefined;
      if (artifactCallIndex >= 0) {
        const artifactCall = executionCalls[artifactCallIndex]!;
        const preflight = this.tools.preflight(artifactCall);
        if (!preflight.ok) {
          const recoveryMode = selectArtifactArgumentRecoveryMode(
            preflight.result.errorCode,
            this.artifactArgumentRepairs,
            Buffer.byteLength(artifactCall.arguments, "utf8")
          );
          if (recoveryMode) {
            this.artifactArgumentRepairs += 1;
            this.pendingArtifactArgumentRecovery = recoveryMode;
            currentInput = buildArtifactRecoveryInput({
              mode: recoveryMode,
              requestInput,
              continuationItems: result.finish.continuationItems,
              safeOutputItem: preflight.result.outputItem
            });
            continue;
          }
          throw new AgentRuntimeError(
            safeArtifactFailureCode(preflight.result.errorCode),
            "产物参数未通过安全校验。",
            false
          );
        }
        validatedArtifactSpec = preflight.artifactSpec;
      }
      this.toolRounds += 1;
      const outputs = await this.executeToolCalls(
        input.run,
        executionCalls,
        signal
      );
      if (artifactCallIndex >= 0) {
        const artifactOutput = outputs[artifactCallIndex];
        const artifact = artifactOutput?.artifacts[0];
        if (
          !artifactOutput?.ok ||
          artifactOutput.artifacts.length !== 1 ||
          !artifact ||
          artifact.status !== "ready"
        ) {
          throw new AgentRuntimeError(
            safeArtifactFailureCode(artifactOutput?.errorCode),
            "产物未能完成并进入可下载状态。",
            false
          );
        }
        outputText = JSON.stringify(
          buildDeterministicArtifactAnswerV3(
            artifact,
            input.riskLevel === "low" ? "low" : "medium",
            this.evidence
              .list()
              .filter((entry) => entry.citationVisible)
              .map((entry) => entry.id),
            validatedArtifactSpec
              ? parameterTableIncludesUnitsAndAssumptions(validatedArtifactSpec)
              : false
          )
        );
        incomplete = false;
        break;
      }
      const projectionEligibilityFailure = requiresTrustedProjection
        ? trustedPumpdownEligibilityFailure({
            riskLevel: input.riskLevel,
            webRequired:
              input.webMode === "always" ||
              requiresFreshWebEvidence(input.run.question),
            question: input.run.question,
            inputPartTypes: input.run.inputParts.map((part) => part.type),
            hasArtifactIntent: false,
            toolRounds: this.toolRounds,
            calculationCount: this.calculations.size,
            calls: executionCalls
          })
        : undefined;
      const canUseTrustedProjection =
        requiresTrustedProjection && projectionEligibilityFailure === undefined;
      if (requiresTrustedProjection && projectionEligibilityFailure) {
        throw new AgentRuntimeError(
          projectionEligibilityFailure,
          "该请求不能安全切换到可信计算投影。",
          false
        );
      }
      if (canUseTrustedProjection) {
        const projection = trustedPumpdownProjectionFromToolTurn({
          calls: result.calls,
          executedCalls: executionCalls,
          continuationItems: result.finish.continuationItems,
          outputs
        });
        if (!projection) {
          throw new AgentRuntimeError(
            "TRUSTED_CALCULATION_PROJECTION_INVALID",
            "确定性计算结果未通过可信投影边界。",
            false
          );
        }
        if (
          this.calculations.size !== 1 ||
          !this.calculations.has(projection.calculationId)
        ) {
          throw new AgentRuntimeError(
            "TRUSTED_CALCULATION_PROJECTION_INVALID",
            "可信计算投影与本次运行的计算记录不一致。",
            false
          );
        }
        currentInput = buildTrustedCalculationFinalInput(
          originalContextInput,
          projection
        );
        projectedCalculationIds = new Set([projection.calculationId]);
        forceToolFreeAnswer = true;
        continue;
      }
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
      const calculations = projectedCalculationIds
        ? calculationsForProjection(projectedCalculationIds, this.calculations)
        : undefined;
      answer = calculations
        ? buildDeterministicCalculationAnswerV3(
            calculations,
            input.riskLevel === "medium" ? "medium" : "low"
          )
        : buildDeterministicSafeAnswerV3(
            input.riskLevel,
            "模型输出在完整 Answer V3 形成前中断，可使用“继续”恢复。"
          );
    }
    if (!answer && projectedCalculationIds) {
      const calculations = calculationsForProjection(
        projectedCalculationIds,
        this.calculations
      );
      if (calculations) {
        answer = buildDeterministicCalculationAnswerV3(
          calculations,
          input.riskLevel === "medium" ? "medium" : "low"
        );
      }
    }
    if (!answer) {
      throw new AgentRuntimeError(
        "ANSWER_VALIDATION_FAILED",
        "回答未通过结构、引用或安全校验。",
        false
      );
    }
    if (
      projectedCalculationIds &&
      !answerUsesOnlyProjectedCalculations(
        answer,
        projectedCalculationIds,
        input.riskLevel
      )
    ) {
      const calculations = calculationsForProjection(
        projectedCalculationIds,
        this.calculations
      );
      if (!calculations) {
        throw new AgentRuntimeError(
          "TRUSTED_CALCULATION_PROJECTION_INVALID",
          "可信计算投影无法绑定到已验证的计算记录。",
          false
        );
      }
      answer = buildDeterministicCalculationAnswerV3(
        calculations,
        input.riskLevel === "medium" ? "medium" : "low"
      );
    }

    const finalValidation = this.validateAnswerCandidate(
      input,
      answer,
      this.minimumRequiredLinkCount(input.run.question)
    );
    if (!finalValidation.valid) {
      throw new AgentRuntimeError(
        "ANSWER_VALIDATION_FAILED",
        "最终回答未通过结构、引用或安全校验。",
        false
      );
    }
    answer = finalValidation.answer;

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

  private async proactiveAttachmentEvidence(
    run: CreatedRun,
    signal: AbortSignal
  ): Promise<void> {
    const attachmentIds = run.inputParts.flatMap((part) =>
      part.type === "attachment" ? [part.attachmentId] : []
    );
    if (
      attachmentIds.length === 0 ||
      !requiresDocumentAttachmentEvidence(run.question)
    ) {
      return;
    }

    this.stage("retrieving", "正在检索当前消息授权的私有文档…");
    for (const name of [
      "search_attachment",
      "open_attachment_excerpt",
      "analyze_image"
    ]) {
      this.serverBlockedCallableToolNames.add(name);
    }
    for (let index = 0; index < attachmentIds.length; index += 1) {
      if (this.toolCalls >= MAX_TOOL_CALLS) return;
      const attachmentId = attachmentIds[index]!;
      const search = await this.executeServerAttachmentTool(
        run,
        {
          callId: `server_attachment_search_${run.runId}_${index + 1}`,
          name: "search_attachment",
          arguments: JSON.stringify({
            attachmentId,
            query: run.question
          })
        },
        signal
      );
      if (!search.ok) continue;

      const match = search.attachmentMatches?.[0];
      if (!match) continue;
      if (this.toolCalls >= MAX_TOOL_CALLS) return;
      await this.executeServerAttachmentTool(
        run,
        {
          callId: `server_attachment_open_${run.runId}_${index + 1}`,
          name: "open_attachment_excerpt",
          arguments: JSON.stringify({
            attachmentId: match.attachmentId,
            chunkId: match.chunkId
          })
        },
        signal
      );
      return;
    }
  }

  private async executeServerAttachmentTool(
    run: CreatedRun,
    call: { callId: string; name: string; arguments: string },
    signal: AbortSignal
  ): Promise<ToolExecutionResult> {
    signal.throwIfAborted();
    const publicTool = publicToolKind(call.name);
    this.tool("started", publicTool, toolLabel(call.name, "started"));
    const startedAt = Date.now();
    const result = await this.tools.execute(call);
    this.toolCalls += 1;
    await this.recordTool(
      run,
      1,
      call.callId,
      call.name,
      call.arguments,
      result,
      startedAt
    );
    this.tool(
      result.ok ? "completed" : "failed",
      publicTool,
      toolLabel(call.name, result.ok ? "completed" : "failed")
    );
    return result;
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
      errorCode: nativeSearchCompleted
        ? undefined
        : (result.failureCode ?? "NATIVE_WEB_DISCOVERY_FAILED")
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
    reserveNonRepeatableToolCalls(calls, this.attemptedNonRepeatableToolNames);
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
      calculationId: boundCalculationIdFromToolResult(result, {
        callId,
        toolName: name
      }),
      citationIds: result.evidenceIds,
      status: result.ok ? "completed" : "failed",
      errorCode: result.errorCode,
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
    const minimumLinkCount = this.minimumRequiredLinkCount(input.run.question);
    const validate = (value: unknown) =>
      this.validateAnswerCandidate(input, value, minimumLinkCount);
    let validated = validate(safeJson(input.outputText));
    if (!validated.valid) {
      const repairSourceAnswer = validated.answer;
      const linklessValidation =
        minimumLinkCount > 0 && repairSourceAnswer
          ? this.validateAnswerCandidate(
              input,
              withoutVerifiedLinkSelection(repairSourceAnswer),
              0
            )
          : undefined;
      const deterministicLinkRepair =
        linklessValidation?.valid && repairSourceAnswer
          ? buildDeterministicVerifiedLinkSelection(
              repairSourceAnswer,
              this.verifiedLinks
            )
          : undefined;
      const deterministicValidation = deterministicLinkRepair
        ? validate(deterministicLinkRepair)
        : undefined;
      if (
        deterministicValidation?.valid &&
        repairSourceAnswer &&
        linkRepairPreservesCandidate(
          repairSourceAnswer,
          deterministicValidation.answer,
          this.verifiedLinks
        )
      ) {
        validated = deterministicValidation;
      }
    }
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
        if (minimumLinkCount > 0) {
          throw new AgentRuntimeError(
            "ANSWER_VALIDATION_FAILED",
            "回答未能选择请求的已验证链接。",
            false
          );
        }
        return buildDeterministicSafeAnswerV3(
          input.riskLevel,
          "请补充设备型号、工况、单位和希望确认的具体问题。"
        );
      }
      const repairSourceAnswer = validated.answer;
      const repaired = await this.repair(input, validated.errors);
      validated = validate(safeJson(repaired));
      if (
        minimumLinkCount > 0 &&
        repairSourceAnswer &&
        validated.valid &&
        !linkRepairPreservesCandidate(
          repairSourceAnswer,
          validated.answer,
          this.verifiedLinks
        )
      ) {
        throw new AgentRuntimeError(
          "ANSWER_VALIDATION_FAILED",
          "链接修复改变了候选回答的事实或引用。",
          false
        );
      }
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
    if (minimumLinkCount > 0) {
      throw new AgentRuntimeError(
        "ANSWER_VALIDATION_FAILED",
        "回答修复后仍未能选择请求的已验证链接。",
        false
      );
    }
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
    const minimumLinkCount = this.minimumRequiredLinkCount(input.run.question);
    const repairInput: ResponsesInputItem[] = [
      {
        type: "message",
        role: "user",
        content: JSON.stringify({
          task: "Repair the candidate into valid openvac.answer.v3 JSON. Do not add new facts, citations, artifacts, calculations, or any link outside allowedLinkIds.",
          requiredRiskLevel: input.riskLevel,
          minimumLinkCount,
          allowedAnswerKinds,
          repairRules: [
            "The answer riskLevel must equal requiredRiskLevel exactly.",
            "When no allowed evidence or calculation exists, do not use answerKind expert; use clarification or safe_refusal.",
            "Do not turn a permission denial into a claim that an attachment was accessed.",
            "Each link_reference must use the exact linkId and label from allowedLinkBindings and cite at least one evidence ID from that binding in a paragraph, list, table, or callout block; usedEvidenceIds and usedLinkIds must exactly match block references.",
            "Use each allowed link ID at most once across link_reference blocks and usedLinkIds.",
            "When minimumLinkCount is 1, select at least one existing allowedLinkId; never invent a link or evidence ID."
          ],
          validationErrors: errors.slice(0, 20),
          allowedEvidenceIds: this.evidence.list().map((entry) => entry.id),
          allowedCalculationIds: [...this.calculations.keys()],
          allowedLinkIds: [...this.verifiedLinks.keys()],
          allowedLinkBindings: [...this.verifiedLinks.values()].map((link) => ({
            linkId: link.linkId,
            label: link.label,
            evidenceIds: link.evidenceIds ?? []
          })),
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

  private minimumRequiredLinkCount(question: string): 0 | 1 {
    return this.verifiedLinks.size > 0 &&
      requestsVerifiedLinkSelection(question)
      ? 1
      : 0;
  }

  private validateAnswerCandidate(
    input: { run: CreatedRun; riskLevel: RiskLevel },
    value: unknown,
    minimumLinkCount: 0 | 1
  ) {
    return validateAnswerV3({
      value: localizeKnownCalculationBlocks(value, this.calculations),
      riskLevel: input.riskLevel,
      question: input.run.question,
      requiresExpert: requiresExpertAnswer(input.run.question, input.riskLevel),
      minimumLinkCount,
      knownEvidenceIds: this.evidence.list().map((entry) => entry.id),
      knownLinkIds: this.verifiedLinks.keys(),
      knownLinkBindings: [...this.verifiedLinks.values()].map((link) => ({
        linkId: link.linkId,
        label: link.label,
        evidenceIds: link.evidenceIds ?? []
      })),
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
    allowTools: boolean,
    artifactRecoveryMode?: ArtifactArgumentRecoveryMode
  ): Promise<CollectedModelResponse> {
    try {
      return await this.collectModelResponse(
        input,
        modelInput,
        signal,
        phase,
        allowTools,
        artifactRecoveryMode
      );
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable) throw error;
      signal.throwIfAborted();
      this.retries += 1;
      return this.collectModelResponse(
        input,
        modelInput,
        signal,
        `${phase}_retry`,
        allowTools,
        artifactRecoveryMode
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
    allowTools: boolean,
    artifactRecoveryMode?: ArtifactArgumentRecoveryMode
  ): Promise<CollectedModelResponse> {
    let outputText = "";
    const calls: CollectedModelResponse["calls"] = [];
    let finish: Extract<ResponsesStreamEvent, { type: "finish" }> | undefined;
    const budgetProfile = agentRunBudgetProfile(input.requestedMode);
    const completedCalculations = [...this.calculations.values()];
    const toolPolicy = selectAnswerToolRequestPolicy({
      tools: this.tools.definitions,
      calculations: completedCalculations,
      modelInput,
      question: input.run.question,
      allowTools,
      blockedCallableToolNames: new Set([
        ...this.attemptedNonRepeatableToolNames,
        ...this.serverBlockedCallableToolNames
      ]),
      artifactArgumentRecoveryMode: artifactRecoveryMode
    });
    const forcesArtifact =
      typeof toolPolicy.toolChoice === "object" &&
      toolPolicy.toolChoice.type === "function" &&
      toolPolicy.toolChoice.name === "create_artifact";
    const request: ResponsesStreamRequest = {
      instructions: undefined,
      input: modelInput,
      tools: toolPolicy.tools,
      toolChoice: toolPolicy.toolChoice,
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
      maxOutputTokens: forcesArtifact
        ? MAX_ARTIFACT_PROVIDER_OUTPUT_TOKENS
        : readPositiveInteger(
            budgetProfile.outputTokenEnvironmentName,
            budgetProfile.outputTokenFallback
          ),
      ...(artifactRecoveryMode === "fresh_json_invalid"
        ? { safeInvocationPhase: "artifact_fresh_json_repair" as const }
        : artifactRecoveryMode === "continuation_invalid_arguments"
          ? { safeInvocationPhase: "artifact_continuation_repair" as const }
          : {}),
      user: input.userPartition,
      signal
    };
    // Instructions are kept out of untrusted input and applied on every call.
    request.instructions = buildAgentV3InstructionsForRisk(
      input.riskLevel,
      artifactRecoveryMode
    );
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
    return {
      outputText,
      calls,
      finish,
      callableFunctionNames: new Set(toolPolicy.callableFunctionNames),
      forcedFunctionName:
        typeof toolPolicy.toolChoice === "object" &&
        toolPolicy.toolChoice.type === "function"
          ? toolPolicy.toolChoice.name
          : undefined
    };
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
        protocol: request.safeInvocationPhase ? "chat" : "responses",
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
            const terminalErrorCode = safeProviderTerminalErrorCode(
              event.error?.code
            );
            await failModelInvocation({
              handle,
              errorCode: terminalErrorCode,
              errorMessage: "Provider response failed.",
              providerHttpStatus: 200,
              providerErrorCode: terminalErrorCode,
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
          errorMessage: safeModelInvocationErrorMessage(error),
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

export function buildAgentV3InstructionsForRisk(
  riskLevel: RiskLevel,
  artifactRecoveryMode?: ArtifactArgumentRecoveryMode
): string {
  return [
    AGENT_V3_INSTRUCTIONS,
    `本轮服务端风险等级已固定为 ${riskLevel}；最终答案的 riskLevel 必须原样使用该值，不得由模型重新分类。`,
    "如果复杂或中高风险回答没有可用证据或服务端确定性计算，不得生成无依据的 expert；应使用 clarification 或 safe_refusal。",
    "调用 create_artifact 时，sections 与 tables 至少一个非空；CSV 必须包含非空 tables；每个 section 的 paragraphs 非空。只有通用 ArtifactSpec table 使用 columns 和 cell 数组并要求列数相等；专用 parameter_table provider contract 必须遵循工具定义的 row 对象。",
    ARTIFACT_PROVIDER_INSTRUCTION,
    ...(artifactRecoveryMode === "fresh_json_invalid"
      ? [FRESH_ARTIFACT_ARGUMENT_REPAIR_INSTRUCTION]
      : artifactRecoveryMode === "continuation_invalid_arguments"
        ? [CONTINUATION_ARTIFACT_ARGUMENT_REPAIR_INSTRUCTION]
        : [])
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

function linkRepairPreservesCandidate(
  candidate: AnswerV3,
  repaired: AnswerV3,
  allowedLinks: ReadonlyMap<string, VerifiedLinkPart>
): boolean {
  if (
    JSON.stringify(withoutVerifiedLinkSelection(candidate)) !==
    JSON.stringify(withoutVerifiedLinkSelection(repaired))
  ) {
    return false;
  }
  return repaired.blocks.every((block) => {
    if (block.type !== "link_reference") return true;
    const allowed = allowedLinks.get(block.linkId);
    return Boolean(allowed && block.label === allowed.label);
  });
}

function withoutVerifiedLinkSelection(answer: AnswerV3): AnswerV3 {
  return {
    ...answer,
    blocks: answer.blocks.filter((block) => block.type !== "link_reference"),
    usedLinkIds: []
  };
}

function buildDeterministicVerifiedLinkSelection(
  candidate: AnswerV3,
  allowedLinks: ReadonlyMap<string, VerifiedLinkPart>
): AnswerV3 | undefined {
  const candidateLinkIds = [
    ...candidate.blocks.flatMap((block) =>
      block.type === "link_reference" ? [block.linkId] : []
    ),
    ...candidate.usedLinkIds
  ];
  const uniqueCandidateLinkIds = [...new Set(candidateLinkIds)];
  if (uniqueCandidateLinkIds.length > 1) return undefined;
  const referencedEvidenceIds = new Set(
    collectAnswerV3References(candidate).evidenceIds
  );
  const isEvidenceBound = (link: VerifiedLinkPart) =>
    link.status === "verified" &&
    (link.evidenceIds ?? []).some((evidenceId) =>
      referencedEvidenceIds.has(evidenceId)
    );
  const existingLinkId = uniqueCandidateLinkIds[0];
  const existingLink = existingLinkId
    ? allowedLinks.get(existingLinkId)
    : undefined;
  if (existingLinkId && (!existingLink || !isEvidenceBound(existingLink))) {
    return undefined;
  }
  const selectedLink =
    existingLink ?? [...allowedLinks.values()].find(isEvidenceBound);
  if (!selectedLink) return undefined;
  const linklessCandidate = withoutVerifiedLinkSelection(candidate);
  return {
    ...linklessCandidate,
    blocks: [
      ...linklessCandidate.blocks,
      {
        type: "link_reference",
        linkId: selectedLink.linkId,
        label: selectedLink.label
      }
    ],
    usedLinkIds: [selectedLink.linkId]
  };
}

type CollectedModelResponse = {
  outputText: string;
  calls: Array<{ callId: string; name: string; arguments: string }>;
  finish: Extract<ResponsesStreamEvent, { type: "finish" }>;
  callableFunctionNames: ReadonlySet<string>;
  forcedFunctionName?: string;
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

export function selectAnswerToolChoice(
  question: string,
  modelInput: ResponsesInputItem[],
  calculations: Iterable<CalculationResult>,
  tools: readonly ResponsesTool[] = []
): ResponsesToolChoice {
  const attachmentChoice = selectAttachmentToolChoice(
    question,
    modelInput,
    tools
  );
  if (attachmentChoice) return attachmentChoice;

  const intent =
    /(?:抽空|抽气).{0,12}(?:时间|多久)|(?:时间|多久).{0,12}(?:抽空|抽气)|\bpump(?:\s|-)?down\s+time\b/iu;
  const hasPumpdownCalculation = [...calculations].some(
    (calculation) => calculation.tool === "estimate_pumpdown_time"
  );
  if (
    intent.test(question) &&
    !hasPumpdownCalculation &&
    !hasArtifactCalculationPrerequisite(question)
  ) {
    const trustedArguments = extractTrustedPumpdownArguments(
      question,
      modelInput
    );
    if (trustedArguments) {
      return { type: "function", name: "estimate_pumpdown_time" };
    }
  }

  const artifactChoice = selectArtifactToolChoice(question, modelInput, tools);
  return artifactChoice ?? "auto";
}

function selectArtifactToolChoice(
  question: string,
  modelInput: readonly ResponsesInputItem[],
  tools: readonly ResponsesTool[]
): ResponsesToolChoice | undefined {
  if (
    !hasExplicitArtifactIntent(question) ||
    hasArtifactCalculationPrerequisite(question) ||
    tools.some(
      (tool) =>
        tool.type === "function" &&
        [
          "read_verified_url",
          "search_attachment",
          "open_attachment_excerpt",
          "analyze_image"
        ].includes(tool.name)
    )
  ) {
    return undefined;
  }
  const available = tools.some(
    (tool) => tool.type === "function" && tool.name === "create_artifact"
  );
  const alreadyCalled = modelInput.some(
    (item) => item.type === "function_call" && item.name === "create_artifact"
  );
  return available && !alreadyCalled
    ? { type: "function", name: "create_artifact" }
    : undefined;
}

function selectAttachmentToolChoice(
  question: string,
  modelInput: readonly ResponsesInputItem[],
  tools: readonly ResponsesTool[]
): ResponsesToolChoice | undefined {
  if (!requiresDocumentAttachmentEvidence(question)) {
    return undefined;
  }

  const available = new Set(
    tools.flatMap((tool) => (tool.type === "function" ? [tool.name] : []))
  );
  const called = new Set(
    modelInput.flatMap((item) =>
      item.type === "function_call" ? [item.name] : []
    )
  );
  if (available.has("search_attachment") && !called.has("search_attachment")) {
    return { type: "function", name: "search_attachment" };
  }
  if (
    available.has("open_attachment_excerpt") &&
    called.has("search_attachment") &&
    !called.has("open_attachment_excerpt")
  ) {
    return { type: "function", name: "open_attachment_excerpt" };
  }
  return undefined;
}

export function requiresDocumentAttachmentEvidence(question: string): boolean {
  const normalized = question.normalize("NFKC");
  const documentIntent =
    /(?:手册|文档|报告|记录|\bpdf\b|\bdocument\b|\bmanual\b|附件.{0,8}(?:内容|文字|摘要|页|证据)|(?:内容|文字|摘要|页内|证据).{0,8}附件)/iu;
  const visualIntent =
    /(?:图片|图像|照片|截图|铭牌|\bimage\b|\bphoto\b|\bscreenshot\b|\bnameplate\b)/iu;
  return documentIntent.test(normalized) && !visualIntent.test(normalized);
}

const ARTIFACT_CALCULATION_PREREQUISITE =
  /(?:计算|估算|求解|抽空时间|流导|漏率|气载|吞吐量|有效抽速|\bcalculate\b|\bestimate\b|\bconductance\b|\bthroughput\b|\bpump(?:\s|-)?down\b)/iu;

function hasArtifactCalculationPrerequisite(question: string): boolean {
  return (
    hasExplicitArtifactIntent(question) &&
    ARTIFACT_CALCULATION_PREREQUISITE.test(question.normalize("NFKC"))
  );
}

export function shouldBlockArtifactCreation(
  question: string,
  riskLevel: RiskLevel,
  inputParts: readonly InputMessagePart[]
): boolean {
  if (!hasExplicitArtifactIntent(question)) return false;
  if (riskLevel === "high") return true;
  if (inputParts.some((part) => part.type !== "text")) return true;
  if (hasArtifactCalculationPrerequisite(question)) return true;
  return Boolean(
    buildDeterministicAttachmentScopeAnswerV3(question, riskLevel)
  );
}

export function selectAnswerTools(
  tools: readonly ResponsesTool[],
  calculations: Iterable<CalculationResult>,
  blockedToolNames: ReadonlySet<string> = new Set()
): ResponsesTool[] {
  const completedCalculatorNames = new Set(
    [...calculations].map((calculation) => calculation.tool)
  );
  return tools.filter(
    (tool) =>
      tool.type !== "function" ||
      (!completedCalculatorNames.has(tool.name) &&
        !blockedToolNames.has(tool.name))
  );
}

export function selectContinuationTools(
  tools: readonly ResponsesTool[],
  modelInput: readonly ResponsesInputItem[]
): ResponsesTool[] {
  const calledNames = new Set(
    modelInput.flatMap((item) =>
      item.type === "function_call" && typeof item.name === "string"
        ? [item.name]
        : []
    )
  );
  if (calledNames.size === 0) return [];
  const selected = tools.filter(
    (tool) => tool.type === "function" && calledNames.has(tool.name)
  );
  const resolvedNames = new Set(
    selected.flatMap((tool) => (tool.type === "function" ? [tool.name] : []))
  );
  if ([...calledNames].some((name) => !resolvedNames.has(name))) {
    throw new AgentRuntimeError(
      "TOOL_CONTINUATION_CONTRACT",
      "工具续接缺少已调用函数的定义。",
      false
    );
  }
  return selected;
}

export function selectAnswerToolRequestPolicy(input: {
  tools: readonly ResponsesTool[];
  calculations: Iterable<CalculationResult>;
  modelInput: readonly ResponsesInputItem[];
  question: string;
  allowTools: boolean;
  blockedCallableToolNames?: ReadonlySet<string>;
  artifactArgumentRecoveryMode?: ArtifactArgumentRecoveryMode;
}): {
  tools?: ResponsesTool[];
  toolChoice: ResponsesToolChoice;
  callableFunctionNames: string[];
} {
  const calculations = [...input.calculations];
  const callableTools = input.allowTools
    ? selectAnswerTools(
        input.tools,
        calculations,
        input.blockedCallableToolNames
      )
    : [];
  const replayTools = selectContinuationTools(input.tools, input.modelInput);
  const selectedTools = mergeResponseTools(callableTools, replayTools);
  const artifactRepairAvailable =
    input.artifactArgumentRecoveryMode !== undefined &&
    callableTools.some(
      (tool) => tool.type === "function" && tool.name === "create_artifact"
    );
  const toolChoice =
    input.allowTools && callableTools.length > 0
      ? artifactRepairAvailable
        ? { type: "function" as const, name: "create_artifact" }
        : selectAnswerToolChoice(
            input.question,
            [...input.modelInput],
            calculations,
            callableTools
          )
      : "none";
  const callableFunctionNames =
    !input.allowTools || toolChoice === "none"
      ? []
      : typeof toolChoice === "object"
        ? toolChoice.type === "function"
          ? [toolChoice.name]
          : []
        : callableTools.flatMap((tool) =>
            tool.type === "function" ? [tool.name] : []
          );
  return {
    ...(selectedTools.length > 0 ? { tools: selectedTools } : {}),
    toolChoice,
    callableFunctionNames
  };
}

export function assertAuthorizedFunctionCalls(
  calls: readonly { name: string }[],
  callableFunctionNames: ReadonlySet<string>
): void {
  if (calls.some((call) => !callableFunctionNames.has(call.name))) {
    throw new AgentRuntimeError(
      "TOOL_CALL_NOT_AUTHORIZED",
      "模型请求了本轮未授权执行的工具。",
      false
    );
  }
}

export function reserveNonRepeatableToolCalls(
  calls: readonly { name: string }[],
  attemptedToolNames: Set<string>
): void {
  const pending = new Set<string>();
  for (const call of calls) {
    if (!NON_REPEATABLE_TOOL_NAMES.has(call.name)) continue;
    if (attemptedToolNames.has(call.name) || pending.has(call.name)) {
      throw new AgentRuntimeError(
        "TOOL_REPEAT_NOT_ALLOWED",
        "本轮已尝试创建产物，禁止重复执行。",
        false
      );
    }
    pending.add(call.name);
  }
  for (const name of pending) attemptedToolNames.add(name);
}

function mergeResponseTools(
  callableTools: readonly ResponsesTool[],
  replayTools: readonly ResponsesTool[]
): ResponsesTool[] {
  const seen = new Set<string>();
  return [...callableTools, ...replayTools].filter((tool) => {
    const key = tool.type === "function" ? `function:${tool.name}` : tool.type;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function selectAnswerToolRoundLimit(
  baseLimit: number,
  tools: readonly ResponsesTool[],
  calculations: Iterable<CalculationResult>,
  inputParts: readonly InputMessagePart[]
): number {
  const hasPumpdownCalculation = [...calculations].some(
    (calculation) => calculation.tool === "estimate_pumpdown_time"
  );
  if (!hasPumpdownCalculation) return baseLimit;
  const hasExplicitArtifactTool = tools.some(
    (tool) => tool.type === "function" && tool.name === "create_artifact"
  );
  const hasCurrentTurnResource = inputParts.some(
    (part) => part.type === "link" || part.type === "attachment"
  );
  return (
    baseLimit + (hasExplicitArtifactTool || hasCurrentTurnResource ? 1 : 0)
  );
}

function previousPlainUserText(
  modelInput: ResponsesInputItem[],
  question: string
): string | undefined {
  const texts = modelInput.flatMap((item) => {
    if (item.type !== "message" || item.role !== "user") return [];
    const content = item.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .flatMap((part) => {
                if (!part || typeof part !== "object") return [];
                const record = part as Record<string, unknown>;
                return record.type === "input_text" &&
                  typeof record.text === "string"
                  ? [record.text]
                  : [];
              })
              .join("\n")
          : "";
    const trimmed = text.trim();
    return trimmed && !/^BEGIN_[A-Z0-9_]+/u.test(trimmed)
      ? [trimmed.slice(0, 16_000)]
      : [];
  });
  if (texts.at(-1) === question.trim()) texts.pop();
  return texts.at(-1);
}

export type TrustedPumpdownToolArguments = {
  volume: { value: number; unit: string };
  pumpingSpeed: { value: number; unit: string };
  initialPressure: { value: number; unit: string };
  targetPressure: { value: number; unit: string };
  gasLoad?: { value: number; unit: string };
  outputUnit: "s" | "min" | "h";
};

export function extractTrustedPumpdownArguments(
  question: string,
  modelInput: ResponsesInputItem[]
): TrustedPumpdownToolArguments | undefined {
  const priorUserText = previousPlainUserText(modelInput, question);
  const context =
    priorUserText &&
    /(?:上一轮|上轮|刚才|前述|前面|previous|earlier|above\s+parameters?)/iu.test(
      question
    )
      ? `${priorUserText}\n${question}`
      : question;
  const number = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
  const volume = captureQuantity(
    context,
    new RegExp(
      String.raw`(?:腔体(?:体积|容积)?|体积|容积|\bvolume\b)[^。\n,，;；]{0,24}?(?<value>${number})\s*(?<unit>m3|m³|l|liter|litre)\b`,
      "iu"
    )
  );
  const pumpingSpeed = captureQuantity(
    context,
    new RegExp(
      String.raw`(?:(?:等效)?抽速|泵速|\bpumping\s*speed\b)[^。\n,，;；]{0,24}?(?<value>${number})\s*(?<unit>m3\/s|m³\/s|l\/s|m3\/h|m³\/h|cfm)\b`,
      "iu"
    )
  );
  const pressureUnit = String.raw`(?:kPa|MPa|mbar|bar|mTorr|Torr|micron|atm|Pa)`;
  const transition = new RegExp(
    String.raw`(?:从\s*(?<initialValue>${number})\s*(?<initialUnit>${pressureUnit})\s*(?:抽到|降到|抽至|降至|到达|达到|至|到|抽|降)\s*(?<targetValue>${number})\s*(?<targetUnit>${pressureUnit})\b|\bfrom\s+(?<initialValueEn>${number})\s*(?<initialUnitEn>${pressureUnit})\s+to\s+(?<targetValueEn>${number})\s*(?<targetUnitEn>${pressureUnit})\b)`,
    "iu"
  ).exec(context);
  const initialPressure = captureNamedQuantity(
    transition?.groups,
    ["initialValue", "initialUnit"],
    ["initialValueEn", "initialUnitEn"]
  );
  const targetPressure = captureNamedQuantity(
    transition?.groups,
    ["targetValue", "targetUnit"],
    ["targetValueEn", "targetUnitEn"]
  );
  if (!volume || !pumpingSpeed || !initialPressure || !targetPressure) {
    return undefined;
  }

  const gasLoadLabel = /(?:气载|气体负载|\bgas\s*load\b)/iu;
  const gasLoad = captureQuantity(
    context,
    new RegExp(
      String.raw`(?:气载|气体负载|\bgas\s*load\b)[^。\n,，;；]{0,24}?(?<value>${number})\s*(?<unit>Pa(?:\*|·)m(?:3|³)\/s|mbar(?:\*|·)l\/s|Torr(?:\*|·)l\/s)\b`,
      "iu"
    ),
    true
  );
  if (gasLoadLabel.test(context) && !gasLoad) return undefined;
  const outputUnit = /(?:分钟|\bmin\b)/iu.test(question)
    ? "min"
    : /(?:小时|\bh\b)/iu.test(question)
      ? "h"
      : "s";
  return {
    volume,
    pumpingSpeed,
    initialPressure,
    targetPressure,
    ...(gasLoad ? { gasLoad } : {}),
    outputUnit
  };
}

function captureQuantity(
  value: string,
  pattern: RegExp,
  allowZero = false
): { value: number; unit: string } | undefined {
  const match = pattern.exec(value);
  return captureNamedQuantity(
    match?.groups,
    ["value", "unit"],
    undefined,
    allowZero
  );
}

function captureNamedQuantity(
  groups: Record<string, string> | undefined,
  primary: [string, string],
  fallback?: [string, string],
  allowZero = false
): { value: number; unit: string } | undefined {
  if (!groups) return undefined;
  const rawValue =
    groups[primary[0]] ?? (fallback ? groups[fallback[0]] : undefined);
  const unit =
    groups[primary[1]] ?? (fallback ? groups[fallback[1]] : undefined);
  if (!rawValue || !unit) return undefined;
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric) || (allowZero ? numeric < 0 : numeric <= 0)) {
    return undefined;
  }
  return { value: numeric, unit };
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

export function safeModelInvocationErrorMessage(error: unknown): string {
  if (error instanceof ProviderError) {
    return error.status === undefined
      ? "Provider request failed."
      : `Provider request failed with HTTP ${error.status}.`;
  }
  if (error instanceof AgentRuntimeError) return error.message.slice(0, 1_000);
  return "Unexpected internal error.";
}

export function safeProviderTerminalErrorCode(value: unknown): string {
  switch (value) {
    case "server_error":
      return "PROVIDER_SERVER_ERROR";
    case "rate_limit_error":
      return "PROVIDER_RATE_LIMITED";
    case "invalid_request_error":
      return "PROVIDER_REQUEST_INVALID";
    case "authentication_error":
      return "PROVIDER_AUTH_FAILED";
    case "insufficient_quota":
      return "PROVIDER_QUOTA_EXHAUSTED";
    default:
      return "PROVIDER_RESPONSE_FAILED";
  }
}

const SAFE_ARTIFACT_FAILURE_CODES = new Set([
  "ARTIFACT_RENDER_FAILED",
  "ARTIFACT_PERSIST_FAILED",
  "ARTIFACT_FINALIZE_FAILED",
  "ARTIFACT_CLEANUP_FAILED",
  "ARTIFACT_RUN_ABORTED",
  "ARTIFACT_GENERATION_FAILED",
  "ARTIFACT_INTENT_REQUIRED",
  "INVALID_ARTIFACT_SPEC",
  "ARTIFACT_SCOPE_MISMATCH",
  "ARTIFACT_STORAGE_UNCONFIGURED",
  "ARTIFACT_SCHEMA_UNAVAILABLE",
  "ARTIFACT_STORAGE_FORBIDDEN",
  "ARTIFACT_STORAGE_UNAVAILABLE",
  "ARTIFACT_RECORD_CREATE_TIMEOUT",
  "ARTIFACT_RECORD_CREATE_FAILED",
  "ARTIFACT_ARGUMENTS_TOO_LARGE",
  "ARTIFACT_ARGUMENTS_JSON_INVALID",
  "INVALID_TOOL_ARGUMENTS"
]);

const MAX_ARTIFACT_ARGUMENT_REPAIR_REPLAY_BYTES = 64 * 1024;

export function selectArtifactArgumentRecoveryMode(
  value: unknown,
  priorRepairs: number,
  argumentBytes: number
): ArtifactArgumentRecoveryMode | undefined {
  if (
    priorRepairs !== 0 ||
    !Number.isSafeInteger(argumentBytes) ||
    argumentBytes < 0
  ) {
    return undefined;
  }
  if (
    value === "ARTIFACT_ARGUMENTS_JSON_INVALID" &&
    argumentBytes <= MAX_ARTIFACT_ARGUMENT_BYTES
  ) {
    return "fresh_json_invalid";
  }
  if (
    value === "INVALID_TOOL_ARGUMENTS" &&
    argumentBytes <= MAX_ARTIFACT_ARGUMENT_REPAIR_REPLAY_BYTES
  ) {
    return "continuation_invalid_arguments";
  }
  return undefined;
}

export function buildArtifactRecoveryInput(input: {
  mode: ArtifactArgumentRecoveryMode;
  requestInput: readonly ResponsesInputItem[];
  continuationItems: readonly ResponsesInputItem[];
  safeOutputItem: ResponsesInputItem;
}): ResponsesInputItem[] {
  if (input.mode === "fresh_json_invalid") {
    return [...input.requestInput];
  }
  return [
    ...input.requestInput,
    ...input.continuationItems,
    input.safeOutputItem
  ];
}

export function assertSingleArtifactCall(
  calls: readonly { name: string }[]
): void {
  if (calls.filter((call) => call.name === "create_artifact").length <= 1) {
    return;
  }
  throw new AgentRuntimeError(
    "ARTIFACT_TOOL_CALL_COUNT_MISMATCH",
    "产物生成要求恰好一个 create_artifact 调用。",
    false
  );
}

export function safeArtifactFailureCode(value: unknown): string {
  if (value === "TOOL_TIMEOUT") return "ARTIFACT_GENERATION_TIMEOUT";
  return typeof value === "string" && SAFE_ARTIFACT_FAILURE_CODES.has(value)
    ? value
    : "ARTIFACT_CREATION_FAILED";
}

export function selectAgentRunTimeoutMs(
  resolvedMode: ResolvedAgentMode,
  question: string,
  environment: Record<string, string | undefined> = process.env
): number {
  const modeTimeoutMs = effectiveAgentRunTimeoutMs(resolvedMode, environment);
  return hasExplicitArtifactIntent(question)
    ? Math.max(modeTimeoutMs, EXPLICIT_ARTIFACT_RUN_TIMEOUT_FLOOR_MS)
    : modeTimeoutMs;
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
