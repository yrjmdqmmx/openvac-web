import { describe, expect, it } from "vitest";

import {
  assertSemacadProductionManifest,
  isSemacadDownloadReady,
  semacadRelease,
  semacadReleaseManifestSchema
} from "./semacad-release";

const verifiedPublicBeta = {
  status: "public-beta" as const,
  version: "0.2.0",
  build: "2026080605",
  assetName: "semaCAD-0.2.0-beta.1-macOS26-arm64.dmg",
  downloadUrl:
    "https://github.com/zdywrnm/SemaCAD/releases/download/v0.2.0-beta.1/semaCAD-0.2.0-beta.1-macOS26-arm64.dmg",
  releaseUrl: "https://github.com/zdywrnm/SemaCAD/releases/tag/v0.2.0-beta.1",
  sizeBytes: 1_742_524_586,
  sha256: "ab4fb2e669422a2fc9407fac1340c01e3a2cc02ae16e08ff7cb89936408fadfb",
  architecture: "arm64" as const,
  minimumMacOS: "26.0",
  notarized: true as const,
  publishedAt: "2026-08-06T16:10:24Z"
};

describe("SemaCAD release manifest", () => {
  it("publishes the verified public Beta manifest", () => {
    expect(semacadRelease).toEqual(verifiedPublicBeta);
    expect(isSemacadDownloadReady()).toBe(true);
    expect(assertSemacadProductionManifest()).toEqual(semacadRelease);
  });

  it("accepts a complete immutable public Beta release", () => {
    const release = semacadReleaseManifestSchema.parse(verifiedPublicBeta);

    expect(isSemacadDownloadReady(release)).toBe(true);
    expect(assertSemacadProductionManifest(release)).toEqual(release);
  });

  it("rejects the internal staging release", () => {
    expect(() =>
      semacadReleaseManifestSchema.parse({
        ...verifiedPublicBeta,
        downloadUrl:
          "https://github.com/zdywrnm/SemaCAD/releases/download/v0.2.0-beta.2-staging-2026080402/SemaCAD.dmg"
      })
    ).toThrow();
  });

  it.each([
    {
      assetName: "SemaCAD-0.2.0-beta.1-macOS26-arm64.dmg",
      downloadUrl:
        "https://github.com/zdywrnm/SemaCAD/releases/download/v0.2.0-beta.1/SemaCAD-0.2.0-beta.1-macOS26-arm64.dmg"
    },
    {
      releaseUrl: "https://github.com/zdywrnm/SemaCAD/releases/tag/v0.2.0",
      downloadUrl:
        "https://github.com/zdywrnm/SemaCAD/releases/download/v0.2.0/SemaCAD-0.2.0-public-beta-macOS26-arm64.dmg"
    },
    { minimumMacOS: "15.0" },
    { version: "0.2" }
  ])(
    "rejects a release outside the locked public Beta identity: %o",
    (override) => {
      expect(() =>
        semacadReleaseManifestSchema.parse({
          ...verifiedPublicBeta,
          ...override
        })
      ).toThrow();
    }
  );

  it.each([
    {
      downloadUrl:
        "https://github.com/zdywrnm/SemaCAD/releases/download/v0.2.0-beta.1/another-build.dmg"
    },
    {
      releaseUrl:
        "https://github.com/zdywrnm/SemaCAD/releases/tag/v0.2.0-beta.2"
    },
    {
      version: "9.9.9"
    }
  ])("rejects mismatched immutable release identity: %o", (override) => {
    expect(() =>
      semacadReleaseManifestSchema.parse({
        ...verifiedPublicBeta,
        ...override
      })
    ).toThrow();
  });

  it.each([
    { sha256: "abc" },
    { sizeBytes: 0 },
    { notarized: false },
    { downloadUrl: "https://github.com/zdywrnm/SemaCAD/releases/latest" }
  ])("rejects incomplete public release metadata: %o", (override) => {
    expect(() =>
      semacadReleaseManifestSchema.parse({
        ...verifiedPublicBeta,
        ...override
      })
    ).toThrow();
  });
});
