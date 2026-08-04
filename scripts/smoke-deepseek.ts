import {
  AGENT_V2_INSTRUCTIONS,
  ANSWER_V2_JSON_SCHEMA,
  answerV2Schema
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
    instructions: AGENT_V2_INSTRUCTIONS,
    input:
      "在没有具体型号和工况数据时，说明水环真空泵选型前还需要确认哪些输入。不要虚构参数或来源。",
    toolChoice: "none",
    reasoningEffort: "low",
    textFormat: {
      type: "json_schema",
      name: "openvac_answer_v2",
      schema: ANSWER_V2_JSON_SCHEMA as unknown as Record<string, unknown>,
      strict: true
    },
    maxOutputTokens: 1_200,
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
  const parsed = answerV2Schema.parse(JSON.parse(answer));
  console.log(
    JSON.stringify(
      {
        provider: provider.id,
        protocol: "responses",
        terminal,
        answerKind: parsed.answerKind,
        conclusionCount: parsed.conclusion.length,
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
