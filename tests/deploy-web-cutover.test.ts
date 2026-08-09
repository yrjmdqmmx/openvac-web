import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

function write(path: string, value: string, mode = 0o600): void {
  writeFileSync(path, value, { encoding: "utf8", mode });
  chmodSync(path, mode);
}

function fakeDocker(): string {
  return `#!/bin/sh
set -eu
printf 'image=%s modeling=%s args=%s\n' "\${OPENVAC_IMAGE:-}" "\${OPENVAC_MODELING_IMAGE:-}" "$*" >>"$OPENVAC_FAKE_DOCKER_LOG"

if [ "$1" = image ] && [ "$2" = inspect ]; then
  format="$4"
  image="$5"
  case "$format" in
    *'.Id'*) printf '%s\n' 'sha256:${"a".repeat(64)}' ;;
    *org.opencontainers.image.revision*)
      case "$image" in
        sha256:old-application|sha256:old-modeling)
          printf '%s\n' "$OPENVAC_FAKE_PREVIOUS_RELEASE"
          ;;
        *) printf '%s\n' "$OPENVAC_FAKE_TARGET_RELEASE" ;;
      esac
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi

if [ "$1" = inspect ]; then
  format="$3"
  container="$4"
  case "$format:$container" in
    *Config.Env*:old-web) printf '%s\n' 'MODELING_ENABLED=false' ;;
    *Image*:old-web|*Image*:old-worker) printf '%s\n' 'sha256:old-application' ;;
    *Image*:old-modeling) printf '%s\n' 'sha256:old-modeling' ;;
    *Image*:old-modeling-worker) printf '%s\n' 'sha256:old-application' ;;
    *Image*:new-web|*Image*:new-worker) printf '%s\n' 'sha256:new-application' ;;
    *Health*:old-modeling) printf '%s\n' healthy ;;
    *State.Status*:old-worker|*State.Status*:new-worker|*State.Status*:old-modeling-worker)
      printf '%s\n' 'running false 0'
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi

case " $* " in
  *" exec -T postgres "*)
    printf '%s\n' "\${OPENVAC_FAKE_DRAIN_STATE:-0|0|0}"
    ;;
  *"/releases/"*"/docker-compose.yml"*" config --services "*)
    printf '%s\n' web worker modeling-service modeling-worker
    ;;
  *" config --services "*) printf '%s\n' web worker postgres migrate ;;
  *" ps -q web "*) [ ! -f "$OPENVAC_FAKE_STATE/web" ] || cat "$OPENVAC_FAKE_STATE/web" ;;
  *" ps -q worker "*) [ ! -f "$OPENVAC_FAKE_STATE/worker" ] || cat "$OPENVAC_FAKE_STATE/worker" ;;
  *" ps --all -q modeling-service "*) [ ! -f "$OPENVAC_FAKE_STATE/modeling" ] || cat "$OPENVAC_FAKE_STATE/modeling" ;;
  *" ps --all -q modeling-worker "*) [ ! -f "$OPENVAC_FAKE_STATE/modeling-worker" ] || cat "$OPENVAC_FAKE_STATE/modeling-worker" ;;
  *" ps -q modeling-service "*) [ ! -f "$OPENVAC_FAKE_STATE/modeling" ] || cat "$OPENVAC_FAKE_STATE/modeling" ;;
  *" ps -q modeling-worker "*) [ ! -f "$OPENVAC_FAKE_STATE/modeling-worker" ] || cat "$OPENVAC_FAKE_STATE/modeling-worker" ;;
  *" up -d --no-deps web worker "*)
    if [ "\${OPENVAC_IMAGE:-}" = sha256:old-application ]; then
      printf '%s\n' old-web >"$OPENVAC_FAKE_STATE/web"
      printf '%s\n' old-worker >"$OPENVAC_FAKE_STATE/worker"
    else
      printf '%s\n' new-web >"$OPENVAC_FAKE_STATE/web"
      printf '%s\n' new-worker >"$OPENVAC_FAKE_STATE/worker"
    fi
    ;;
  *" stop -t 30 worker web "*)
    rm -f "$OPENVAC_FAKE_STATE/web" "$OPENVAC_FAKE_STATE/worker"
    ;;
  *" stop -t 30 modeling-worker modeling-service "*)
    rm -f "$OPENVAC_FAKE_STATE/modeling" "$OPENVAC_FAKE_STATE/modeling-worker"
    ;;
  *" up -d --no-deps modeling-service "*)
    printf '%s\n' old-modeling >"$OPENVAC_FAKE_STATE/modeling"
    ;;
  *" up -d --no-deps modeling-worker "*)
    printf '%s\n' old-modeling-worker >"$OPENVAC_FAKE_STATE/modeling-worker"
    ;;
esac
exit 0
`;
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "openvac-web-cutover-"));
  temporaryRoots.push(root);
  const host = join(root, "host");
  const bundle = join(root, "bundle");
  const bundleDeploy = join(bundle, "deploy");
  const fakeBin = join(root, "bin");
  const state = join(root, "state");
  const dockerLog = join(root, "docker.log");
  const meminfo = join(root, "meminfo");
  const previousRelease = "c".repeat(40);
  const targetRelease = "d".repeat(40);
  const activationNonce = "1".repeat(32);

  mkdirSync(join(host, "releases", previousRelease), { recursive: true });
  mkdirSync(join(host, ".activation-lock"), { mode: 0o700 });
  mkdirSync(bundleDeploy, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(state, { recursive: true });
  write(join(host, ".env"), "DATABASE_URL=postgres://test\n");
  write(
    join(host, ".activation-lock", "owner"),
    `${targetRelease}-${activationNonce}\n`
  );
  write(join(host, "current-release"), `${previousRelease}\n`);
  write(
    join(host, "releases", previousRelease, "docker-compose.yml"),
    "services: {}\n"
  );
  write(join(bundle, "docker-compose.yml"), "services: {}\n");
  write(join(state, "web"), "old-web\n");
  write(join(state, "worker"), "old-worker\n");
  write(join(state, "modeling"), "old-modeling\n");
  write(join(state, "modeling-worker"), "old-modeling-worker\n");
  write(meminfo, "MemTotal:        8388608 kB\n");

  copyFileSync(deployScript, join(bundleDeploy, "deploy.sh"));
  chmodSync(join(bundleDeploy, "deploy.sh"), 0o700);
  copyFileSync(preflightScript, join(bundleDeploy, "preflight-host.sh"));
  chmodSync(join(bundleDeploy, "preflight-host.sh"), 0o700);
  write(
    join(bundleDeploy, "backup.sh"),
    [
      "#!/bin/sh",
      "set -eu",
      "printf '%s\\n' backup >>\"$OPENVAC_FAKE_DOCKER_LOG\"",
      '[ "${OPENVAC_FAKE_BACKUP_FAIL:-false}" != true ] || exit 1',
      "printf '%s\\n' \"$OPENVAC_FAKE_BACKUP\"",
      ""
    ].join("\n"),
    0o700
  );
  write(
    join(fakeBin, "df"),
    "#!/bin/sh\nprintf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' 'fake 100000000 1 99999999 1% /'\n",
    0o700
  );
  write(join(fakeBin, "getconf"), "#!/bin/sh\nprintf '%s\\n' 4\n", 0o700);
  write(join(fakeBin, "sleep"), "#!/bin/sh\nexit 0\n", 0o700);
  write(join(fakeBin, "curl"), "#!/bin/sh\nexit 0\n", 0o700);
  write(join(fakeBin, "sync"), "#!/bin/sh\nexit 0\n", 0o700);
  write(
    join(fakeBin, "stat"),
    "#!/bin/sh\ncase \"$2\" in %a) printf '%s\\n' 600 ;; %s) printf '%s\\n' 41 ;; *) exit 1 ;; esac\n",
    0o700
  );
  write(join(fakeBin, "docker"), fakeDocker(), 0o700);

  return {
    root,
    host,
    bundle,
    fakeBin,
    state,
    dockerLog,
    meminfo,
    previousRelease,
    targetRelease,
    activationNonce
  };
}

