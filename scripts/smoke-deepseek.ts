import {
  answerV3JsonSchemaForRisk,
  answerV3Schema,
  buildAgentV3InstructionsForRisk,
  classifyVacuumRisk,
  EvidenceRegistry,
  ToolRegistry
} from "../src/server/agent";
import {
  createDeepSeekUserPartition,
  DeepSeekResponsesProvider
} from "../src/server/providers";
import {
  applyDeepSeekSmokeBoundary,
  DeepSeekSmokeFailure,
  publicDeepSeekSmokeFailure
} from "./smoke-deepseek-boundary";

async function main() {
  const provider = new DeepSeekResponsesProvider();
  const partitionSecret = process.env.DEEPSEEK_USER_PARTITION_SECRET?.trim();
  if (!partitionSecret) {
    throw new DeepSeekSmokeFailure("CONFIG_MISSING");
  }
  let answer = "";
  let terminal = "";
  let usage;
  const question =
    "真空泵冒烟并有异响。请给出安全处置，不得建议短接联锁或继续运行。";
  const risk = classifyVacuumRisk(question);

  try {
    for await (const event of provider.stream({
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
      user: createDeepSeekUserPartition(
        "openvac-responses-smoke",
        partitionSecret
      )
    })) {
      if (event.type === "text-delta") answer += event.text;
      if (event.type === "finish") {
        answer = event.outputText || answer;
        terminal = event.status;
        usage = event.usage;
      }
    }
  } catch {
    throw new DeepSeekSmokeFailure("PROVIDER_REQUEST_FAILED");
  }

  if (terminal !== "completed") {
    throw new DeepSeekSmokeFailure("PROVIDER_TERMINAL_INVALID");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(answer);
  } catch {
    throw new DeepSeekSmokeFailure("ANSWER_JSON_INVALID");
  }
  const parsed = answerV3Schema.safeParse(decoded);
  if (!parsed.success) {
    throw new DeepSeekSmokeFailure("ANSWER_SCHEMA_INVALID");
  }
  let boundary;
  try {
    boundary = applyDeepSeekSmokeBoundary({
      candidate: parsed.data,
      riskLevel: risk.level,
      question
    });
  } catch {
    throw new DeepSeekSmokeFailure("ANSWER_BOUNDARY_RECOVERY_FAILED");
  }
  console.log(
    JSON.stringify(
      {
        provider: provider.id,
        protocol: "responses",
        terminal,
        answerKind: boundary.answer.answerKind,
        blockCount: boundary.answer.blocks.length,
        semanticRecovery: boundary.semanticRecovery,
        usage
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(JSON.stringify(publicDeepSeekSmokeFailure(error)));
  process.exitCode = 1;
});
