import {
  buildExpertPrompt,
  hasRequiredAnswerSections,
  REQUIRED_ANSWER_SECTIONS,
  validateCitations
} from "../src/server/agent";
import { DeepSeekModelProvider } from "../src/server/providers/deepseek";
import type { ModelUsage } from "../src/server/providers/types";

async function main() {
  const provider = new DeepSeekModelProvider();
  const prompt = buildExpertPrompt({
    question:
      "在没有具体型号和工况数据时，说明水环真空泵选型前还需要确认哪些输入。不要虚构参数或来源。",
    evidence: []
  });
  let answer = "";
  let finishReason = "";
  let usage: ModelUsage | undefined;

  for await (const event of provider.stream({
    messages: prompt.messages,
    temperature: 0,
    maxOutputTokens: 1200
  })) {
    if (event.type === "text-delta") answer += event.text;
    if (event.type === "finish") {
      finishReason = event.finishReason ?? "";
      usage = event.usage;
    }
  }

  const citationCheck = validateCitations(answer, []);
  const sectionsValid = hasRequiredAnswerSections(answer);
  const headings = REQUIRED_ANSWER_SECTIONS.filter((heading) =>
    answer.includes(heading)
  );

  if (!sectionsValid || !citationCheck.valid || !finishReason) {
    throw new Error(
      JSON.stringify({
        sectionsValid,
        citationErrors: citationCheck.errors,
        finishReason: finishReason || null
      })
    );
  }

  console.log(
    JSON.stringify(
      {
        provider: provider.id,
        model: provider.model,
        finishReason,
        characters: answer.length,
        headings,
        citationsValid: citationCheck.valid,
        usage
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    "DeepSeek smoke test failed:",
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
