import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const requiredAgentEnvironment = [
  "AGENT_AUTO_MAX_OUTPUT_TOKENS",
  "AGENT_DEEP_MAX_OUTPUT_TOKENS",
  "AGENT_AUTO_TIMEOUT_MS",
  "AGENT_DEEP_TIMEOUT_MS",
  "AGENT_QUERY_EMBEDDING_TIMEOUT_MS",
  "AGENT_STALE_RUN_MS",
  "DEEPSEEK_ALLOWED_HOSTS",
  "DEEPSEEK_RESPONSES_MODEL",
  "DEEPSEEK_USER_PARTITION_SECRET",
  "MODEL_INPUT_COST_MICROS_PER_MILLION_TOKENS",
  "MODEL_OUTPUT_COST_MICROS_PER_MILLION_TOKENS",
  "MODEL_PRICE_VERSION",
  "WEB_SEARCH_PER_USER_DAILY_LIMIT",
  "WEB_SEARCH_GLOBAL_DAILY_LIMIT",
  "WEB_SEARCH_ALLOWED_DOMAINS",
  "QWEN_VL_API_KEY",
  "QWEN_VL_BASE_URL",
  "QWEN_VL_ALLOWED_HOSTS",
  "QWEN_VL_MODEL",
  "QWEN_VL_MAX_OUTPUT_TOKENS",
  "QWEN_VL_ENABLE_THINKING",
  "QWEN_VL_HIGH_RESOLUTION_IMAGES"
] as const;

describe("Agent deployment contract", () => {
  it("declares every server-only runtime value in the example and Compose environment", () => {
    const example = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    const compose = readFileSync(
      join(process.cwd(), "docker-compose.yml"),
      "utf8"
    );

    for (const key of requiredAgentEnvironment) {
      expect(example, `${key} is missing from .env.example`).toMatch(
        new RegExp(`^${key}=`, "mu")
      );
      expect(
        compose,
        `${key} is not passed to application containers`
      ).toContain(`  ${key}: \${${key}:-`);
    }

    expect(example).toContain("AGENT_AUTO_TIMEOUT_MS=120000");
    expect(compose).toContain(
      "AGENT_AUTO_TIMEOUT_MS: ${AGENT_AUTO_TIMEOUT_MS:-120000}"
    );
    expect(example).toContain("AGENT_QUERY_EMBEDDING_TIMEOUT_MS=8000");
    expect(compose).toContain(
      "AGENT_QUERY_EMBEDDING_TIMEOUT_MS: ${AGENT_QUERY_EMBEDDING_TIMEOUT_MS:-8000}"
    );
    expect(example).toContain("QWEN_VL_MODEL=qwen3.8-max");
    expect(compose).toContain("QWEN_VL_MODEL: ${QWEN_VL_MODEL:-qwen3.8-max}");
    expect(example).toContain("QWEN_VL_ENABLE_THINKING=false");
    expect(compose).toContain(
      "QWEN_VL_ENABLE_THINKING: ${QWEN_VL_ENABLE_THINKING:-false}"
    );
    expect(example).toContain("QWEN_VL_BASE_URL=");
    expect(example).toContain("QWEN_VL_ALLOWED_HOSTS=");
    expect(compose).toContain("QWEN_VL_BASE_URL: ${QWEN_VL_BASE_URL:-}");
    expect(compose).toContain(
      "QWEN_VL_ALLOWED_HOSTS: ${QWEN_VL_ALLOWED_HOSTS:-}"
    );
    expect(`${example}\n${compose}`).not.toContain(
      "QWEN_VL_BASE_URL=https://dashscope.aliyuncs.com"
    );
    expect(`${example}\n${compose}`).not.toContain(
      "QWEN_VL_ALLOWED_HOSTS=dashscope.aliyuncs.com"
    );
    const provider = readFileSync(
      join(process.cwd(), "src/server/providers/qwen-vl.ts"),
      "utf8"
    );
    expect(provider).toContain('configured === "qwen3-vl-plus"');
    expect(provider).toContain("optionalString(process.env.QWEN_VL_API_KEY)");
    expect(provider).toContain("optionalString(process.env.DASHSCOPE_API_KEY)");
  });

  it("wires the timeout floor and mode-specific tool-round budget into the orchestrator", () => {
    const orchestrator = readFileSync(
      join(process.cwd(), "src/server/agent/orchestrator.ts"),
      "utf8"
    );

    expect(orchestrator).toContain("effectiveAgentRunTimeoutMs");
    expect(orchestrator).toContain("budgetProfile.maxToolRounds");
  });

  it("uses only DeepSeek native web search while keeping disabled rollback aliases", () => {
    const root = process.cwd();
    const example = readFileSync(join(root, ".env.example"), "utf8");
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
    const webEvidence = readFileSync(
      join(root, "src/server/agent/web-evidence.ts"),
      "utf8"
    );
    const orchestrator = readFileSync(
      join(root, "src/server/agent/orchestrator.ts"),
      "utf8"
    );

    expect(
      existsSync(join(root, "src/server/providers/alibaba-web-search.ts"))
    ).toBe(false);
    expect(`${webEvidence}\n${orchestrator}`).not.toMatch(
      /getWebSearchProvider|AlibabaWebSearchProvider|alibaba-fallback|web_fallback/u
    );
    expect(example).not.toContain("DASHSCOPE_NATIVE_ENDPOINT");
    expect(compose).not.toContain("DASHSCOPE_NATIVE_ENDPOINT");
    expect(example).toContain("ALIBABA_WEB_SEARCH_ENABLED=false");
    expect(compose).toContain('ALIBABA_WEB_SEARCH_ENABLED: "false"');
  });
});
