import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const configurationScript = join(
  process.cwd(),
  "deploy",
  "configure-modeling-runtime.sh"
);
const temporaryRoots: string[] = [];
const firstToken = "a".repeat(64);
const secondToken = "b".repeat(64);

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(environment = "APP_URL=https://example.test\n") {
  const root = mkdtempSync(join(tmpdir(), "openvac-modeling-config-"));
  temporaryRoots.push(root);
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin);
  writeFileSync(join(root, ".env"), environment, {
    encoding: "utf8",
    mode: 0o600
  });
  writeFileSync(join(fakeBin, "stat"), portableStat(), {
    encoding: "utf8",
    mode: 0o700
  });
  return { root, fakeBin, envFile: join(root, ".env") };
}

function portableStat(): string {
  return `#!/bin/sh
set -eu
[ "$1" = -c ]
case "$2" in
  %a)
    if value=$(/usr/bin/stat -c '%a' "$3" 2>/dev/null); then
      printf '%s\\n' "$value"
    else
      /usr/bin/stat -f '%Lp' "$3"
    fi
    ;;
  *) exit 1 ;;
esac
`;
}

function runConfiguration(
  root: string,
  fakeBin: string,
  options: {
    target?: string;
    enabled?: string;
    stdin?: string;
    extraArguments?: string[];
  } = {}
) {
  return spawnSync(
    "sh",
    [
      configurationScript,
      options.target ?? "staging",
      options.enabled ?? "true",
      ...(options.extraArguments ?? [])
    ],
    {
      encoding: "utf8",
      input: options.stdin ?? `${firstToken}\n`,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        OPENVAC_MODELING_CONFIG_TEST_ROOT: root
      }
    }
  );
}

describe("modeling runtime configuration", () => {
  it("atomically appends a stdin-only token and enables modeling", () => {
    const current = fixture();
    const previousInode = statSync(current.envFile).ino;

    const result = runConfiguration(current.root, current.fakeBin);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("false\n");
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(firstToken);
    expect(readFileSync(current.envFile, "utf8")).toBe(
      `APP_URL=https://example.test\nMODELING_SERVICE_TOKEN=${firstToken}\nMODELING_ENABLED=true\n`
    );
    expect(statSync(current.envFile).ino).not.toBe(previousInode);
    expect(lstatSync(current.envFile).mode & 0o777).toBe(0o600);
  });

  it("updates existing keys without exposing or rotating the token", () => {
    const current = fixture(
      `MODELING_SERVICE_TOKEN=${firstToken}\nMODELING_ENABLED=false\nKEEP=value\n`
    );

    const result = runConfiguration(current.root, current.fakeBin, {
      enabled: "true"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("false\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain(firstToken);
    expect(readFileSync(current.envFile, "utf8")).toBe(
      `MODELING_SERVICE_TOKEN=${firstToken}\nMODELING_ENABLED=true\nKEEP=value\n`
    );

    const rotation = runConfiguration(current.root, current.fakeBin, {
      stdin: `${secondToken}\n`
    });
    expect(rotation.status).toBe(64);
    expect(rotation.stderr).toContain("rotation requires a separate");
    expect(`${rotation.stdout}${rotation.stderr}`).not.toContain(secondToken);
  });

  it.each([
    ["short", `${"a".repeat(63)}\n`],
    ["uppercase", `${"A".repeat(64)}\n`],
    ["extra line", `${firstToken}\nunexpected\n`],
    ["missing newline", firstToken]
  ])("rejects an invalid %s stdin token", (_label, stdin) => {
    const current = fixture();

    const result = runConfiguration(current.root, current.fakeBin, { stdin });

    expect(result.status).toBe(64);
    expect(`${result.stdout}${result.stderr}`).not.toContain(firstToken);
    expect(readFileSync(current.envFile, "utf8")).toBe(
      "APP_URL=https://example.test\n"
    );
  });

  it("rejects secret arguments, unsupported targets and invalid enable values", () => {
    const current = fixture();

    const secretArgument = runConfiguration(current.root, current.fakeBin, {
      extraArguments: [firstToken]
    });
    const wrongTarget = runConfiguration(current.root, current.fakeBin, {
      target: "preview"
    });
    const wrongEnabled = runConfiguration(current.root, current.fakeBin, {
      enabled: "yes"
    });

    expect(secretArgument.status).toBe(64);
    expect(wrongTarget.status).toBe(64);
    expect(wrongEnabled.status).toBe(64);
    expect(`${secretArgument.stdout}${secretArgument.stderr}`).not.toContain(
      firstToken
    );
  });

  it("rejects symlinks, permissive files and duplicate keys", () => {
    const symlinkFixture = fixture();
    const realEnvironment = join(symlinkFixture.root, "real.env");
    writeFileSync(realEnvironment, "MODELING_ENABLED=false\n", {
      encoding: "utf8",
      mode: 0o600
    });
    rmSync(symlinkFixture.envFile);
    symlinkSync(realEnvironment, symlinkFixture.envFile);

    const symlinkResult = runConfiguration(
      symlinkFixture.root,
      symlinkFixture.fakeBin
    );
    expect(symlinkResult.status).toBe(64);
    expect(symlinkResult.stderr).toContain("not a symlink");

    const permissiveFixture = fixture();
    chmodSync(permissiveFixture.envFile, 0o644);
    const permissiveResult = runConfiguration(
      permissiveFixture.root,
      permissiveFixture.fakeBin
    );
    expect(permissiveResult.status).toBe(64);
    expect(permissiveResult.stderr).toContain("mode 0600");

    const duplicateFixture = fixture(
      "MODELING_ENABLED=false\nMODELING_ENABLED=true\n"
    );
    const duplicateResult = runConfiguration(
      duplicateFixture.root,
      duplicateFixture.fakeBin
    );
    expect(duplicateResult.status).toBe(64);
    expect(duplicateResult.stderr).toContain("duplicate MODELING_ENABLED");
  });
});
