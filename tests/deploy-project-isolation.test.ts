import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("web-only deployment and R0 rollback compatibility", () => {
  const release = source(".github/workflows/release.yml");
  const offline = source(".github/workflows/offline-image.yml");
  const compose = source("docker-compose.yml");
  const deploy = source("deploy/deploy.sh");
  const activation = source("deploy/activate-bundle.sh");
  const dockerfile = source("Dockerfile");
  const dockerignore = source(".dockerignore");
  const ci = source(".github/workflows/ci.yml");

  it("maps production and staging to distinct explicit Compose projects", () => {
    expect(release).toContain("compose_project=openvac-production");
    expect(release).toContain("compose_project=openvac-staging");
    expect(deploy).toContain("/opt/openvac:openvac-production");
    expect(deploy).toContain("/opt/openvac-staging:openvac-staging");
    expect(deploy).toContain('--project-name "$compose_project"');
  });

  it("builds and deploys one immutable web image", () => {
    expect(release).toContain(
      "web_digest: ${{ steps.select_image.outputs.digest }}"
    );
    expect(release).toContain(
      "WEB_IMAGE_DIGEST: ${{ needs.image.outputs.web_digest }}"
    );
    expect(release).toContain("openvac-web-release.tar.zst");
    expect(release).toContain("openvac-web-release.digest");
    expect(release).toContain(
      'if [ "$packaged_digest" != "$WEB_IMAGE_DIGEST" ]; then'
    );
    expect(release).toContain(
      'cp "$archive_digest" "$bundle_root/WEB_IMAGE_DIGEST"'
    );
    expect(release).toContain(
      '"$image_repository:archive-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" "$WEB_IMAGE_DIGEST" <<\'REMOTE_PREPARE\''
    );
    expect(release).toContain('expected_registry_digest="$4"');
    expect(release).toContain(
      'if [ "$packaged_registry_digest" != "$expected_registry_digest" ]; then'
    );
    expect(release).not.toContain("modeling_digest");
    expect(release).not.toContain("MODELING_IMAGE_DIGEST");
    expect(release).not.toContain("MODELING_SERVICE_TOKEN");
  });

  it("builds once for staging with production settings and never rebuilds for production", () => {
    expect(release.match(/uses: docker\/build-push-action@/g)).toHaveLength(1);
    expect(
      release.match(/build-args: OPENVAC_DEPLOY_TARGET=production/g)
    ).toHaveLength(1);
    expect(release).toContain("if: inputs.target == 'staging'");
    expect(release).toContain(
      'production) selected_digest="$STAGING_WEB_DIGEST" ;;'
    );
    expect(release).toContain(
      'docker pull --platform linux/amd64 "$registry_image"'
    );
    expect(release).toContain(
      "org.opencontainers.image.revision=${{ inputs.commit_sha }}"
    );
    expect(release).not.toContain(
      "build-args: OPENVAC_DEPLOY_TARGET=${{ inputs.target }}"
    );
  });

  it("requires successful staging provenance for the exact production digest", () => {
    expect(release).toContain("staging_web_digest:");
    expect(release).toContain(
      "Production requires staging_web_digest in sha256:<64 lowercase hex> form."
    );
    expect(release).toContain(
      "openvac-staging-provenance-$RELEASE_SHA-$staging_digest_hex"
    );
    expect(release).toContain('.path == ".github/workflows/release.yml"');
    expect(release).toContain(
      "Accepted staging digest provenance: $STAGING_WEB_DIGEST"
    );
    expect(release).toContain("Save accepted staging digest provenance");
  });

  it("checks Docker context inputs required by the SemaCAD production gate", () => {
    expect(dockerfile).toContain("FROM scratch AS semacad-context-check");
    expect(dockerfile).toContain(
      "COPY public/semacad/semacad-app-icon.png /semacad-app-icon.png"
    );
    expect(dockerignore).toContain("!public/semacad/semacad-app-icon.png");
    expect(dockerignore).toContain("!public/semacad/semacad-main-window.png");
    expect(ci).toContain("--target semacad-context-check");
  });

  it("ships a checksum-verified, secret-free deployment bundle", () => {
    expect(release).toContain("DEPLOY_BUNDLE.sha256");
    expect(release).toContain("sha256sum --check DEPLOY_BUNDLE.sha256");
    expect(release).toContain(
      "sha256sum --check openvac-web-release.tar.zst.sha256 >&2"
    );
    expect(release).toContain(
      "sha256sum --check openvac-deploy-bundle.tar.gz.sha256 >&2"
    );
    expect(release).toContain(
      "(cd bundle && sha256sum --check DEPLOY_BUNDLE.sha256 >&2)"
    );
    expect(release).toContain("ref: ${{ inputs.commit_sha }}");
    expect(activation).toContain("bundle must not contain environment files");
    expect(activation).toContain("current-release");
    expect(activation).not.toContain("MODELING_IMAGE");
  });

  it("keeps the active Compose runtime web-only", () => {
    expect(compose).toContain("  web:");
    expect(compose).toContain("  worker:");
    expect(compose).not.toContain("modeling-service:");
    expect(compose).not.toContain("modeling-worker:");
    expect(compose).not.toContain("MODELING_");
  });

  it("exports only web and pgvector offline artifacts", () => {
    expect(offline).toContain("openvac-image.tar.zst");
    expect(offline).toContain("openvac-postgres-pgvector.tar.zst");
    expect(offline).not.toContain("modeling-service");
    expect(offline).not.toContain("openvac-modeling");
  });

  it("verifies preloaded web identity and runs model verification before migration", () => {
    expect(deploy).toContain('if [ -n "${OPENVAC_WEB_PRELOADED_ID:-}" ]');
    expect(deploy).toContain(
      '[ "$verified_web_id" != "$OPENVAC_WEB_PRELOADED_ID" ]'
    );
    expect(deploy).toContain('"org.opencontainers.image.revision"');
    expect(deploy).toContain('[ "$verified_revision" = "$target_release_id" ]');
    expect(deploy.indexOf("pnpm model:verify")).toBeLessThan(
      deploy.indexOf("release_compose run --rm migrate")
    );
  });

  it("serializes host activation and journals runtime mutation", () => {
    expect(activation).toContain(
      'activation_lock_dir="$deploy_dir/.activation-lock"'
    );
    expect(activation).toContain(
      'fail "another deployment activation is already in progress"'
    );
    expect(deploy).toContain(
      'transaction_journal_file="$deploy_dir/deployment-transaction"'
    );
    expect(deploy).toContain("begin_transaction_journal");
    expect(deploy).toContain("clear_transaction_journal");
    expect(deploy).toContain('"status=in-progress"');
    expect(deploy).toContain('"rollback_rehearsal=$rehearsal_status"');
    expect(activation).toContain("deployment-receipt");
  });

  it("stops but does not delete the legacy modeling runtime after web health", () => {
    const healthIndex = deploy.indexOf("wait_for_web_health || return 1");
    const stopIndex = deploy.indexOf(
      "stop -t 30 modeling-worker modeling-service"
    );
    expect(healthIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeGreaterThan(healthIndex);
    expect(deploy).not.toContain(
      "rm --stop --force modeling-worker modeling-service"
    );
  });

  it("can restore the complete previous release set on an R1 failure", () => {
    expect(deploy).toContain(
      'old_modeling_image="$(container_image "$old_modeling_container")"'
    );
    expect(deploy).toContain(
      'run_legacy_compose "$previous_compose_file" up -d --no-deps modeling-service'
    );
    expect(deploy).toContain(
      'run_legacy_compose "$previous_compose_file" up -d --no-deps modeling-worker'
    );
    expect(deploy).toContain(
      'run_legacy_compose "$previous_compose_file" up -d --no-deps web worker'
    );
  });

  it("removes the old runtime configurator and rejects truncated digests", () => {
    expect(existsSync("deploy/configure-modeling-runtime.sh")).toBe(false);
    expect(deploy).toContain('[ "${#image_digest}" -eq 64 ]');
    expect(activation).toContain('[ "${#image_digest}" -eq 64 ]');
  });

  it("retains exact-SHA CI and production staging gates", () => {
    expect(release).toContain(
      "commit_sha must be a lowercase hexadecimal commit SHA"
    );
    expect(release).toContain(
      "The latest same-SHA staging deployment status is success."
    );
    expect(release).toContain(
      "Production environment has required reviewers and a branch policy."
    );
  });

  it("uses public environment URLs while activation accepts loopback health", () => {
    expect(release).toContain("https://openvac.cn/api/health");
    expect(release).toContain("https://staging-openvac.openvac.cn/api/health");
    expect(activation).toContain("https://*|http://127.0.0.1:*");
  });
});
