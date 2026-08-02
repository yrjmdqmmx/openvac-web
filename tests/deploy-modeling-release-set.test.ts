import {
  chmodSync,
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

const deployScript = join(process.cwd(), "deploy", "deploy.sh");
const preflightScript = join(process.cwd(), "deploy", "preflight-host.sh");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openvac-modeling-deploy-"));
  temporaryRoots.push(root);
  return root;
}

function write(path: string, value: string, mode = 0o600): void {
  writeFileSync(path, value, { encoding: "utf8", mode });
  chmodSync(path, mode);
}

function createFixture(options: { hasModeling?: boolean } = {}) {
  const root = temporaryRoot();
  const host = join(root, "host");
  const bundle = join(root, "bundle");
  const bundleDeploy = join(bundle, "deploy");
  const fakeBin = join(root, "bin");
  const state = join(root, "state");
  const log = join(root, "docker.log");
  const meminfo = join(root, "meminfo");
  const previousRelease = "c".repeat(40);
  const previousReleaseDirectory = join(host, "releases", previousRelease);
  mkdirSync(host, { recursive: true });
  mkdirSync(bundleDeploy, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(previousReleaseDirectory, { recursive: true });
  write(join(host, ".env"), "MODELING_ENABLED=false\n");
  write(join(bundle, "docker-compose.yml"), "services: {}\n");
  write(join(previousReleaseDirectory, "docker-compose.yml"), "services: {}\n");
  write(join(host, "current-release"), `${previousRelease}\n`);
  write(meminfo, "MemTotal:        8388608 kB\n");
  copyFileSync(deployScript, join(bundleDeploy, "deploy.sh"));
  chmodSync(join(bundleDeploy, "deploy.sh"), 0o700);
  copyFileSync(preflightScript, join(bundleDeploy, "preflight-host.sh"));
  chmodSync(join(bundleDeploy, "preflight-host.sh"), 0o700);
  write(
    join(bundleDeploy, "backup.sh"),
    "#!/bin/sh\nset -eu\nprintf '%s\\n' \"$OPENVAC_FAKE_BACKUP\"\n",
    0o700
  );
  write(
    join(fakeBin, "df"),
    [
      "#!/bin/sh",
      "printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
      "printf 'fake 100000000 1 %s 1%% /\\n' \"${OPENVAC_FAKE_AVAILABLE_KB:-99999999}\"",
      ""
    ].join("\n"),
    0o700
  );
  write(join(fakeBin, "sleep"), "#!/bin/sh\nexit 0\n", 0o700);
  write(join(fakeBin, "curl"), "#!/bin/sh\nexit 0\n", 0o700);
  write(
    join(fakeBin, "getconf"),
    "#!/bin/sh\nprintf '%s\\n' \"${OPENVAC_FAKE_CPU_COUNT:-4}\"\n",
    0o700
  );
  write(
    join(fakeBin, "stat"),
    [
      "#!/bin/sh",
      'case "$2" in',
      "  %a) printf '%s\\n' 600 ;;",
      "  %s) printf '%s\\n' 41 ;;",
      "  *) exit 1 ;;",
      "esac",
      ""
    ].join("\n"),
    0o700
  );
  write(join(fakeBin, "docker"), fakeDocker(), 0o700);
  if (options.hasModeling) {
    write(join(state, "modeling-container"), "old-modeling\n");
    write(join(state, "modeling-worker-container"), "old-modeling-worker\n");
  }
  return {
    root,
    host,
    bundle,
    fakeBin,
    state,
    log,
    meminfo,
    previousRelease
  };
}

function fakeDocker(): string {
  return `#!/bin/sh
set -eu
printf 'web=%s modeling=%s enabled=%s args=%s\\n' "\${OPENVAC_IMAGE:-}" "\${OPENVAC_MODELING_IMAGE:-}" "\${MODELING_ENABLED:-}" "$*" >>"$OPENVAC_FAKE_DOCKER_LOG"

if [ "$1" = inspect ]; then
  format="$3"
  container="$4"
  case "$format:$container" in
    *Config.Env*:old-web) printf '%s\\n' 'MODELING_ENABLED=false' ;;
    *Image*:old-web|*Image*:old-worker) printf '%s\\n' 'sha256:old-application' ;;
    *Image*:old-modeling) printf '%s\\n' 'sha256:old-modeling' ;;
    *Image*:old-modeling-worker) printf '%s\\n' 'sha256:old-application' ;;
    *Health*:new-modeling|*Health*:old-modeling) printf '%s\\n' healthy ;;
    *State.Status*:old-worker|*State.Status*:old-modeling-worker) printf '%s\\n' 'running false 0' ;;
    *State.Status*:new-modeling-worker) printf '%s\\n' 'dead false 0' ;;
    *) exit 1 ;;
  esac
  exit 0
fi

case " $* " in
  *" ps -q web "*) printf '%s\\n' old-web ;;
  *" ps -q worker "*) printf '%s\\n' old-worker ;;
  *" ps -q modeling-service "*)
    if [ -f "$OPENVAC_FAKE_STATE/modeling-container" ]; then
      cat "$OPENVAC_FAKE_STATE/modeling-container"
    fi
    ;;
  *" ps -q modeling-worker "*)
    if [ -f "$OPENVAC_FAKE_STATE/modeling-worker-container" ]; then
      cat "$OPENVAC_FAKE_STATE/modeling-worker-container"
    fi
    ;;
  *" up -d --no-deps modeling-service "*)
    if [ "\${OPENVAC_MODELING_IMAGE:-}" = sha256:old-modeling ]; then
      printf '%s\\n' old-modeling >"$OPENVAC_FAKE_STATE/modeling-container"
    else
      printf '%s\\n' new-modeling >"$OPENVAC_FAKE_STATE/modeling-container"
    fi
    ;;
  *" run --rm --no-deps modeling-worker pnpm modeling:verify-runtime "*)
    if [ "\${OPENVAC_FAKE_RUNTIME_FAIL:-}" = true ]; then
      exit 1
    fi
    ;;
  *" stop -t 30 modeling-worker "*)
    rm -f "$OPENVAC_FAKE_STATE/modeling-worker-container"
    ;;
  *" up -d --no-deps modeling-worker "*)
    if [ "\${OPENVAC_IMAGE:-}" = sha256:old-application ]; then
      printf '%s\\n' old-modeling-worker >"$OPENVAC_FAKE_STATE/modeling-worker-container"
    else
      printf '%s\\n' new-modeling-worker >"$OPENVAC_FAKE_STATE/modeling-worker-container"
    fi
    ;;
  *" rm --stop --force modeling-worker modeling-service "*)
    rm -f "$OPENVAC_FAKE_STATE/modeling-container"
    rm -f "$OPENVAC_FAKE_STATE/modeling-worker-container"
    ;;
  *) ;;
esac
exit 0
`;
}

describe("modeling deployment release set", () => {
  it("fails closed on runtime verification and restores a legacy web/worker release", () => {
    const fixture = createFixture();
    const webImage = `ghcr.io/example/openvac@sha256:${"a".repeat(64)}`;
    const modelingImage = `ghcr.io/example/openvac@sha256:${"b".repeat(64)}`;
    const result = spawnSync(
      "sh",
      [
        join(fixture.bundle, "deploy", "deploy.sh"),
        fixture.host,
        webImage,
        modelingImage,
        "openvac-production"
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fixture.fakeBin}:${process.env.PATH ?? ""}`,
          OPENVAC_DEPLOY_TEST_ROOT: fixture.host,
          OPENVAC_FAKE_BACKUP: join(fixture.host, "backup.sql.gz"),
          OPENVAC_FAKE_DOCKER_LOG: fixture.log,
          OPENVAC_FAKE_STATE: fixture.state,
          OPENVAC_DEPLOY_TEST_MEMINFO: fixture.meminfo,
          OPENVAC_FAKE_RUNTIME_FAIL: "true"
        }
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Modeling runtime verification failed; rolling back the application release set"
    );
    expect(readFileSync(join(fixture.host, "current-release"), "utf8")).toBe(
      `${fixture.previousRelease}\n`
    );

    const dockerLog = readFileSync(fixture.log, "utf8");
    expect(dockerLog).toContain(
      "pull web worker modeling-service modeling-worker"
    );
    expect(dockerLog).toContain(
      "run --rm --no-deps modeling-worker pnpm modeling:verify-runtime"
    );
    expect(dockerLog).toContain(
      "rm --stop --force modeling-worker modeling-service"
    );
    expect(dockerLog).toContain(
      "web=sha256:old-application modeling=" +
        `${modelingImage} enabled=false args=compose --project-name openvac-production`
    );

    const composeCalls = dockerLog
      .split("\n")
      .filter((line) => line.includes(" args=compose "));
    expect(composeCalls.length).toBeGreaterThan(0);
    for (const call of composeCalls) {
      expect(call).toContain(" --profile modeling ");
    }
  }, 15_000);

  it("restores both previous images when the new modeling worker is unhealthy", () => {
    const fixture = createFixture({ hasModeling: true });
    const webImage = `ghcr.io/example/openvac@sha256:${"a".repeat(64)}`;
    const modelingImage = `ghcr.io/example/openvac@sha256:${"b".repeat(64)}`;
    const result = spawnSync(
      "sh",
      [
        join(fixture.bundle, "deploy", "deploy.sh"),
        fixture.host,
        webImage,
        modelingImage,
        "openvac-production"
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fixture.fakeBin}:${process.env.PATH ?? ""}`,
          OPENVAC_DEPLOY_TEST_ROOT: fixture.host,
          OPENVAC_FAKE_BACKUP: join(fixture.host, "backup.sql.gz"),
          OPENVAC_FAKE_DOCKER_LOG: fixture.log,
          OPENVAC_FAKE_STATE: fixture.state,
          OPENVAC_DEPLOY_TEST_MEMINFO: fixture.meminfo
        }
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Modeling worker readiness check failed; rolling back the application release set"
    );
    expect(result.stderr).toContain(
      "Rollback healthy on previous application image sha256:old-application"
    );

    const dockerLog = readFileSync(fixture.log, "utf8");
    expect(dockerLog).toContain(
      "web=sha256:old-application modeling=sha256:old-modeling enabled=false args=compose"
    );
    expect(dockerLog).toContain("up -d --no-deps modeling-service");
    expect(dockerLog).toContain("up -d --no-deps web worker");
    expect(dockerLog).toContain("up -d --no-deps modeling-worker");
    expect(readFileSync(join(fixture.host, "current-release"), "utf8")).toBe(
      `${fixture.previousRelease}\n`
    );
  }, 15_000);

  it("fails closed before Docker when CPU or memory evidence is insufficient", () => {
    const webImage = `ghcr.io/example/openvac@sha256:${"a".repeat(64)}`;
    const modelingImage = `ghcr.io/example/openvac@sha256:${"b".repeat(64)}`;
    const cpuFixture = createFixture();
    const cpuResult = spawnSync(
      "sh",
      [
        join(cpuFixture.bundle, "deploy", "deploy.sh"),
        cpuFixture.host,
        webImage,
        modelingImage,
        "openvac-production"
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${cpuFixture.fakeBin}:${process.env.PATH ?? ""}`,
          OPENVAC_DEPLOY_TEST_ROOT: cpuFixture.host,
          OPENVAC_DEPLOY_TEST_MEMINFO: cpuFixture.meminfo,
          OPENVAC_FAKE_CPU_COUNT: "1",
          OPENVAC_FAKE_BACKUP: join(cpuFixture.host, "backup.sql.gz"),
          OPENVAC_FAKE_DOCKER_LOG: cpuFixture.log,
          OPENVAC_FAKE_STATE: cpuFixture.state
        }
      }
    );
    expect(cpuResult.status).toBe(1);
    expect(cpuResult.stderr).toContain("at least 2 logical CPUs");
    expect(() => readFileSync(cpuFixture.log, "utf8")).toThrow();

    const memoryFixture = createFixture();
    write(memoryFixture.meminfo, "MemTotal:        3799999 kB\n");
    const memoryResult = spawnSync(
      "sh",
      [
        join(memoryFixture.bundle, "deploy", "deploy.sh"),
        memoryFixture.host,
        webImage,
        modelingImage,
        "openvac-production"
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${memoryFixture.fakeBin}:${process.env.PATH ?? ""}`,
          OPENVAC_DEPLOY_TEST_ROOT: memoryFixture.host,
          OPENVAC_DEPLOY_TEST_MEMINFO: memoryFixture.meminfo,
          OPENVAC_FAKE_BACKUP: join(memoryFixture.host, "backup.sql.gz"),
          OPENVAC_FAKE_DOCKER_LOG: memoryFixture.log,
          OPENVAC_FAKE_STATE: memoryFixture.state
        }
      }
    );
    expect(memoryResult.status).toBe(1);
    expect(memoryResult.stderr).toContain("requires a nominal 4 GB host");
    expect(() => readFileSync(memoryFixture.log, "utf8")).toThrow();

    const diskFixture = createFixture();
    const diskResult = spawnSync(
      "sh",
      [
        join(diskFixture.bundle, "deploy", "deploy.sh"),
        diskFixture.host,
        webImage,
        modelingImage,
        "openvac-production"
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${diskFixture.fakeBin}:${process.env.PATH ?? ""}`,
          OPENVAC_DEPLOY_TEST_ROOT: diskFixture.host,
          OPENVAC_DEPLOY_TEST_MEMINFO: diskFixture.meminfo,
          OPENVAC_FAKE_AVAILABLE_KB: "31457279",
          OPENVAC_FAKE_BACKUP: join(diskFixture.host, "backup.sql.gz"),
          OPENVAC_FAKE_DOCKER_LOG: diskFixture.log,
          OPENVAC_FAKE_STATE: diskFixture.state
        }
      }
    );
    expect(diskResult.status).toBe(1);
    expect(diskResult.stderr).toContain("at least 30 GiB free");
    expect(() => readFileSync(diskFixture.log, "utf8")).toThrow();
  });
});
