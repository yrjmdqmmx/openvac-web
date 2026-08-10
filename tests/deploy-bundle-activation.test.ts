import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const activationScript = join(process.cwd(), "deploy", "activate-bundle.sh");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openvac-deploy-bundle-"));
  temporaryRoots.push(root);
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin);
  write(join(fakeBin, "sync"), "#!/bin/sh\nexit 0\n", 0o700);
  return root;
}

function write(path: string, value: string, mode = 0o600): void {
  writeFileSync(path, value, { encoding: "utf8", mode });
}

function createBundle(
  root: string,
  options: {
    blockDeployment?: boolean;
    bundleName?: string;
    deployExit?: number;
    deployExitAfterCommit?: number;
    includeEnv?: boolean;
    publishPointer?: boolean;
    publishJournal?: boolean;
    publishReceipt?: boolean;
    publishedReleaseId?: string;
  } = {}
): string {
  const bundle = join(root, options.bundleName ?? "bundle");
  const deployDirectory = join(bundle, "deploy");
  mkdirSync(deployDirectory, { recursive: true });
  write(join(bundle, "docker-compose.yml"), "services: {}\n");
  write(
    join(deployDirectory, "deploy.sh"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" > "$1/deploy-invocation"',
      ...(options.blockDeployment
        ? [
            'printf "%s\\n" "ready" >"$1/deploy-child-ready"',
            "trap 'exit 143' TERM",
            "while :; do sleep 1; done"
          ]
        : []),
      `if [ ${options.deployExit ?? 0} -ne 0 ]; then exit ${options.deployExit ?? 0}; fi`,
      'release_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"',
      'case "${OPENVAC_WEB_PRELOADED_ID:-}" in',
      '  sha256:*) image_id="$OPENVAC_WEB_PRELOADED_ID" ;;',
      '  *) image_id="sha256:${2##*@sha256:}" ;;',
      "esac",
      'identity_tmp="$release_dir/.web-image-id-$$"',
      'printf "%s\\n" "$image_id" >"$identity_tmp"',
      'chmod 600 "$identity_tmp"',
      'if [ -f "$release_dir/web-image-id" ] && ! cmp -s "$identity_tmp" "$release_dir/web-image-id"; then',
      '  echo "release SHA is already bound to a different web image ID" >&2',
      '  rm -f "$identity_tmp"',
      "  exit 64",
      "fi",
      'mv -f "$identity_tmp" "$release_dir/web-image-id"',
      ...(options.publishReceipt === false
        ? []
        : [
            'printf "%s\\n" "release=$4" "web_image=$image_id" "migration=passed" "health=passed" "rollback_rehearsal=not-required" "status=healthy" "activation=$OPENVAC_ACTIVATION_ID" >"$release_dir/deployment-receipt"',
            'chmod 600 "$release_dir/deployment-receipt"'
          ]),
      ...(options.publishPointer === false
        ? []
        : [
            options.publishedReleaseId
              ? `printf "%s\\n" "${options.publishedReleaseId}" > "$1/current-release"`
              : 'printf "%s\\n" "$4" > "$1/current-release"',
            'chmod 600 "$1/current-release"'
          ]),
      ...(options.publishJournal
        ? [
            'printf "%s\\n" "status=in-progress" >"$1/deployment-transaction"',
            'chmod 600 "$1/deployment-transaction"'
          ]
        : []),
      `if [ ${options.deployExitAfterCommit ?? 0} -ne 0 ]; then exit ${options.deployExitAfterCommit ?? 0}; fi`,
      "exit 0",
      ""
    ].join("\n")
  );
  copyFileSync(activationScript, join(deployDirectory, "activate-bundle.sh"));
  if (options.includeEnv) {
    write(join(bundle, ".env"), "MUST_NOT_BE_COPIED=true\n");
  }

  const manifestFiles = [
    "docker-compose.yml",
    "deploy/activate-bundle.sh",
    "deploy/deploy.sh"
  ];
  write(
    join(bundle, "DEPLOY_BUNDLE.sha256"),
    `${manifestFiles
      .map((file) => {
        const digest = createHash("sha256")
          .update(readFileSync(join(bundle, file)))
          .digest("hex");
        return `${digest}  ${file}`;
      })
      .join("\n")}\n`
  );
  return bundle;
}

