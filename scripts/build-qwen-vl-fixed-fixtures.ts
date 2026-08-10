import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

const WIDTH = 1040;
const HEIGHT = 540;
const sourceDirectory = join(
  process.cwd(),
  "tests",
  "fixtures",
  "qwen-vl-fixed",
  "source"
);
const outputDirectory = join(
  process.cwd(),
  "scripts",
  "fixtures",
  "qwen-vl-fixed"
);

const svg = (body: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${body}</svg>`,
    "utf8"
  );

const assets = [
  {
    id: "device_identification",
    source: "device-identification-base.png",
    output: "device-identification.png",
    expected: { device: "turbomolecular pump", inlet: "dn100" },
    overlay: svg(
      `<rect x="35" y="395" width="515" height="112" rx="16" fill="#ffffff" fill-opacity="0.94" stroke="#0f172a" stroke-width="3"/><text x="62" y="438" font-family="DejaVu Sans, Arial, sans-serif" font-size="27" font-weight="700" fill="#0f172a">TURBOMOLECULAR PUMP</text><text x="62" y="480" font-family="DejaVu Sans, Arial, sans-serif" font-size="25" font-weight="600" fill="#1d4ed8">TOP INLET: DN100 ISO-K</text>`
    )
  },
  {
    id: "nameplate_ocr",
    source: "nameplate-base.png",
    output: "nameplate-ocr.png",
    expected: { model: "ovp-160", serial: "ov20260810", speed_l_s: 160 },
    overlay: svg(
      `<text x="520" y="150" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="36" font-weight="700" fill="#111827">OPENVAC VACUUM PUMP</text><line x1="260" y1="170" x2="780" y2="170" stroke="#334155" stroke-width="2"/><text x="265" y="225" font-family="DejaVu Sans Mono, monospace" font-size="31" font-weight="700" fill="#111827">MODEL     OVP-160</text><text x="265" y="285" font-family="DejaVu Sans Mono, monospace" font-size="31" font-weight="700" fill="#111827">SERIAL    OV20260810</text><text x="265" y="345" font-family="DejaVu Sans Mono, monospace" font-size="31" font-weight="700" fill="#111827">SPEED     160 L/s</text>`
    )
  },
  {
    id: "gauge_reading",
    source: "gauge-base.png",
    output: "gauge-reading.png",
    expected: { reading: 0.0025, unit: "pa" },
    overlay: svg(
      `<text x="520" y="145" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="28" font-weight="700" fill="#111827">VACUUM</text><line x1="520" y1="286" x2="404" y2="176" stroke="#dc2626" stroke-width="8" stroke-linecap="round"/><circle cx="520" cy="286" r="16" fill="#dc2626" stroke="#7f1d1d" stroke-width="4"/><rect x="390" y="337" width="260" height="60" rx="9" fill="#ffffff" fill-opacity="0.92" stroke="#334155" stroke-width="2"/><text x="520" y="377" text-anchor="middle" font-family="DejaVu Sans Mono, monospace" font-size="31" font-weight="700" fill="#111827">2.50 E-3 Pa</text>`
    )
  },
  {
    id: "pump_curve",
    source: "pump-curve-base.png",
    output: "pump-curve.png",
    expected: { pressure_pa: 100, speed_l_s: 120, trend: "decreases" },
    overlay: svg(
      `<text x="88" y="38" font-family="DejaVu Sans, Arial, sans-serif" font-size="28" font-weight="700" fill="#0f172a">PUMPING SPEED CURVE</text><text x="790" y="526" font-family="DejaVu Sans, Arial, sans-serif" font-size="22" font-weight="600" fill="#0f172a">PRESSURE (Pa)</text><text x="72" y="78" font-family="DejaVu Sans, Arial, sans-serif" font-size="21" font-weight="600" fill="#0f172a">SPEED (L/s)</text><polyline points="125,142 310,166 520,224 750,326 930,416" fill="none" stroke="#2563eb" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="520" cy="224" r="12" fill="#dc2626" stroke="#ffffff" stroke-width="4"/><rect x="548" y="180" width="315" height="70" rx="10" fill="#ffffff" fill-opacity="0.94" stroke="#dc2626" stroke-width="2"/><text x="570" y="210" font-family="DejaVu Sans Mono, monospace" font-size="23" font-weight="700" fill="#111827">100 Pa = 120 L/s</text><text x="570" y="238" font-family="DejaVu Sans, Arial, sans-serif" font-size="20" font-weight="700" fill="#b91c1c">TREND: DECREASES</text><text x="505" y="520" font-family="DejaVu Sans Mono, monospace" font-size="18" fill="#0f172a">100</text><text x="74" y="230" font-family="DejaVu Sans Mono, monospace" font-size="18" fill="#0f172a">120</text>`
    )
  }
] as const;

await mkdir(outputDirectory, { recursive: true });
const manifestAssets: Array<Record<string, unknown>> = [];
for (const asset of assets) {
  const sourcePath = join(sourceDirectory, asset.source);
  const sourceBytes = await readFile(sourcePath);
  const metadata = await sharp(sourcePath).metadata();
  if (metadata.width !== WIDTH || metadata.height !== HEIGHT) {
    throw new Error(`${asset.source} must be ${WIDTH}x${HEIGHT}.`);
  }
  const outputPath = join(outputDirectory, asset.output);
  const composed = await sharp(sourcePath)
    .composite([{ input: asset.overlay, left: 0, top: 0 }])
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  await sharp(composed)
    .flatten({ background: "#ffffff" })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(outputPath);
  const bytes = await readFile(outputPath);
  manifestAssets.push({
    id: asset.id,
    file: asset.output,
    sourceFile: asset.source,
    sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    width: WIDTH,
    height: HEIGHT,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    expected: asset.expected
  });
}

await writeFile(
  join(outputDirectory, "manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: "openvac.qwen-vl-fixed-fixtures.v1",
      baseGenerator: "openai-image-gen",
      exactOverlay: "sharp-svg",
      assets: manifestAssets
    },
    null,
    2
  )}\n`,
  "utf8"
);
