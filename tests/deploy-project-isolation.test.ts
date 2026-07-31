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

  it("ships and verifies the current checkout as a secret-free deployment bundle", () => {
    const release = source(".github/workflows/release.yml");

    expect(release).toContain(
      'cp docker-compose.yml "$bundle_root/docker-compose.yml"'
    );
    expect(release).toContain('cp -R deploy "$bundle_root/deploy"');
    expect(release).toContain("DEPLOY_BUNDLE.sha256");
    expect(release).toContain("sha256sum --check bundle.tar.gz.sha256");
    expect(release).toContain("sh bundle/deploy/activate-bundle.sh");
    expect(release).not.toMatch(/\bcp\b[^\n]*\.env/);
    expect(release).not.toMatch(/\btar\b[^\n]*\.env/);
  });

  it("passes the private OCR document-host allowlist into containers", () => {
    const compose = source("docker-compose.yml");

    expect(compose).toContain(
      "ALIBABA_OCR_ALLOWED_DOCUMENT_HOSTS: ${ALIBABA_OCR_ALLOWED_DOCUMENT_HOSTS:-}"
    );
  });

  it("targets the OpenVac domains and verified DirectMail sender", () => {
    const compose = source("docker-compose.yml");
    const release = source(".github/workflows/release.yml");
    const productionNginx = source("deploy/nginx/openvac.conf");
    const stagingNginx = source("deploy/nginx/staging-openvac.conf");

    expect(compose).toContain("no-reply@mail.openvac.cn");
    expect(release).toContain("https://openvac.cn/api/health");
    expect(release).toContain("https://staging-openvac.openvac.cn/api/health");
    expect(productionNginx).toContain("server_name openvac.cn;");
    expect(stagingNginx).toContain("server_name staging-openvac.openvac.cn;");
    expect(
      `${compose}\n${release}\n${productionNginx}\n${stagingNginx}`
    ).not.toContain("yixingretail.cn");
  });

  it("rejects mismatched directory/project pairs before every Compose action", () => {
    const deploy = source("deploy/deploy.sh");

    expect(deploy).toContain('if [ "$#" -ne 3 ]');
    expect(deploy).toContain("/opt/openvac:openvac-production)");
    expect(deploy).toContain("/opt/openvac-staging:openvac-staging)");
    expect(deploy).toContain(
      "refusing mismatched deployment directory and Compose project"
    );

    const composeCommands = deploy
      .split("\n")
      .filter((line) => line.includes("docker compose"));

    expect(composeCommands).toHaveLength(5);
    for (const command of composeCommands) {
      expect(command).toContain('--project-name "$compose_project"');
      expect(command).toContain('--env-file "$deploy_dir/.env"');
      expect(command).toContain('-f "$compose_file"');
    }
  });
});
