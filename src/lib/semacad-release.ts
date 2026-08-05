import { z } from "zod";

const baseReleaseSchema = z.object({
  version: z
    .string()
    .trim()
    .regex(/^\d+\.\d+\.\d+$/),
  build: z
    .string()
    .trim()
    .regex(/^\d{10}$/),
  architecture: z.literal("arm64"),
  minimumMacOS: z.literal("26.0")
});

const preparingReleaseSchema = baseReleaseSchema.extend({
  status: z.literal("preparing"),
  assetName: z.null(),
  downloadUrl: z.null(),
  releaseUrl: z.null(),
  sizeBytes: z.null(),
  sha256: z.null(),
  notarized: z.literal(false),
  publishedAt: z.null()
});

const immutableGithubDownloadUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      /^\/zdywrnm\/SemaCAD\/releases\/download\/[^/]+\/[^/]+$/.test(
        url.pathname
      ) &&
      !/(?:internal|staging)/i.test(url.pathname)
    );
  }, "downloadUrl must be an immutable public SemaCAD GitHub Release asset");

const publicBetaReleaseSchema = baseReleaseSchema.extend({
  status: z.literal("public-beta"),
  assetName: z
    .string()
    .trim()
    .min(1)
    .endsWith(".dmg")
    .startsWith("SemaCAD-")
    .refine((value) => !/(?:internal|staging)/i.test(value)),
  downloadUrl: immutableGithubDownloadUrl,
  releaseUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "github.com" &&
        /^\/zdywrnm\/SemaCAD\/releases\/tag\/[^/]+$/.test(url.pathname) &&
        !/(?:internal|staging)/i.test(url.pathname)
      );
    }, "releaseUrl must point to a public, immutable SemaCAD release tag"),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  notarized: z.literal(true),
  publishedAt: z.string().datetime({ offset: true })
});

export const semacadReleaseManifestSchema = z
  .discriminatedUnion("status", [
    preparingReleaseSchema,
    publicBetaReleaseSchema
  ])
  .superRefine((release, context) => {
    if (release.status !== "public-beta") return;

    const downloadParts = new URL(release.downloadUrl).pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const releaseParts = new URL(release.releaseUrl).pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const downloadTag = downloadParts[4];
    const downloadAssetName = downloadParts[5];
    const releaseTag = releaseParts[4];

    if (downloadAssetName !== release.assetName) {
      context.addIssue({
        code: "custom",
        path: ["downloadUrl"],
        message: "downloadUrl asset must exactly match assetName"
      });
    }
    if (downloadTag !== releaseTag) {
      context.addIssue({
        code: "custom",
        path: ["downloadUrl"],
        message: "downloadUrl and releaseUrl must use the same immutable tag"
      });
    }
    const betaTagPattern = new RegExp(
      `^v${release.version.replaceAll(".", "\\.")}-beta\\.\\d+$`
    );
    if (!downloadTag || !betaTagPattern.test(downloadTag)) {
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: "release tag must be the declared public Beta version"
      });
    }
  });

export type SemacadReleaseManifest = z.infer<
  typeof semacadReleaseManifestSchema
>;

/**
 * This manifest is deliberately checked into the website repository. It must
 * only be promoted to public-beta after the exact DMG has passed checksum,
 * Developer ID, notarization, staple and Gatekeeper verification.
 */
export const semacadRelease = semacadReleaseManifestSchema.parse({
  status: "preparing",
  version: "0.2.0",
  build: "2026080501",
  assetName: null,
  downloadUrl: null,
  releaseUrl: null,
  sizeBytes: null,
  sha256: null,
  architecture: "arm64",
  minimumMacOS: "26.0",
  notarized: false,
  publishedAt: null
} satisfies SemacadReleaseManifest);

export function isSemacadDownloadReady(
  release: SemacadReleaseManifest = semacadRelease
): release is Extract<SemacadReleaseManifest, { status: "public-beta" }> {
  return release.status === "public-beta";
}

export function assertSemacadProductionRelease(
  release: SemacadReleaseManifest = semacadRelease
): asserts release is Extract<
  SemacadReleaseManifest,
  { status: "public-beta" }
> {
  if (!isSemacadDownloadReady(release)) {
    throw new Error(
      "Production requires a verified public SemaCAD Beta release; the manifest is still preparing."
    );
  }
}
