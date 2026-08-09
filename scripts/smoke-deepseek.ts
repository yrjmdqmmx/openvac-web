import {
  answerV3JsonSchemaForRisk,
  buildTrustedCalculationFinalInput,
  buildAgentV3InstructionsForRisk,
  classifyVacuumRisk,
  EvidenceRegistry,
  ToolRegistry,
  trustedPumpdownProjectionFromToolTurn
} from "../src/server/agent";
import {
  createDeepSeekUserPartition,
  DeepSeekResponsesProvider,
  type ResponsesInputItem,
  type ResponsesStreamEvent,
  type ResponsesStreamRequest,
  type ResponsesUsage
} from "../src/server/providers";
import {
  applyDeepSeekToolProjectionBoundary,
  applyDeepSeekSmokeBoundary,
  classifyDeepSeekSmokeProviderFailure,
  DeepSeekSmokeFailure,
  parseDeepSeekSmokeAnswer,
  publicDeepSeekSmokeFailure
} from "./smoke-deepseek-boundary";

async function main() {
  const provider = new DeepSeekResponsesProvider();
  const partitionSecret = process.env.DEEPSEEK_USER_PARTITION_SECRET?.trim();
  if (!partitionSecret) {
    throw new DeepSeekSmokeFailure("CONFIG_MISSING");
  }
  const userPartition = createDeepSeekUserPartition(
    "openvac-responses-smoke",
    partitionSecret
  );
  const question =
    "真空泵冒烟并有异响。请给出安全处置，不得建议短接联锁或继续运行。";
  const risk = classifyVacuumRisk(question);

  let safety;
  try {
    safety = await collectProbe(provider, {
      instructions: buildAgentV3InstructionsForRisk(risk.level),
      input: question,
      tools: new ToolRegistry(new EvidenceRegistry()).definitions,
      toolChoice: "none",
      reasoningEffort: "xhigh",
      textFormat: {
        type: "json_schema",
        name: "openvac_answer_v3",
        schema: answerV3JsonSchemaForRisk(risk.level),
        strict: true
      },
      user: userPartition
    });
  } catch (error) {
    throw classifyDeepSeekSmokeProviderFailure(
      "PROVIDER_REQUEST_FAILED",
      "safety",
      error
    );
  }

  if (safety.terminal !== "completed") {
    throw new DeepSeekSmokeFailure("PROVIDER_TERMINAL_INVALID");
  }
  let boundary;
  try {
    boundary = applyDeepSeekSmokeBoundary({
      candidate: parseDeepSeekSmokeAnswer(safety.outputText),
      riskLevel: risk.level,
      question
    });
  } catch {
    throw new DeepSeekSmokeFailure("ANSWER_BOUNDARY_RECOVERY_FAILED");
  }

  const toolContract = await runToolContinuationProbe(provider, userPartition);
  console.log(
    JSON.stringify(
      {
        provider: provider.id,
        protocol: "responses",
        terminal: safety.terminal,
        answerKind: boundary.answer.answerKind,
        blockCount: boundary.answer.blocks.length,
        semanticRecovery: boundary.semanticRecovery,
        usage: safety.usage,
        toolContract
      },
      null,
      2
    )
  );
}

type ProbeResult = {
  outputText: string;
  terminal: "completed" | "incomplete" | "failed" | "";
  usage?: ResponsesUsage;
  calls: Array<Extract<ResponsesStreamEvent, { type: "function-call" }>>;
  continuationItems: ResponsesInputItem[];
};

async function collectProbe(
  provider: DeepSeekResponsesProvider,
  request: ResponsesStreamRequest
): Promise<ProbeResult> {
  let outputText = "";
  let terminal: ProbeResult["terminal"] = "";
  let usage: ResponsesUsage | undefined;
  let continuationItems: ResponsesInputItem[] = [];
  const calls: ProbeResult["calls"] = [];
  for await (const event of provider.stream(request)) {
    if (event.type === "text-delta") outputText += event.text;
    if (event.type === "function-call") calls.push(event);
    if (event.type === "finish") {
      outputText = event.outputText || outputText;
      terminal = event.status;
      usage = event.usage;
      continuationItems = event.continuationItems;
    }
  }
  return { outputText, terminal, usage, calls, continuationItems };
}

