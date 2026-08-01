import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("deployment Compose project isolation", () => {
  it("keeps local Compose usable without a fixed production project name", () => {
    const compose = source("docker-compose.yml");

    expect(compose).not.toMatch(/^name:/m);
    expect(compose).not.toContain("COMPOSE_PROJECT_NAME");
  });

  it("maps production and staging to distinct explicit project names", () => {
    const release = source(".github/workflows/release.yml");
    const activation = source("deploy/activate-bundle.sh");
    const projects = [
      ...release.matchAll(/compose_project="(openvac-[^"]+)"/g)
    ].map((match) => match[1]);

    expect(projects).toEqual(["openvac-production", "openvac-staging"]);
    expect(new Set(projects).size).toBe(2);
    expect(activation).toContain('sh "$release_dir/deploy/deploy.sh"');
  });

  it("builds and deploys web and modeling images as distinct immutable digests", () => {
    const release = source(".github/workflows/release.yml");
    const activation = source("deploy/activate-bundle.sh");
    const deploy = source("deploy/deploy.sh");

    expect(release).toContain(
      "web_digest: ${{ steps.web_build.outputs.digest }}"
    );
    expect(release).toContain(
      "modeling_digest: ${{ steps.modeling_build.outputs.digest }}"
    );
    expect(release).toContain("context: ./modeling-service");
    expect(release).toContain(
      'image_repository="ghcr.io/${GITHUB_REPOSITORY,,}"'
    );
    expect(release).not.toContain('image_tag="$(printf');
    expect(release).toContain(
      'validate_release_image "$release_modeling_image" "Modeling image"'
    );
    expect(activation).toContain('if [ "$#" -ne 7 ]');
    expect(deploy).toContain('if [ "$#" -ne 4 ]');
    expect(activation).toContain("must have distinct digests");
    expect(deploy).toContain("must have distinct digests");
  });

  it("ships and verifies the current checkout as a secret-free deployment bundle", () => {
    const release = source(".github/workflows/release.yml");

    expect(release).toContain(
      'cp docker-compose.yml "$bundle_root/docker-compose.yml"'
    );
    expect(release).toContain('cp -R deploy "$bundle_root/deploy"');
    expect(release).toContain("DEPLOY_BUNDLE.sha256");
    expect(release).toContain("sha256sum --check bundle.tar.gz.sha256");
    expect(release).toContain("bundle/deploy/activate-bundle.sh");
    expect(release).not.toMatch(/\bcp\b[^\n]*\.env/);
    expect(release).not.toMatch(/\btar\b[^\n]*\.env/);
  });

  it("keeps modeling disabled by default and configures its token only over stdin", () => {
    const release = source(".github/workflows/release.yml");
    const configuration = source("deploy/configure-modeling-runtime.sh");

    expect(release).toMatch(
      /enable_modeling:\n[\s\S]*?type: boolean\n\s+default: false/
    );
    expect(release).toContain(
      "MODELING_SERVICE_TOKEN: ${{ secrets.MODELING_SERVICE_TOKEN }}"
    );
    expect(release).toContain(`printf '%s\\n' "$MODELING_SERVICE_TOKEN" |`);
    expect(release).not.toMatch(
      /configure-modeling-runtime\.sh[^\n]*MODELING_SERVICE_TOKEN/
    );
    expect(release).not.toMatch(/\bscp\b[^\n]*MODELING_SERVICE_TOKEN/);
    expect(configuration).toContain('if [ "$#" -ne 2 ]');
    expect(configuration).toContain("stat -c '%a' \"$env_file\"");
    expect(configuration).toContain('mv -f -- "$temporary_env" "$env_file"');
    expect(configuration).not.toContain("set -x");
  });

  it("requires the latest successful same-SHA staging deployment for production", () => {
    const release = source(".github/workflows/release.yml");

    expect(release).toContain("deployments: read");
    expect(release).toContain('--data-urlencode "environment=staging"');
    expect(release).toContain('--data-urlencode "sha=$RELEASE_SHA"');
    expect(release).toContain("sort_by(.id)");
    expect(release).toContain(".[-1].statuses_url // empty");
    expect(release).toContain("'sort_by(.id) | .[-1].state == \"success\"'");
  });

  it("benchmarks the full modeling suite before activation and preserves JSON evidence", () => {
    const release = source(".github/workflows/release.yml");
    const benchmark = release.indexOf("python -m app.benchmark --case all");
    const activation = release.indexOf("bundle/deploy/activate-bundle.sh");

    expect(release).toContain("benchmark_iterations=20");
    expect(release).toContain("benchmark_iterations=1");
    expect(release).toContain("run_with_heartbeat()");
    expect(release).toContain('operation_pid="$!"');
    expect(release).toContain('while kill -0 "$operation_pid"');
    expect(release).toContain('run_with_heartbeat "modeling image pull"');
    expect(release).toContain('run_with_heartbeat "modeling benchmark"');
    expect(benchmark).toBeGreaterThan(0);
    expect(activation).toBeGreaterThan(benchmark);
    expect(release).toContain('cat "$benchmark_file"');
    expect(release).toContain('>>"$GITHUB_STEP_SUMMARY"');
    expect(release).toContain("| Target | SHA | Iterations | Pass |");
    expect(release).toContain(
      "name: modeling-benchmark-${{ inputs.target }}-${{ inputs.commit_sha }}"
    );
    expect(release).toContain(".iterations == $iterations and .passed == true");
  });

  it("authenticates private GHCR pulls with an ephemeral config and stdin-only token", () => {
    const release = source(".github/workflows/release.yml");
    const authentication = source("deploy/authenticate-ghcr.sh");

    expect(release).toMatch(/deploy:\n[\s\S]*?packages: read/);
    expect(release).toContain('chmod 600 "$ghcr_token_file"');
    expect(release).toContain(
      'sh bundle/deploy/authenticate-ghcr.sh "$remote_stage" "$ghcr_username"'
    );
    expect(authentication).toContain(
      'DOCKER_CONFIG="$docker_config" docker login ghcr.io'
    );
    expect(authentication).toContain('--password-stdin <"$token_file"');
    expect(authentication).toContain('rm -f -- "$token_file"');
    expect(authentication).not.toContain("set -x");
    expect(authentication).not.toContain("$3");
  });

  it("enforces host compute floors and exports the offline modeling image", () => {
    const deploy = source("deploy/deploy.sh");
    const preflight = source("deploy/preflight-host.sh");
    const offline = source(".github/workflows/offline-image.yml");

    expect(deploy).toContain('sh "$preflight_script" "$deployment_target"');
    expect(preflight).toContain("getconf _NPROCESSORS_ONLN");
    expect(preflight).toContain("minimum_memory_kb=3800000");
    expect(preflight).toContain("minimum_available_kb=31457280");
    expect(offline).toContain("context: ./modeling-service");
    expect(offline).toContain(
      "outputs: type=docker,dest=${{ runner.temp }}/openvac-modeling-image.tar"
    );
    expect(offline).toContain("openvac-modeling-image.tar.zst.sha256");
    expect(offline).toContain("name: staging");
    expect(offline).toContain('sha256sum --check "$(basename "$checksum")"');
    expect(
      offline.indexOf('sha256sum --check "$(basename "$checksum")"')
    ).toBeLessThan(offline.indexOf('"$ECS_USER@$ECS_HOST" docker load'));
    expect(offline).toContain(
      "modeling_config_digest: ${{ steps.modeling_identity.outputs.config_digest }}"
    );
    expect(offline).toContain(
      'if [ "$loaded_id" != "$archive_config_digest" ]'
    );
    expect(offline).toContain('docker pull "$release_modeling_image"');
    expect(offline).toContain(
      'if [ "$resolved_id" != "$release_config_digest" ]'
    );
    expect(offline).toContain("- Service activation: not performed");
  });

  it("runs the same host preflight before benchmark and deployment pulls", () => {
    const release = source(".github/workflows/release.yml");
    const deploy = source("deploy/deploy.sh");
    const benchmarkStart = release.indexOf("REMOTE_BENCHMARK");
    const benchmarkPreflight = release.indexOf(
      'bundle/deploy/preflight-host.sh" "$target"',
      benchmarkStart
    );
    const benchmarkPull = release.indexOf(
      'docker pull "$release_modeling_image"',
      benchmarkStart
    );
    const deployPreflight = deploy.indexOf(
      'sh "$preflight_script" "$deployment_target"'
    );
    const deployPull = deploy.indexOf("release_compose pull web worker");

    expect(benchmarkPreflight).toBeGreaterThan(benchmarkStart);
    expect(benchmarkPull).toBeGreaterThan(benchmarkPreflight);
    expect(deployPreflight).toBeGreaterThan(0);
    expect(deployPull).toBeGreaterThan(deployPreflight);
  });

  it("deploys only default-branch-reachable commits with default-branch CI", () => {
    const release = source(".github/workflows/release.yml");

    expect(release).toContain("fetch-depth: 0");
    expect(release).toContain(
      'git merge-base --is-ancestor "$RELEASE_SHA" "$default_head"'
    );
    expect(release).toContain(
      'echo "commit_sha must be reachable from the current default branch history."'
    );
    expect(release).toContain(".head_branch == $default_branch");
    expect(release).not.toContain(
      '$target != "production" or .head_branch == $default_branch'
    );
  });

  it("passes the private OCR document-host allowlist into containers", () => {
    const compose = source("docker-compose.yml");

    expect(compose).toContain(
      "ALIBABA_OCR_ALLOWED_DOCUMENT_HOSTS: ${ALIBABA_OCR_ALLOWED_DOCUMENT_HOSTS:-}"
    );
  });

  it("preinstalls the pinned package manager in the offline runtime image", () => {
    const dockerfile = source("Dockerfile");

    expect(dockerfile).toContain("ARG PNPM_VERSION=10.28.2");
    expect(dockerfile).toContain('npm install --global "pnpm@${PNPM_VERSION}"');
    expect(dockerfile).toContain('test "$(pnpm --version)" = "$PNPM_VERSION"');
    expect(dockerfile).not.toContain("corepack enable");
  });

  it("statically traces the DirectMail SDK into the standalone runtime", () => {
    const directMailProvider = source("src/server/providers/directmail.ts");

    expect(directMailProvider).toContain('from "@alicloud/dm20151123"');
    expect(directMailProvider).not.toContain("loadOptionalModule");
  });

  it("keeps public environment URLs while health-checking loopback ports", () => {
    const compose = source("docker-compose.yml");
    const release = source(".github/workflows/release.yml");
    const productionNginx = source("deploy/nginx/openvac.conf");
    const stagingNginx = source("deploy/nginx/staging-openvac.conf");

    expect(compose).toContain(
      "ALIBABA_DIRECTMAIL_ACCESS_KEY_ID: ${ALIBABA_DIRECTMAIL_ACCESS_KEY_ID:-}"
    );
    expect(compose).toContain(
      "ALIBABA_DIRECTMAIL_ACCESS_KEY_SECRET: ${ALIBABA_DIRECTMAIL_ACCESS_KEY_SECRET:-}"
    );
    expect(compose).toContain("no-reply@mail.openvac.cn");
    expect(release).toContain("https://openvac.cn");
    expect(release).toContain("https://staging-openvac.openvac.cn");
    expect(release).toContain("http://127.0.0.1:3010/api/health");
    expect(release).toContain("http://127.0.0.1:3011/api/health");
    expect(productionNginx).toContain("server_name openvac.cn;");
    expect(stagingNginx).toContain("server_name staging-openvac.openvac.cn;");
    expect(
      `${compose}\n${release}\n${productionNginx}\n${stagingNginx}`
    ).not.toContain("yixingretail.cn");
  });

  it("keeps first-run staging secrets out of arguments and shell history", () => {
    const configureSecrets = source("deploy/configure-staging-secrets.sh");

    expect(configureSecrets).toContain("stty -echo");
    expect(configureSecrets).toContain('|\n  ssh "$ssh_target"');
    expect(configureSecrets).toContain("/opt/openvac-staging/.env");
    expect(configureSecrets).not.toContain("set -x");
    expect(configureSecrets).not.toMatch(/ssh[^\n]*\$deepseek_key/);
    expect(configureSecrets).not.toMatch(/ssh[^\n]*\$directmail_secret/);
  });

  it("rejects mismatched directory/project pairs before every Compose action", () => {
    const deploy = source("deploy/deploy.sh");

    expect(deploy).toContain('if [ "$#" -ne 4 ]');
    expect(deploy).toContain("/opt/openvac:openvac-production)");
    expect(deploy).toContain("/opt/openvac-staging:openvac-staging)");
    expect(deploy).toContain(
      "refusing mismatched deployment directory and Compose project"
    );

    expect(deploy.match(/docker compose/g)).toHaveLength(1);
    expect(deploy).toContain('--project-name "$compose_project"');
    expect(deploy).toContain('--env-file "$deploy_dir/.env"');
    expect(deploy).toContain('-f "$selected_compose_file"');
    expect(deploy).toContain("--profile modeling");
  });

  it("starts the authenticated modeling service before application workers", () => {
    const compose = source("docker-compose.yml");
    const deploy = source("deploy/deploy.sh");
    const modelingServiceStart = deploy.indexOf(
      "release_compose up -d --no-deps modeling-service"
    );
    const webWorkerStart = deploy.indexOf(
      "release_compose up -d --no-deps web worker"
    );
    const runtimeVerification = deploy.indexOf(
      "modeling-worker pnpm modeling:verify-runtime"
    );
    const modelingWorkerStart = deploy.indexOf(
      "release_compose up -d --no-deps modeling-worker"
    );

    expect(compose).toContain("http://127.0.0.1:8080/ready");
    expect(compose).toContain("x-openvac-service-token");
    expect(compose).not.toContain(
      "urllib.request.urlopen('http://127.0.0.1:8080/health'"
    );
    expect(modelingServiceStart).toBeGreaterThan(0);
    expect(runtimeVerification).toBeGreaterThan(modelingServiceStart);
    expect(webWorkerStart).toBeGreaterThan(runtimeVerification);
    expect(modelingWorkerStart).toBeGreaterThan(webWorkerStart);
  });

  it("rolls back the complete release set and removes new modeling containers for legacy releases", () => {
    const deploy = source("deploy/deploy.sh");

    expect(deploy).toContain('old_modeling_image="$(container_image');
    expect(deploy).toContain(
      'run_compose "$previous_compose_file" up -d --no-deps modeling-service'
    );
    expect(deploy).toContain(
      'run_compose "$previous_compose_file" up -d --no-deps modeling-worker'
    );
    expect(deploy).toContain(
      "release_compose rm --stop --force modeling-worker modeling-service"
    );
    expect(deploy).toContain("Previous modeling service restarted");
    expect(deploy).toContain("Previous modeling worker restarted");
  });

  it("verifies the exact provider model before running migrations", () => {
    const deploy = source("deploy/deploy.sh");
    const verification = deploy.indexOf("pnpm model:verify");
    const migration =
      deploy.indexOf("pnpm model:verify") < 0
        ? -1
        : deploy.indexOf("run --rm migrate");

    expect(verification).toBeGreaterThan(0);
    expect(migration).toBeGreaterThan(verification);
  });

  it("fails closed on truncated image digests and empty restore schemas", () => {
    const release = source(".github/workflows/release.yml");
    const deploy = source("deploy/deploy.sh");
    const restore = source("deploy/restore-drill.sh");

    expect(release).toContain("[0-9a-f]{64}");
    expect(deploy).toContain('[ "${#image_digest}" -eq 64 ]');
    expect(source("deploy/activate-bundle.sh")).toContain(
      '[ "${#image_digest}" -eq 64 ]'
    );
    expect(restore).toContain("restore drill produced an empty public schema");
    expect(restore).toContain("((restored_table_count > 0))");
  });

  it("rotates local backups only after a private OSS upload succeeds", () => {
    const orchestrator = source("deploy/backup-to-oss.sh");
    const upload = orchestrator.indexOf("upload-backup-oss.sh");
    const rotation = orchestrator.lastIndexOf("rotate-backups.sh");

    expect(orchestrator).toContain("set -Eeuo pipefail");
    expect(upload).toBeGreaterThan(0);
    expect(rotation).toBeGreaterThan(upload);
    expect(source("deploy/upload-backup-oss.sh")).toContain("--acl private");
  });
});
