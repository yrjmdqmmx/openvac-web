import { createHash } from "node:crypto";
import {
  copyFileSync,
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
  return root;
}

function write(path: string, value: string): void {
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
}

function createBundle(
  root: string,
  options: { deployExit?: number; includeEnv?: boolean } = {}
): string {
  const bundle = join(root, "bundle");
  const deployDirectory = join(bundle, "deploy");
  mkdirSync(deployDirectory, { recursive: true });
  write(join(bundle, "docker-compose.yml"), "services: {}\n");
  write(
    join(deployDirectory, "deploy.sh"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" > "$1/deploy-invocation"',
      `exit ${options.deployExit ?? 0}`,
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
      `ghcr.io/example/openvac@sha256:${"b".repeat(64)}`,
      "openvac-production",
      "https://openvac.example/api/health"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
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
  modelingImage = `ghcr.io/example/openvac@sha256:${"b".repeat(64)}`,
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
      modelingImage,
      "openvac-production",
      "https://openvac.example/api/health"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENVAC_ACTIVATION_TEST_ROOT: deployRoot,
        ...extraEnv
      }
    }
  );
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
      `ghcr.io/example/openvac@sha256:${"a".repeat(64)} ghcr.io/example/openvac@sha256:${"b".repeat(64)} openvac-production`
    );
    expect(() =>
      readFileSync(join(deployRoot, "releases", releaseId, ".env"), "utf8")
    ).toThrow();
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

  it("rejects a truncated modeling-image digest before installing a release", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const bundle = createBundle(root);

    const result = runActivationWithImages(
      deployRoot,
      bundle,
      "1".repeat(40),
      `ghcr.io/example/openvac@sha256:${"a".repeat(64)}`,
      "ghcr.io/example/openvac@sha256:abc123"
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("64-character SHA-256 digest");
    expect(() => readFileSync(join(deployRoot, "current-release"))).toThrow();
  });

  it("rejects identical web and modeling digests", () => {
    const root = temporaryRoot();
    const deployRoot = join(root, "host");
    mkdirSync(deployRoot);
    write(join(deployRoot, ".env"), "HOST_SECRET=preserved\n");
    const bundle = createBundle(root);
    const image = `ghcr.io/example/openvac@sha256:${"a".repeat(64)}`;

    const result = runActivationWithImages(
      deployRoot,
      bundle,
      "2".repeat(40),
      image,
      image
    );

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("must have distinct digests");
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
      `ghcr.io/example/openvac@sha256:${"b".repeat(64)}`,
      { OPENVAC_WEB_PRELOADED_ID: `sha256:${webDigest}` }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(deployRoot, "current-release"), "utf8")).toBe(
      `${"3".repeat(40)}\n`
    );
  });

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
      `ghcr.io/example/openvac@sha256:${"b".repeat(64)}`,
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