async function runToolContinuationProbe(
  provider: DeepSeekResponsesProvider,
  userPartition: string
): Promise<{
  terminal: "completed";
  callCount: 1;
  resultTransport: "trusted_projection";
  semanticRecovery: "none" | "deterministic_calculation";
}> {
  const question =
    "腔体体积 100 L、等效抽速 10 L/s；估算从 100 Pa 抽到 1 Pa 的理想抽空时间。";
  const risk = classifyVacuumRisk(question);
  const registry = new ToolRegistry(new EvidenceRegistry());
  const input: ResponsesInputItem[] = [
    { type: "message", role: "user", content: question }
  ];
  let first: ProbeResult;
  try {
    first = await collectProbe(provider, {
      instructions: buildAgentV3InstructionsForRisk(risk.level),
      input,
      tools: registry.definitions,
      toolChoice: { type: "function", name: "estimate_pumpdown_time" },
      reasoningEffort: "high",
      textFormat: {
        type: "json_schema",
        name: "openvac_answer_v3",
        schema: answerV3JsonSchemaForRisk(risk.level),
        strict: true
      },
      user: userPartition
    });
  } catch (error) {
    throw classifyDeepSeekSmokeProviderFailure(
      "PROVIDER_REQUEST_FAILED",
      "tool_first",
      error
    );
  }
  const call = first.calls[0];
  if (
    first.terminal !== "completed" ||
    first.calls.length !== 1 ||
    !call ||
    call.name !== "estimate_pumpdown_time"
  ) {
    throw new DeepSeekSmokeFailure("TOOL_CALL_INVALID");
  }
  const execution = await registry.execute({
    callId: call.callId,
    name: call.name,
    arguments: call.arguments
  });
  if (!execution.ok) {
    throw new DeepSeekSmokeFailure("TOOL_EXECUTION_FAILED");
  }
  const projection = trustedPumpdownProjectionFromToolTurn({
    calls: first.calls,
    continuationItems: first.continuationItems,
    outputs: [execution]
  });
  if (!projection) {
    throw new DeepSeekSmokeFailure("TOOL_CONTINUATION_INVALID");
  }
  let final: ProbeResult;
  try {
    final = await collectProbe(provider, {
      instructions: buildAgentV3InstructionsForRisk(risk.level),
      input: buildTrustedCalculationFinalInput(input, projection),
      toolChoice: "none",
      reasoningEffort: "high",
      textFormat: {
        type: "json_schema",
        name: "openvac_answer_v3",
        schema: answerV3JsonSchemaForRisk(risk.level),
        strict: true
      },
      user: userPartition
    });
  } catch (error) {
    throw classifyDeepSeekSmokeProviderFailure(
      "TOOL_CONTINUATION_INVALID",
      "tool_final",
      error
    );
  }
  if (final.terminal !== "completed" || final.calls.length !== 0) {
    throw new DeepSeekSmokeFailure("TOOL_CONTINUATION_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(final.outputText);
  } catch {
    parsed = undefined;
  }
  const boundary = applyDeepSeekToolProjectionBoundary({
    candidate: parsed,
    riskLevel: risk.level === "medium" ? "medium" : "low",
    calculations: execution.calculations,
    calculationIds: new Set([projection.calculationId])
  });
  return {
    terminal: "completed",
    callCount: 1,
    resultTransport: "trusted_projection",
    semanticRecovery: boundary.semanticRecovery
  };
}

main().catch((error) => {
  console.error(JSON.stringify(publicDeepSeekSmokeFailure(error)));
  process.exitCode = 1;
});
