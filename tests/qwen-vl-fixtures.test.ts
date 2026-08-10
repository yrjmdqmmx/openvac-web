import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { renderVisualNonce } from "../scripts/qwen-vl-fixtures";

describe("Qwen-VL visual fixtures", () => {
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
  });

  it("rejects a malformed visual nonce before rendering", async () => {
    await expect(renderVisualNonce("7319462")).rejects.toThrow(
      "exactly eight ASCII digits"
    );
  });
});
