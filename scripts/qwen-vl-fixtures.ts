import sharp from "sharp";

const FIXTURE_WIDTH = 1040;
const FIXTURE_HEIGHT = 540;

export async function renderVisualFixture(body: string): Promise<Buffer> {
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${FIXTURE_WIDTH}" height="${FIXTURE_HEIGHT}">${body}</svg>`,
      "utf8"
    )
  )
    .flatten({ background: "#ffffff" })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
}

export async function renderVisualNonce(nonce: string): Promise<Buffer> {
  if (!/^\d{8}$/u.test(nonce)) {
    throw new Error("Visual nonce must contain exactly eight ASCII digits.");
  }
  return renderVisualFixture(
    `<rect width="${FIXTURE_WIDTH}" height="${FIXTURE_HEIGHT}" fill="#ffffff"/><text x="520" y="335" text-anchor="middle" font-family="DejaVu Sans Mono, monospace" font-size="190" font-weight="700" letter-spacing="8" fill="#000000">${nonce}</text>`
  );
}
