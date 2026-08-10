import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { renderVisualNonce } from "../scripts/qwen-vl-fixtures";

describe("Qwen-VL visual fixtures", () => {
  it("ships fixed benchmark PNGs that match their manifest", async () => {
    const directory = join(
      process.cwd(),
      "scripts",
      "fixtures",
      "qwen-vl-fixed"
    );
    const manifest = JSON.parse(
      await readFile(join(directory, "manifest.json"), "utf8")
    ) as {
      schemaVersion: string;
      assets: Array<{
        file: string;
        height: number;
        sha256: string;
        sourceSha256: string;
        width: number;
      }>;
    };
    expect(manifest.schemaVersion).toBe("openvac.qwen-vl-fixed-fixtures.v1");
    expect(manifest.assets).toHaveLength(4);
    for (const asset of manifest.assets) {
      expect(asset.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
      const bytes = await readFile(join(directory, asset.file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        asset.sha256
      );
      const metadata = await sharp(bytes).metadata();
      expect(metadata).toMatchObject({
        width: asset.width,
        height: asset.height,
        channels: 3,
        hasAlpha: false,
        format: "png"
      });
    }
  });

  it("renders the visual nonce on a fully opaque white canvas", async () => {
    const image = await renderVisualNonce("73194625");
    const metadata = await sharp(image).metadata();
    expect(metadata).toMatchObject({
      width: 1040,
      height: 540,
      channels: 3,
      hasAlpha: false,
      format: "png"
    });

    const { data, info } = await sharp(image)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)]).toEqual([255, 255, 255]);
    const finalPixel = (info.width * info.height - 1) * info.channels;
    expect([...data.subarray(finalPixel, finalPixel + 3)]).toEqual([
      255, 255, 255
    ]);
    let nonWhitePixels = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      if (
        data[offset] < 245 ||
        data[offset + 1] < 245 ||
        data[offset + 2] < 245
      ) {
        nonWhitePixels += 1;
      }
    }
    expect(nonWhitePixels).toBeGreaterThan(20_000);
  });

  it("rejects a malformed visual nonce before rendering", async () => {
    await expect(renderVisualNonce("7319462")).rejects.toThrow(
      "exactly eight ASCII digits"
    );
  });
});
