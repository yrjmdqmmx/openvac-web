import { pathToFileURL } from "node:url";

import {
  answerV3JsonSchemaForRisk,
  buildTrustedCalculationFinalInput,
  buildAgentV3InstructionsForRisk,
  classifyVacuumRisk,
  EvidenceRegistry,
  ToolRegistry
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
  collectDeepSeekToolProbeWithOneTransportRetry,
  collectCompletedSafetyProbeWithOneRetry,
  DeepSeekSmokeFailure,
  executeDeepSeekSmokeTrustedToolTurn,
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
    const request: ResponsesStreamRequest = {
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
    };
    safety = await collectCompletedSafetyProbeWithOneRetry(() =>
      collectProbe(provider, request)
    );
  } catch (error) {
    if (error instanceof DeepSeekSmokeFailure) throw error;
    throw classifyDeepSeekSmokeProviderFailure(
      "PROVIDER_REQUEST_FAILED",
      "safety",
      error
    );
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

type DeepSeekProbeProvider = Pick<DeepSeekResponsesProvider, "stream">;
type DeepSeekProbeRegistry = Pick<ToolRegistry, "definitions" | "execute">;

async function collectProbe(
  provider: DeepSeekProbeProvider,
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

export async function runToolContinuationProbe(
  provider: DeepSeekProbeProvider,
  userPartition: string,
  registry: DeepSeekProbeRegistry = new ToolRegistry(new EvidenceRegistry())
): Promise<{
  terminal: "completed";
  callCount: 1;
  resultTransport: "trusted_projection";
  semanticRecovery: "none" | "deterministic_calculation";
}> {
  const question =
    "腔体体积 100 L、等效抽速 10 L/s；估算从 100 Pa 抽到 1 Pa 的理想抽空时间。";
  const risk = classifyVacuumRisk(question);
  const input: ResponsesInputItem[] = [
    { type: "message", role: "user", content: question }
  ];
  let first: ProbeResult;
  try {
    const request: ResponsesStreamRequest = {
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
    };
    first = await collectDeepSeekToolProbeWithOneTransportRetry(() =>
      collectProbe(provider, request)
    );
  } catch (error) {
    throw classifyDeepSeekSmokeProviderFailure(
      "PROVIDER_REQUEST_FAILED",
      "tool_first",
      error
    );
  }
  const trustedTurn = await executeDeepSeekSmokeTrustedToolTurn({
    question,
    modelInput: input,
    probe: first,
    execute: (call) => registry.execute(call)
  });
  let final: ProbeResult;
  try {
    final = await collectProbe(provider, {
      instructions: buildAgentV3InstructionsForRisk(risk.level),
      input: buildTrustedCalculationFinalInput(input, trustedTurn.projection),
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
    calculations: trustedTurn.calculations,
    calculationIds: new Set([trustedTurn.projection.calculationId])
  });
  return {
    terminal: "completed",
    callCount: 1,
    resultTransport: "trusted_projection",
    semanticRecovery: boundary.semanticRecovery
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(JSON.stringify(publicDeepSeekSmokeFailure(error)));
    process.exitCode = 1;
  });
}
