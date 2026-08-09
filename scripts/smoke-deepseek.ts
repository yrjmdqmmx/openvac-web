import {
  AGENT_V3_INSTRUCTIONS,
  ANSWER_V3_JSON_SCHEMA,
  answerV3Schema,
  EvidenceRegistry,
  ToolRegistry
} from "../src/server/agent";
import {
  createDeepSeekUserPartition,
  DeepSeekResponsesProvider
} from "../src/server/providers";

async function main() {
  const provider = new DeepSeekResponsesProvider();
  const partitionSecret = process.env.DEEPSEEK_USER_PARTITION_SECRET?.trim();
  if (!partitionSecret) {
    throw new Error("DEEPSEEK_USER_PARTITION_SECRET is required.");
  }
  let answer = "";
  let terminal = "";
  let usage;

  for await (const event of provider.stream({
    instructions: AGENT_V3_INSTRUCTIONS,
    input: "真空泵冒烟并有异响。请给出安全处置，不得建议短接联锁或继续运行。",
    tools: new ToolRegistry(new EvidenceRegistry()).definitions,
    toolChoice: "none",
    reasoningEffort: "xhigh",
    textFormat: {
      type: "json_schema",
      name: "openvac_answer_v3",
      schema: ANSWER_V3_JSON_SCHEMA as unknown as Record<string, unknown>,
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

  if (terminal !== "completed") {
    throw new Error(`Responses smoke ended with ${terminal || "no terminal"}.`);
  }
  const parsed = answerV3Schema.parse(JSON.parse(answer));
  console.log(
    JSON.stringify(
      {
        provider: provider.id,
        protocol: "responses",
        terminal,
        answerKind: parsed.answerKind,
        blockCount: parsed.blocks.length,
        usage
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    "DeepSeek Responses smoke test failed:",
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
