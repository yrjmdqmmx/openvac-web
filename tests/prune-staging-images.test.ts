import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const pruneScript = join(process.cwd(), "deploy", "prune-staging-images.sh");
const temporaryRoots: string[] = [];
const targetId = `sha256:${"a".repeat(64)}`;
const usedId = `sha256:${"b".repeat(64)}`;
const staleId = `sha256:${"c".repeat(64)}`;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openvac-staging-prune-"));
  temporaryRoots.push(root);
  const fakeBin = join(root, "bin");
  const removalLog = join(root, "removed.log");
  mkdirSync(fakeBin, { mode: 0o700 });
  const docker = join(fakeBin, "docker");
  writeFileSync(
    docker,
    `#!/bin/sh
set -eu
case "$1:$2" in
  image:inspect) printf '%s\n' "$OPENVAC_FAKE_TARGET_ID" ;;
  ps:-aq) printf '%s\n' container-one ;;
  inspect:--format) printf '%s\n' "$OPENVAC_FAKE_USED_ID" ;;
  image:ls)
    printf '%s\n' "$OPENVAC_FAKE_TARGET_ID" "$OPENVAC_FAKE_USED_ID" "$OPENVAC_FAKE_STALE_ID" "$OPENVAC_FAKE_STALE_ID"
    ;;
  image:rm)
    [ "$3" = --force ]
    printf '%s\n' "$4" >>"$OPENVAC_FAKE_REMOVAL_LOG"
    ;;
  *) exit 99 ;;
esac
`,
    { encoding: "utf8", mode: 0o700 }
  );
  chmodSync(docker, 0o700);
  return { root, fakeBin, removalLog };
}

function runPrune(current: ReturnType<typeof fixture>, image: string) {
  return spawnSync("sh", [pruneScript, image], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${current.fakeBin}:${process.env.PATH ?? ""}`,
      OPENVAC_FAKE_TARGET_ID: targetId,
      OPENVAC_FAKE_USED_ID: usedId,
      OPENVAC_FAKE_STALE_ID: staleId,
      OPENVAC_FAKE_REMOVAL_LOG: current.removalLog
    }
  });
}

describe("staging release image cleanup", () => {
  it("removes only unreferenced OpenVac staging image IDs", () => {
    const current = fixture();
    const result = runPrune(
      current,
      `openvac-web-release:${targetId.replace(/^sha256:/u, "")}`
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Pruned 1 unused staging release image");
    expect(result.stdout).not.toMatch(/[a-f0-9]{64}/u);
    expect(result.stderr).toBe("");
    expect(readFileSync(current.removalLog, "utf8")).toBe(`${staleId}\n`);
  });

  it("rejects images outside the private staging namespace", () => {
    const current = fixture();
    const result = runPrune(
      current,
      `ghcr.io/example/openvac@sha256:${"d".repeat(64)}`
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("private staging release namespace");
    expect(existsSync(current.removalLog)).toBe(false);
  });
});
