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
  const chatRoute = readFileSync(
    join(process.cwd(), "src/app/api/chat/route.ts"),
    "utf8"
  );
  const agentHttp = readFileSync(
    join(process.cwd(), "src/server/agent/http-v2.ts"),
    "utf8"
  );
  const artifactRuntime = readFileSync(
    join(process.cwd(), "src/server/chat-attachments/artifact-runtime.ts"),
    "utf8"
  );
  const artifactStorage = readFileSync(
    join(process.cwd(), "src/server/chat-attachments/artifact-storage.ts"),
    "utf8"
  );
  const runSettlement = readFileSync(
    join(process.cwd(), "src/server/agent/run-settlement.ts"),
    "utf8"
  );
  const exampleEnvironment = readFileSync(
    join(process.cwd(), ".env.example"),
    "utf8"
  );
  const compose = readFileSync(
    join(process.cwd(), "docker-compose.yml"),
    "utf8"
  );

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

  it("uses V3 as the only runtime request path", () => {
    expect(chatRoute).toContain("return postAgentV3(request)");
    expect(chatRoute).not.toContain("postLegacyChat");
    expect(chatRoute).not.toContain("agentResponsesV3Enabled");
    expect(agentHttp).toContain("protocolVersion: z.literal(3)");
    expect(agentHttp).toContain("本次 DeepSeek 联网搜索额度已用尽");
    expect(agentHttp).not.toContain("protocolVersion: z.literal(2)");
    expect(exampleEnvironment).not.toContain("AGENT_RESPONSES_V2");
    expect(compose).not.toContain("AGENT_RESPONSES_V2");
  });

  it("binds artifacts to the active run and cleans failed runs", () => {
    expect(artifactStorage).toContain(
      "id, user_id, conversation_id, message_id, source_turn_id"
    );
    expect(artifactStorage).toContain("active_run.assistant_message_id = $4");
    expect(artifactStorage).toContain(
      "completed_run.status IN ('completed', 'incomplete')"
    );
    expect(artifactRuntime).toContain("input.signal?.throwIfAborted()");
    expect(runSettlement).toContain("chat_storage_deletion_job");
    expect(runSettlement).toContain("on conflict (object_key) do nothing");
    expect(agentHttp).toContain('settlement: "pending_recovery"');
  });

  it("propagates only the fixed answer validation stage on failed runs", () => {
    expect(agentHttp).toContain("error.answerValidationStage");
    expect(agentHttp).toContain("{ answerValidationStage }");
    expect(agentHttp).not.toContain("validated.errors");
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
