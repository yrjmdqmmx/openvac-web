import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const cleanupScriptPath = join(
  process.cwd(),
  "deploy",
  "cleanup-problem-reports.sh"
);

describe("problem-report retention operations", () => {
  it("rejects every target except the two fixed deployment contexts", () => {
    const result = spawnSync("bash", [cleanupScriptPath, "preview"], {
      encoding: "utf8"
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("target must be production or staging");

    const script = source("deploy/cleanup-problem-reports.sh");
    expect(script).toContain("deploy_dir=/opt/openvac");
    expect(script).toContain("compose_project=openvac-production");
    expect(script).toContain("deploy_dir=/opt/openvac-staging");
    expect(script).toContain("compose_project=openvac-staging");
  });

  it("resolves only a validated immutable active release", () => {
    const script = source("deploy/cleanup-problem-reports.sh");

    expect(script).toContain('! -L "$deploy_dir"');
    expect(script).toContain('! -L "$env_file"');
    expect(script).toContain('! -L "$releases_dir"');
    expect(script).toContain('! -L "$current_release_file"');
    expect(script).toContain('! -L "$release_dir"');
    expect(script).toContain('! -L "$compose_file"');
    expect(script).toContain("one 40-character SHA and a newline");
    expect(script).toContain("40-character commit SHA");
    expect(script).toContain("environment file must have mode 0600");
  });

  it("uses the explicit project, env file and active Compose file every time", () => {
    const script = source("deploy/cleanup-problem-reports.sh");

    expect(script).toContain('--project-name "$compose_project"');
    expect(script).toContain('--env-file "$env_file"');
    expect(script).toContain('-f "$compose_file"');
    expect(script).toContain("compose ps -q web");
    expect(script).toContain(
      "compose exec -T web pnpm problem-reports:cleanup"
    );
    expect(script).not.toContain('source "$env_file"');
    expect(script).not.toContain("set -x");
  });

  it("ships separate daily timer instances without loading secrets in systemd", () => {
    const service = source(
      "deploy/systemd/openvac-problem-report-cleanup@.service"
    );
    const timer = source(
      "deploy/systemd/openvac-problem-report-cleanup@.timer"
    );

    expect(service).toContain("cleanup-problem-reports.sh %i");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("ReadWritePaths=/run/docker.sock");
    expect(service).not.toContain("EnvironmentFile=");
    expect(timer).toContain("OnCalendar=*-*-* 05:00:00 Asia/Shanghai");
    expect(timer).toContain("Unit=openvac-problem-report-cleanup@%i.service");
    expect(timer).toContain("Persistent=true");
  });
});
