import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertSemacadProductionManifest,
  isSemacadDownloadReady,
  semacadRelease
} from "../src/lib/semacad-release";

if (process.argv.includes("--production")) {
  const verifiedRelease = assertSemacadProductionManifest(semacadRelease);

  const requiredAssets = ["public/semacad/semacad-app-icon.png"];
  if (isSemacadDownloadReady(verifiedRelease)) {
    requiredAssets.push("public/semacad/semacad-main-window.png");
  }

  for (const relativePath of requiredAssets) {
    const path = resolve(process.cwd(), relativePath);
    const stats = statSync(path);
    const pngHeader = readFileSync(path).subarray(0, 8).toString("hex");
    if (
      !stats.isFile() ||
      stats.size < 10_000 ||
      pngHeader !== "89504e470d0a1a0a"
    ) {
      throw new Error(`Production SemaCAD asset is invalid: ${relativePath}`);
    }
  }

  if (isSemacadDownloadReady(verifiedRelease)) {
    console.log(
      `Verified SemaCAD ${verifiedRelease.version} (${verifiedRelease.build}) production release manifest.`
    );
  } else {
    console.log(
      "Verified the SemaCAD preparing page for production; downloads remain disabled."
    );
  }
} else {
  console.log(`SemaCAD release status: ${semacadRelease.status}`);
}
