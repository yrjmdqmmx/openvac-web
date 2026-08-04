import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const requiredAgentEnvironment = [
  "AGENT_RESPONSES_V2",
  "AGENT_AUTO_MAX_OUTPUT_TOKENS",
  "AGENT_DEEP_MAX_OUTPUT_TOKENS",
  "AGENT_AUTO_TIMEOUT_MS",
  "AGENT_DEEP_TIMEOUT_MS",
  "AGENT_STALE_RUN_MS",
  "DEEPSEEK_ALLOWED_HOSTS",
  "DEEPSEEK_RESPONSES_MODEL",
  "DEEPSEEK_USER_PARTITION_SECRET",
  "MODEL_INPUT_COST_MICROS_PER_MILLION_TOKENS",
  "MODEL_OUTPUT_COST_MICROS_PER_MILLION_TOKENS",
  "MODEL_PRICE_VERSION",
  "ALIBABA_WEB_SEARCH_COST_MICROS_PER_CALL",
  "ALIBABA_WEB_SEARCH_PRICE_VERSION"
] as const;

describe("Agent V2 deployment contract", () => {
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
  });
});