function runDeployment(
  fixture: ReturnType<typeof createFixture>,
  extraEnvironment: Record<string, string> = {}
) {
  const preloadedId = extraEnvironment.OPENVAC_WEB_PRELOADED_ID;
  const webImage = preloadedId
    ? `openvac-web-release:${preloadedId.replace(/^sha256:/, "")}`
    : `ghcr.io/example/openvac@sha256:${"a".repeat(64)}`;
  return spawnSync(
    "sh",
    [
      join(fixture.bundle, "deploy", "deploy.sh"),
      fixture.host,
      webImage,
      "openvac-production",
      fixture.targetRelease
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}:${process.env.PATH ?? ""}`,
        OPENVAC_DEPLOY_TEST_ROOT: fixture.host,
        OPENVAC_DEPLOY_TEST_MEMINFO: fixture.meminfo,
        OPENVAC_FAKE_BACKUP: join(fixture.host, "backup.sql.gz"),
        OPENVAC_FAKE_DOCKER_LOG: fixture.dockerLog,
        OPENVAC_FAKE_STATE: fixture.state,
        OPENVAC_FAKE_TARGET_RELEASE: fixture.targetRelease,
        OPENVAC_FAKE_PREVIOUS_RELEASE: fixture.previousRelease,
        OPENVAC_ACTIVATION_ID: `${fixture.targetRelease}-${fixture.activationNonce}`,
        ...extraEnvironment
      }
    }
  );
}

describe("transactional web-only R1 cutover", { timeout: 20_000 }, () => {
  it("migrates and activates a first install without draining or backing up a previous release", () => {
    const fixture = createFixture();
    rmSync(join(fixture.host, "current-release"));
    rmSync(join(fixture.state, "web"));
    rmSync(join(fixture.state, "worker"));
    rmSync(join(fixture.state, "modeling"));
    rmSync(join(fixture.state, "modeling-worker"));

    const result = runDeployment(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "No current release is recorded; treating this as a first deployment"
    );
    expect(readFileSync(join(fixture.host, "current-release"), "utf8")).toBe(
      `${fixture.targetRelease}\n`
    );
    expect(readFileSync(join(fixture.state, "web"), "utf8")).toBe("new-web\n");
    expect(readFileSync(join(fixture.state, "worker"), "utf8")).toBe(
      "new-worker\n"
    );
    expect(
      readFileSync(join(fixture.bundle, "deployment-receipt"), "utf8")
    ).toContain("rollback_rehearsal=not-required\n");

    const dockerLog = readFileSync(fixture.dockerLog, "utf8");
    expect(dockerLog).not.toContain("stop -t 30 worker web");
    expect(dockerLog).not.toContain("exec -T postgres");
    expect(dockerLog).not.toContain("backup");
    expect(dockerLog).toContain("run --rm migrate");
    expect(dockerLog.match(/up -d --no-deps web worker/g)).toHaveLength(1);
  });

  it("keeps an explicitly required rollback rehearsal fail-closed on a first install", () => {
    const fixture = createFixture();
    rmSync(join(fixture.host, "current-release"));
    rmSync(join(fixture.state, "web"));
    rmSync(join(fixture.state, "worker"));
    rmSync(join(fixture.state, "modeling"));
    rmSync(join(fixture.state, "modeling-worker"));

    const result = runDeployment(fixture, {
      OPENVAC_R1_ROLLBACK_REHEARSAL: "true"
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain(
      "the required previous-image rollback rehearsal has no managed web/worker release to restore"
    );
    const dockerLog = readFileSync(fixture.dockerLog, "utf8");
    expect(dockerLog).not.toContain("run --rm migrate");
    expect(dockerLog).not.toContain("up -d --no-deps web worker");
    expect(() =>
      readFileSync(join(fixture.host, "current-release"), "utf8")
    ).toThrow();
  });

  it("executes R1 -> R0 -> R1 before publishing the new release pointer", () => {
    const fixture = createFixture();
    const result = runDeployment(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "Running transactional R1 -> R0 -> R1 rollback rehearsal"
    );
    expect(result.stdout).toContain("R1 rollback rehearsal passed");
    expect(readFileSync(join(fixture.host, "current-release"), "utf8")).toBe(
      `${fixture.targetRelease}\n`
    );
    expect(readFileSync(join(fixture.state, "web"), "utf8")).toBe("new-web\n");
    expect(readFileSync(join(fixture.state, "worker"), "utf8")).toBe(
      "new-worker\n"
    );
    expect(readFileSync(join(fixture.bundle, "web-image-id"), "utf8")).toBe(
      `sha256:${"a".repeat(64)}\n`
    );
    expect(
      readFileSync(join(fixture.bundle, "deployment-receipt"), "utf8")
    ).toBe(
      [
        `release=${fixture.targetRelease}`,
        `web_image=sha256:${"a".repeat(64)}`,
        "migration=passed",
        "health=passed",
        "rollback_rehearsal=passed",
        "status=healthy",
        `activation=${fixture.targetRelease}-${fixture.activationNonce}`,
        ""
      ].join("\n")
    );
    expect(() =>
      readFileSync(join(fixture.host, "deployment-transaction"))
    ).toThrow();
    expect(() => readFileSync(join(fixture.state, "modeling"))).toThrow();
    expect(() =>
      readFileSync(join(fixture.state, "modeling-worker"))
    ).toThrow();

    const dockerLog = readFileSync(fixture.dockerLog, "utf8");
    const drainStop = dockerLog.indexOf("stop -t 30 worker web");
    const drainCheck = dockerLog.indexOf("exec -T postgres");
    const recoveryBackup = dockerLog.indexOf("backup");
    const migration = dockerLog.indexOf("run --rm migrate");
    const firstActivation = dockerLog.indexOf("up -d --no-deps web worker");
    expect(drainStop).toBeGreaterThan(-1);
    expect(drainCheck).toBeGreaterThan(drainStop);
    expect(recoveryBackup).toBeGreaterThan(drainCheck);
    expect(migration).toBeGreaterThan(recoveryBackup);
    expect(firstActivation).toBeGreaterThan(migration);
    const newActivations = dockerLog.match(
      /image=ghcr\.io\/example\/openvac@sha256:[a-f0-9]+ modeling= args=.*up -d --no-deps web worker/g
    );
    expect(newActivations).toHaveLength(2);
    expect(dockerLog).toContain(
      "image=sha256:old-application modeling=sha256:old-modeling args=compose"
    );
    expect(
      dockerLog.match(/stop -t 30 modeling-worker modeling-service/g)
    ).toHaveLength(2);
  });

  it("restores the previous web and worker when the migration drain is not empty", () => {
    const fixture = createFixture();
    const result = runDeployment(fixture, {
      OPENVAC_FAKE_DRAIN_STATE: "1|0|0",
      OPENVAC_R1_ROLLBACK_REHEARSAL: "false"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Agent V3 migration drain is not empty");
    expect(result.stderr).toContain(
      "Agent V3 migration drain failed; rolling back the previous application release set"
    );
    expect(readFileSync(join(fixture.host, "current-release"), "utf8")).toBe(
      `${fixture.previousRelease}\n`
    );
    expect(readFileSync(join(fixture.state, "web"), "utf8")).toBe("old-web\n");
    expect(readFileSync(join(fixture.state, "worker"), "utf8")).toBe(
      "old-worker\n"
    );
    expect(readFileSync(fixture.dockerLog, "utf8")).not.toContain(
      "run --rm migrate"
    );
  });

  it("restores the previous web and worker when the drained recovery backup fails", () => {
    const fixture = createFixture();
    const result = runDeployment(fixture, {
      OPENVAC_FAKE_BACKUP_FAIL: "true",
      OPENVAC_R1_ROLLBACK_REHEARSAL: "false"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Drained pre-migration recovery backup failed; rolling back the previous application release set"
    );
    expect(readFileSync(join(fixture.host, "current-release"), "utf8")).toBe(
      `${fixture.previousRelease}\n`
    );
    expect(readFileSync(join(fixture.state, "web"), "utf8")).toBe("old-web\n");
    expect(readFileSync(join(fixture.state, "worker"), "utf8")).toBe(
      "old-worker\n"
    );
    const dockerLog = readFileSync(fixture.dockerLog, "utf8");
    expect(dockerLog.indexOf("backup")).toBeGreaterThan(
      dockerLog.indexOf("exec -T postgres")
    );
    expect(dockerLog).not.toContain("run --rm migrate");
  });

  it("restores R0 and keeps its pointer when pointer publication fails", () => {
    const fixture = createFixture();
    const result = runDeployment(fixture, {
      OPENVAC_FORCE_POINTER_FAILURE: "true",
      OPENVAC_R1_ROLLBACK_REHEARSAL: "false"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Forced release pointer failure");
    expect(result.stderr).toContain(
      "Release pointer publication failed; rolling back the previous application release set"
    );
    expect(readFileSync(join(fixture.host, "current-release"), "utf8")).toBe(
      `${fixture.previousRelease}\n`
    );
    expect(readFileSync(join(fixture.state, "web"), "utf8")).toBe("old-web\n");
    expect(readFileSync(join(fixture.state, "worker"), "utf8")).toBe(
      "old-worker\n"
    );
    expect(readFileSync(join(fixture.state, "modeling"), "utf8")).toBe(
      "old-modeling\n"
    );
    expect(readFileSync(join(fixture.state, "modeling-worker"), "utf8")).toBe(
      "old-modeling-worker\n"
    );
    expect(
      readdirSync(fixture.host).filter((entry) =>
        entry.startsWith(".current-release-")
      )
    ).toEqual([]);
    expect(() =>
      readFileSync(join(fixture.host, "deployment-transaction"))
    ).toThrow();
    expect(() =>
      readFileSync(join(fixture.bundle, "deployment-receipt"))
    ).toThrow();
  });

  it("verifies the production preloaded image through the complete cutover", () => {
    const fixture = createFixture();
    const webImageId = `sha256:${"a".repeat(64)}`;
    const result = runDeployment(fixture, {
      OPENVAC_WEB_PRELOADED_ID: webImageId
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      `Verified web release ${webImageId} at revision ${fixture.targetRelease}`
    );
    expect(readFileSync(join(fixture.host, "current-release"), "utf8")).toBe(
      `${fixture.targetRelease}\n`
    );
    expect(readFileSync(join(fixture.bundle, "web-image-id"), "utf8")).toBe(
      `${webImageId}\n`
    );
    expect(readFileSync(fixture.dockerLog, "utf8")).not.toContain(
      " pull web worker"
    );
  });

  it("rejects a web image whose revision is not the target SHA", () => {
    const fixture = createFixture();
    const result = runDeployment(fixture, {
      OPENVAC_FAKE_TARGET_RELEASE: "b".repeat(40)
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "web release image revision does not match the target release SHA"
    );
    expect(readFileSync(join(fixture.host, "current-release"), "utf8")).toBe(
      `${fixture.previousRelease}\n`
    );
    expect(() => readFileSync(join(fixture.bundle, "web-image-id"))).toThrow();
  });

  it("rejects a running R0 image that drifted from current-release", () => {
    const fixture = createFixture();
    const result = runDeployment(fixture, {
      OPENVAC_FAKE_PREVIOUS_RELEASE: "b".repeat(40)
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain(
      "running web image revision does not match current-release"
    );
    expect(readFileSync(join(fixture.host, "current-release"), "utf8")).toBe(
      `${fixture.previousRelease}\n`
    );
  });

  it("does not skip the R0 rehearsal when legacy containers are stopped or missing", () => {
    const fixture = createFixture();
    rmSync(join(fixture.state, "modeling"));
    rmSync(join(fixture.state, "modeling-worker"));

    const result = runDeployment(fixture);

    expect(result.status).toBe(64);
    expect(result.stderr).toContain(
      "legacy modeling containers are missing or not one managed release set"
    );
    expect(readFileSync(join(fixture.host, "current-release"), "utf8")).toBe(
      `${fixture.previousRelease}\n`
    );
  });

  it("fails closed when an unresolved persistent transaction journal exists", () => {
    const fixture = createFixture();
    write(join(fixture.host, "deployment-transaction"), "status=in-progress\n");

    const result = runDeployment(fixture);

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("unresolved deployment transaction");
    expect(readFileSync(join(fixture.host, "current-release"), "utf8")).toBe(
      `${fixture.previousRelease}\n`
    );
  });

  it("retains the transaction journal when the committed pointer cannot be synced", () => {
    const fixture = createFixture();
    write(
      join(fixture.fakeBin, "sync"),
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

    const result = runDeployment(fixture, {
      OPENVAC_R1_ROLLBACK_REHEARSAL: "false"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "current-release was written but could not be durably synced"
    );
    expect(readFileSync(join(fixture.host, "current-release"), "utf8")).toBe(
      `${fixture.targetRelease}\n`
    );
    expect(readFileSync(join(fixture.state, "web"), "utf8")).toBe("new-web\n");
    expect(
      readFileSync(join(fixture.host, "deployment-transaction"), "utf8")
    ).toContain(
      `activation=${fixture.targetRelease}-${fixture.activationNonce}`
    );
  });
});