function runActivation(deployRoot: string, bundle: string, releaseId: string) {
  return spawnSync(
    "sh",
    [
      activationScript,
      deployRoot,
      releaseId,
      bundle,
      `ghcr.io/example/openvac@sha256:${"a".repeat(64)}`,
      "openvac-production",
      "https://openvac.example/api/health"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dirname(deployRoot), "bin")}:${process.env.PATH ?? ""}`,
        OPENVAC_ACTIVATION_TEST_ROOT: deployRoot
      }
    }
  );
}

function runActivationWithImages(
  deployRoot: string,
  bundle: string,
  releaseId: string,
  webImage: string,
  extraEnv: Record<string, string> = {}
) {
  return spawnSync(
    "sh",
    [
      activationScript,
      deployRoot,
      releaseId,
      bundle,
      webImage,
      "openvac-production",
      "https://openvac.example/api/health"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dirname(deployRoot), "bin")}:${process.env.PATH ?? ""}`,
        OPENVAC_ACTIVATION_TEST_ROOT: deployRoot,
        ...extraEnv
      }
    }
  );
}

function spawnActivation(
  deployRoot: string,
  bundle: string,
  releaseId: string,
  extraEnv: Record<string, string> = {}
): ChildProcess {
  return spawn(
    "sh",
    [
      activationScript,
      deployRoot,
      releaseId,
      bundle,
      `ghcr.io/example/openvac@sha256:${"a".repeat(64)}`,
      "openvac-production",
      "https://openvac.example/api/health"
    ],
    {
      env: {
        ...process.env,
        PATH: `${join(dirname(deployRoot), "bin")}:${process.env.PATH ?? ""}`,
        OPENVAC_ACTIVATION_TEST_ROOT: deployRoot,
        ...extraEnv
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
}

async function waitForPath(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForChild(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

describe("deployment bundle activation", () => {
  it("installs an immutable release without copying or replacing host .env", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const bundle = createBundle(root);
    const releaseId = "a".repeat(40);

    const result = runActivation(deployRoot, bundle, releaseId);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(deployRoot, ".env"), "utf8")).toBe(
      "HOST_SECRET=preserved\n"
    );
    expect(readFileSync(join(deployRoot, "current-release"), "utf8")).toBe(
      `${releaseId}\n`
    );
    expect(
      readFileSync(
        join(deployRoot, "releases", releaseId, "docker-compose.yml"),
        "utf8"
      )
    ).toBe("services: {}\n");
    expect(
      readFileSync(join(deployRoot, "deploy-invocation"), "utf8")
    ).toContain(
      `ghcr.io/example/openvac@sha256:${"a".repeat(64)} openvac-production ${releaseId}`
    );
    expect(
      readFileSync(
        join(deployRoot, "releases", releaseId, "web-image-id"),
        "utf8"
      )
    ).toBe(`sha256:${"a".repeat(64)}\n`);
    expect(() =>
      readFileSync(join(deployRoot, "releases", releaseId, ".env"), "utf8")
    ).toThrow();
    expect(
      readFileSync(
        join(deployRoot, "releases", releaseId, "deployment-receipt"),
        "utf8"
      )
    ).toMatch(new RegExp(`activation=${releaseId}-[0-9a-f]{32}\\n$`));
  });

  it("uses a fresh high-entropy activation nonce when redeploying one release", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const bundle = createBundle(root);
    const releaseId = "2".repeat(40);

    const firstResult = runActivation(deployRoot, bundle, releaseId);
    const firstReceipt = readFileSync(
      join(deployRoot, "releases", releaseId, "deployment-receipt"),
      "utf8"
    );
    const secondResult = runActivation(deployRoot, bundle, releaseId);
    const secondReceipt = readFileSync(
      join(deployRoot, "releases", releaseId, "deployment-receipt"),
      "utf8"
    );

    expect(firstResult.status, firstResult.stderr).toBe(0);
    expect(secondResult.status, secondResult.stderr).toBe(0);
    expect(secondReceipt).not.toBe(firstReceipt);
    expect(secondReceipt).toMatch(
      new RegExp(`activation=${releaseId}-[0-9a-f]{32}\\n$`)
    );
  });

  it("keeps the previous release active when deployment fails", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(join(deployRoot, "releases"), { recursive: true });
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const previousRelease = "b".repeat(40);
    write(join(deployRoot, "current-release"), `${previousRelease}\n`);
    const bundle = createBundle(root, { deployExit: 1 });
    const releaseId = "c".repeat(40);

    const result = runActivation(deployRoot, bundle, releaseId);

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(deployRoot, "current-release"), "utf8")).toBe(
      `${previousRelease}\n`
    );
    expect(readFileSync(join(deployRoot, ".env"), "utf8")).toBe(
      "HOST_SECRET=preserved\n"
    );
  });

  it("rejects bundles containing environment files", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const bundle = createBundle(root, { includeEnv: true });
    const releaseId = "d".repeat(40);

    const result = runActivation(deployRoot, bundle, releaseId);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("environment files");
    expect(readFileSync(join(deployRoot, ".env"), "utf8")).toBe(
      "HOST_SECRET=preserved\n"
    );
  });

  it("rejects truncated image digests before installing a release", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const bundle = createBundle(root);

    const result = runActivationWithImages(
      deployRoot,
      bundle,
      "e".repeat(40),
      "ghcr.io/example/openvac@sha256:abc123"
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("64-character SHA-256 digest");
    expect(() => readFileSync(join(deployRoot, "current-release"))).toThrow();
  });

  it("accepts a content-addressed preloaded web image", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const bundle = createBundle(root);
    const webDigest = "c".repeat(64);

    const result = runActivationWithImages(
      deployRoot,
      bundle,
      "3".repeat(40),
      `openvac-web-release:${webDigest}`,
      { OPENVAC_WEB_PRELOADED_ID: `sha256:${webDigest}` }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(deployRoot, "current-release"), "utf8")).toBe(
      `${"3".repeat(40)}\n`
    );
    expect(
      readFileSync(
        join(deployRoot, "releases", "3".repeat(40), "web-image-id"),
        "utf8"
      )
    ).toBe(`sha256:${webDigest}\n`);
  });

  it("rejects rebinding one release SHA to a different loaded web image ID", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const bundle = createBundle(root);
    const releaseId = "7".repeat(40);
    const firstDigest = "c".repeat(64);
    const secondDigest = "d".repeat(64);

    const firstResult = runActivationWithImages(
      deployRoot,
      bundle,
      releaseId,
      `openvac-web-release:${firstDigest}`,
      { OPENVAC_WEB_PRELOADED_ID: `sha256:${firstDigest}` }
    );
    const secondResult = runActivationWithImages(
      deployRoot,
      bundle,
      releaseId,
      `openvac-web-release:${secondDigest}`,
      { OPENVAC_WEB_PRELOADED_ID: `sha256:${secondDigest}` }
    );

    expect(firstResult.status, firstResult.stderr).toBe(0);
    expect(secondResult.status).not.toBe(0);
    expect(secondResult.stderr).toContain(
      "release SHA is already bound to a different web image ID"
    );
    expect(
      readFileSync(
        join(deployRoot, "releases", releaseId, "web-image-id"),
        "utf8"
      )
    ).toBe(`sha256:${firstDigest}\n`);
  });

  it("completes the pointer when deploy.sh leaves a verified receipt", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const bundle = createBundle(root, { publishPointer: false });
    const releaseId = "8".repeat(40);

    const result = runActivation(deployRoot, bundle, releaseId);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      "Completed the release pointer from the verified deployment receipt"
    );
    expect(readFileSync(join(deployRoot, "current-release"), "utf8")).toBe(
      `${releaseId}\n`
    );
  });

  it("corrects a pointer using the receipt from the current activation", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const publishedReleaseId = "9".repeat(40);
    const bundle = createBundle(root, { publishedReleaseId });

    const result = runActivation(deployRoot, bundle, "a".repeat(40));

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(deployRoot, "current-release"), "utf8")).toBe(
      `${"a".repeat(40)}\n`
    );
  });

  it("refuses a receipt-less success without rewriting its pointer", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(join(deployRoot, "releases"), { recursive: true });
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const previousRelease = "6".repeat(40);
    write(join(deployRoot, "current-release"), `${previousRelease}\n`);
    const bundle = createBundle(root, { publishReceipt: false });

    const result = runActivation(deployRoot, bundle, "a".repeat(40));

    expect(result.status).toBe(64);
    expect(result.stderr).toContain(
      "deploy.sh did not publish a regular deployment receipt"
    );
    expect(readFileSync(join(deployRoot, "current-release"), "utf8")).toBe(
      `${"a".repeat(40)}\n`
    );
  });

  it("recovers a committed release when deploy.sh exits after its commit", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const releaseId = "4".repeat(40);
    const bundle = createBundle(root, { deployExitAfterCommit: 137 });

    const result = runActivation(deployRoot, bundle, releaseId);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      "Recovered a committed release after the deployment child exited unexpectedly"
    );
    expect(readFileSync(join(deployRoot, "current-release"), "utf8")).toBe(
      `${releaseId}\n`
    );
  });

  it("keeps the journal when recovery cannot durably sync an already visible pointer", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    const fakeBin = join(root, "bin");
    mkdirSync(deployRoot);
    mkdirSync(fakeBin, { recursive: true });
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    write(
      join(fakeBin, "sync"),
      [
        "#!/bin/sh",
        "set -eu",
        'case "${2:-}" in',
        "  */current-release) exit 1 ;;",
        "esac",
        "exit 0",
        ""
      ].join("\n"),
      0o700
    );
    const releaseId = "0".repeat(40);
    const bundle = createBundle(root, {
      deployExitAfterCommit: 137,
      publishJournal: true
    });

    const result = runActivationWithImages(
      deployRoot,
      bundle,
      releaseId,
      `ghcr.io/example/openvac@sha256:${"a".repeat(64)}`,
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain(
      "verified deployment pointer could not be durably synced"
    );
    expect(
      readFileSync(join(deployRoot, "deployment-transaction"), "utf8")
    ).toBe("status=in-progress\n");
  });

  it("does not recover a deliberate non-signal failure after pointer publication", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const releaseId = "1".repeat(40);
    const bundle = createBundle(root, { deployExitAfterCommit: 1 });

    const result = runActivation(deployRoot, bundle, releaseId);

    expect(result.status).toBe(64);
    expect(result.stderr).toContain(
      "deploy.sh failed without a recoverable termination signal"
    );
    expect(readFileSync(join(deployRoot, "current-release"), "utf8")).toBe(
      `${releaseId}\n`
    );
  });

  it("refuses a concurrent activation without removing the existing lock", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    mkdirSync(join(deployRoot, ".activation-lock"), { mode: 0o700 });
    const bundle = createBundle(root);

    const result = runActivation(deployRoot, bundle, "5".repeat(40));

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("activation is already in progress");
    expect(() => readFileSync(join(deployRoot, "current-release"))).toThrow();
    expect(readdirSync(deployRoot)).toContain(".activation-lock");
  });

  it("never removes an expired lock without one exact live deployment child", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const lockDirectory = join(deployRoot, ".activation-lock");
    mkdirSync(lockDirectory, { mode: 0o700 });
    const ownerFile = join(lockDirectory, "owner");
    write(ownerFile, `${"8".repeat(40)}-${"9".repeat(32)}\n`);
    const expiredAt = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(ownerFile, expiredAt, expiredAt);
    const bundle = createBundle(root);

    const result = runActivation(deployRoot, bundle, "a".repeat(40));

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("activation is already in progress");
    expect(readFileSync(ownerFile, "utf8")).toBe(
      `${"8".repeat(40)}-${"9".repeat(32)}\n`
    );
  });

  it.skipIf(process.platform !== "linux")(
    "terminates only the exact expired staging activation child before reacquiring its lock",
    async () => {
      const root = temporaryRoot();
      const deployRoot = join(root, "host");
      mkdirSync(deployRoot);
      write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
      const blockingBundle = createBundle(root, {
        blockDeployment: true,
        bundleName: "blocking-bundle"
      });
      const recoveryBundle = createBundle(root, {
        bundleName: "recovery-bundle"
      });
      const blockedRelease = "6".repeat(40);
      const recoveredRelease = "7".repeat(40);
      const blocked = spawnActivation(
        deployRoot,
        blockingBundle,
        blockedRelease,
        { OPENVAC_ACTIVATION_TEST_DISABLE_HEARTBEAT: "true" }
      );

      try {
        await waitForPath(join(deployRoot, "deploy-child-ready"));
        const ownerFile = join(deployRoot, ".activation-lock", "owner");
        const expiredAt = new Date(Date.now() - 31 * 60 * 1000);
        utimesSync(ownerFile, expiredAt, expiredAt);

        const recovered = runActivation(
          deployRoot,
          recoveryBundle,
          recoveredRelease
        );
        expect(recovered.status, recovered.stderr).toBe(0);
        expect(recovered.stderr).toContain(
          "Recovering a stale staging deployment activation after its lease expired"
        );
        expect(readFileSync(join(deployRoot, "current-release"), "utf8")).toBe(
          `${recoveredRelease}\n`
        );
        expect(await waitForChild(blocked)).not.toBe(0);
      } finally {
        if (blocked.exitCode === null) blocked.kill("SIGTERM");
      }
    },
    10_000
  );

  it("rejects a preloaded web tag that does not match its image ID", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const bundle = createBundle(root);

    const result = runActivationWithImages(
      deployRoot,
      bundle,
      "4".repeat(40),
      `openvac-web-release:${"c".repeat(64)}`,
      { OPENVAC_WEB_PRELOADED_ID: `sha256:${"d".repeat(64)}` }
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain(
      "preloaded web reference must be content-addressed by its image ID"
    );
    expect(() => readFileSync(join(deployRoot, "current-release"))).toThrow();
  });

  it("rejects a host environment file with permissive mode", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    writeFileSync(join(deployRoot, ".env"), "HOST_SECRET=exposed\n", {
      encoding: "utf8",
      mode: 0o644
    });
    const bundle = createBundle(root);

    const result = runActivation(deployRoot, bundle, "f".repeat(40));

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("mode 0600");
    expect(() => readFileSync(join(deployRoot, "current-release"))).toThrow();
  });
});
