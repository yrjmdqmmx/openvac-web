import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const authenticationScript = join(
  process.cwd(),
  "deploy",
  "authenticate-ghcr.sh"
);
const temporaryRoots: string[] = [];
const token = "ghp_fixture_secret_value";

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openvac-ghcr-auth-"));
  temporaryRoots.push(root);
  chmodSync(root, 0o700);
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin, { mode: 0o700 });
  const dockerLog = join(root, "docker.log");
  const dockerStdin = join(root, "docker.stdin");
  writeFileSync(
    join(fakeBin, "docker"),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >"$OPENVAC_FAKE_DOCKER_LOG"
cat >"$OPENVAC_FAKE_DOCKER_STDIN"
printf '%s\\n' 'Login Succeeded'
`,
    { encoding: "utf8", mode: 0o700 }
  );
  writeFileSync(
    join(fakeBin, "stat"),
    `#!/bin/sh
set -eu
[ "$1" = -c ]
[ "$2" = %a ]
if value=$(/usr/bin/stat -c '%a' "$3" 2>/dev/null); then
  printf '%s\\n' "$value"
else
  /usr/bin/stat -f '%Lp' "$3"
fi
`,
    { encoding: "utf8", mode: 0o700 }
  );
  writeFileSync(join(root, "openvac-ghcr-token"), token, {
    encoding: "utf8",
    mode: 0o600
  });
  chmodSync(join(root, "openvac-ghcr-token"), 0o600);
  return { root, fakeBin, dockerLog, dockerStdin };
}

function authenticate(
  current: ReturnType<typeof fixture>,
  username = "openvac-bot"
) {
  return spawnSync("sh", [authenticationScript, current.root, username], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${current.fakeBin}:${process.env.PATH ?? ""}`,
      OPENVAC_GHCR_AUTH_TEST_ROOT: current.root,
      OPENVAC_FAKE_DOCKER_LOG: current.dockerLog,
      OPENVAC_FAKE_DOCKER_STDIN: current.dockerStdin
    }
  });
}

describe("temporary GHCR authentication", () => {
  it("uses password-stdin with a private ephemeral Docker configuration", () => {
    const current = fixture();

    const result = authenticate(current);

    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(readFileSync(current.dockerLog, "utf8")).toBe(
      "login ghcr.io --username openvac-bot --password-stdin\n"
    );
    expect(readFileSync(current.dockerStdin, "utf8")).toBe(token);
    expect(existsSync(join(current.root, "openvac-ghcr-token"))).toBe(false);
    expect(lstatSync(join(current.root, "docker-config")).mode & 0o777).toBe(
      0o700
    );
  });

  it("rejects permissive and symlinked token files", () => {
    const permissive = fixture();
    chmodSync(join(permissive.root, "openvac-ghcr-token"), 0o644);
    const permissiveResult = authenticate(permissive);
    expect(permissiveResult.status).toBe(64);
    expect(permissiveResult.stderr).toContain("mode 0600");

    const symlinked = fixture();
    const tokenFile = join(symlinked.root, "openvac-ghcr-token");
    const tokenTarget = join(symlinked.root, "actual-token");
    writeFileSync(tokenTarget, token, { encoding: "utf8", mode: 0o600 });
    rmSync(tokenFile);
    symlinkSync(tokenTarget, tokenFile);
    const symlinkResult = authenticate(symlinked);
    expect(symlinkResult.status).toBe(64);
    expect(symlinkResult.stderr).toContain("not a symlink");
  });

  it("rejects wrong stage roots, unsafe usernames and secret arguments", () => {
    const wrongRoot = fixture();
    const wrongRootResult = spawnSync(
      "sh",
      [authenticationScript, wrongRoot.root, "openvac-bot"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${wrongRoot.fakeBin}:${process.env.PATH ?? ""}`,
          OPENVAC_GHCR_AUTH_TEST_ROOT: `${wrongRoot.root}-different`
        }
      }
    );
    expect(wrongRootResult.status).toBe(64);

    const unsafeUsername = fixture();
    expect(authenticate(unsafeUsername, "bad user").status).toBe(64);

    const secretArgument = fixture();
    const secretArgumentResult = spawnSync(
      "sh",
      [authenticationScript, secretArgument.root, "openvac-bot", token],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENVAC_GHCR_AUTH_TEST_ROOT: secretArgument.root
        }
      }
    );
    expect(secretArgumentResult.status).toBe(64);
    expect(
      `${secretArgumentResult.stdout}${secretArgumentResult.stderr}`
    ).not.toContain(token);
  });
});
