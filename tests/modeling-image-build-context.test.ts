import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const serviceRoot = join(process.cwd(), "modeling-service");

describe("modeling image build context", () => {
  it("ships only the benchmark fixture required by the production package", () => {
    const dockerignore = readFileSync(
      join(serviceRoot, ".dockerignore"),
      "utf8"
    )
      .split(/\r?\n/u)
      .filter(Boolean);
    const dockerfile = readFileSync(join(serviceRoot, "Dockerfile"), "utf8");

    expect(dockerignore).not.toContain("tests");
    expect(dockerignore).toEqual(
      expect.arrayContaining([
        "tests/*",
        "!tests/fixtures",
        "tests/fixtures/*",
        "!tests/fixtures/rotary_vane_pump_v1.json"
      ])
    );
    expect(dockerfile).toContain(
      "COPY tests/fixtures/rotary_vane_pump_v1.json ./tests/fixtures/rotary_vane_pump_v1.json"
    );
  });
});
