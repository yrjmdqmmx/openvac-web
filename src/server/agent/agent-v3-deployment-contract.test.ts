import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Agent V3 deployment contract", () => {
  const release = readFileSync(
    join(process.cwd(), "docs/agent-v3-release.md"),
    "utf8"
  );
  const deployment = readFileSync(
    join(process.cwd(), "docs/deployment.md"),
    "utf8"
  );
  const releaseContract = release.replace(/\s+/gu, " ");
  const deploymentContract = deployment.replace(/\s+/gu, " ");
  const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8")
  ) as { scripts: Record<string, string> };

  it("requires additive migration and preserves V2 history for image rollback", () => {
    expect(releaseContract).toContain("migration must be additive");
    expect(releaseContract).toContain("Do not run a database down migration");
    expect(releaseContract).toContain("V2 plaintext history");
    expect(deploymentContract).toContain(
      "V3 attachment/artifact migration must also be additive"
    );
  });

  it("gates staging with live judges and exact score thresholds", () => {
    expect(releaseContract).toContain("pnpm eval:answer:v3:live");
    expect(releaseContract).toContain("independent Qwen model");
    expect(releaseContract).toContain("DeepSeek cross-judge");
    expect(releaseContract).toContain("failure, never a skip");
    expect(releaseContract).toContain("must each equal 100%");
    expect(releaseContract).toContain("aggregate score must be at least");
    expect(releaseContract).toContain("must each be at least 85%");
  });

  it("promotes the same immutable digest and rolls back the previous image", () => {
    expect(releaseContract).toContain(
      "Production must consume the same immutable image digest"
    );
    expect(releaseContract).toContain("Do not rebuild");
    expect(releaseContract).toContain("activate the previous image digest");
  });

  it("keeps fixture, live, artifact, and browser commands executable", () => {
    expect(packageJson.scripts["eval:answer:v3"]).toBe(
      "tsx scripts/eval-answer-v3.ts"
    );
    expect(packageJson.scripts["eval:answer:v3:live"]).toContain("--live");
    expect(packageJson.scripts["test:artifacts"]).toContain("vitest run");
    expect(packageJson.scripts["test:e2e:agent-v3"]).toContain(
      "agent-v3-contract.spec.ts"
    );
  });

  it("states that the release document is not production authorization", () => {
    expect(releaseContract).toContain(
      "does not authorize or claim an actual staging or production operation"
    );
    expect(deploymentContract).toContain(
      "Do not interpret that contract as authorization or evidence of an actual production deployment."
    );
  });
});
