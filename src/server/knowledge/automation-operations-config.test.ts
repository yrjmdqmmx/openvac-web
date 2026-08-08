import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

describe("knowledge review automation operations configuration", () => {
  it("exposes only the server-side token hash through example and Compose configuration", async () => {
    const [example, compose] = await Promise.all([
      readFile(resolve(root, ".env.example"), "utf8"),
      readFile(resolve(root, "docker-compose.yml"), "utf8")
    ]);

    expect(example).toContain("KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256=");
    expect(compose).toContain(
      "KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256: ${KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256:-}"
    );
    expect(compose).not.toContain("OPENVAC_KNOWLEDGE_REVIEW_TOKEN");
  });

  it("provides runner and dry-run-first requeue package scripts", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts["knowledge:requeue-pending"]).toBe(
      "tsx scripts/requeue-pending-knowledge.ts"
    );
    expect(manifest.scripts["knowledge:automation-runner"]).toBe(
      "tsx scripts/knowledge-review-runner.ts"
    );
  });

  it("keeps local lease-bearing runner state out of Git", async () => {
    const [gitignore, dockerignore] = await Promise.all([
      readFile(resolve(root, ".gitignore"), "utf8"),
      readFile(resolve(root, ".dockerignore"), "utf8")
    ]);
    expect(gitignore).toContain("/.openvac/");
    expect(dockerignore).toContain(".openvac");
  });
});
