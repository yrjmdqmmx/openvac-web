import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const selector = join(repositoryRoot, "deploy/select-release-archive.mjs");
const runId = 31450677960;

describe("same-run release archive selection", () => {
  it("reuses the latest completed archive when only the failed job is rerun", () => {
    const result = runSelector(
      artifacts([
        artifact("unrelated.dockerbuild", 1),
        artifact(`openvac-web-release-${runId}-1`, 1)
      ]),
      2
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`openvac-web-release-${runId}-1`);
  });

  it("prefers the current attempt after a complete workflow rerun", () => {
    const result = runSelector(
      artifacts([
        artifact(`openvac-web-release-${runId}-1`, 1),
        artifact(`openvac-web-release-${runId}-2`, 2)
      ]),
      2
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`openvac-web-release-${runId}-2`);
  });

  it("fails closed for expired, foreign, future, or ambiguous archives", () => {
    const invalidResponses = [
      artifacts([
        { ...artifact(`openvac-web-release-${runId}-1`, 1), expired: true }
      ]),
      artifacts([
        {
          ...artifact(`openvac-web-release-${runId}-1`, 1),
          workflow_run: { id: runId + 1 }
        }
      ]),
      artifacts([artifact(`openvac-web-release-${runId}-3`, 3)]),
      artifacts([
        artifact(`openvac-web-release-${runId}-1`, 1),
        artifact(`openvac-web-release-${runId}-1`, 1)
      ])
    ];

    for (const response of invalidResponses) {
      expect(runSelector(response, 2).status).toBe(1);
    }
  });
});

function artifact(name: string, id: number) {
  return {
    id,
    name,
    expired: false,
    workflow_run: { id: runId }
  };
}

function artifacts(entries: ReturnType<typeof artifact>[]) {
  return { total_count: entries.length, artifacts: entries };
}

function runSelector(payload: unknown, runAttempt: number) {
  const directory = mkdtempSync(join(tmpdir(), "openvac-release-archive-"));
  const input = join(directory, "artifacts.json");
  writeFileSync(input, `${JSON.stringify(payload)}\n`, "utf8");
  return spawnSync(
    process.execPath,
    [selector, input, String(runId), String(runAttempt)],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
}
