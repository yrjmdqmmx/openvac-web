import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const optionalPublicFields = [
  "OPERATOR_NAME",
  "OPERATOR_ADDRESS",
  "PUBLIC_CONTACT_EMAIL",
  "LEGAL_COMPLAINT_EMAIL",
  "ICP_FILING_NUMBER",
  "GEN_AI_FILING_NUMBER"
] as const;

describe("public operations deployment configuration", () => {
  it("documents every optional public field without fake defaults", () => {
    const example = source(".env.example");

    for (const field of optionalPublicFields) {
      expect(example).toContain(`${field}=`);
    }
  });

  it("passes every optional public field into the shared app environment", () => {
    const compose = source("docker-compose.yml");

    for (const field of optionalPublicFields) {
      expect(compose).toContain(`${field}: \${${field}:-}`);
    }
  });
});
