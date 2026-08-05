import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertSemacadProductionRelease,
  semacadRelease
} from "../src/lib/semacad-release";

if (process.argv.includes("--production")) {
  assertSemacadProductionRelease(semacadRelease);

  for (const relativePath of [
    "public/semacad/semacad-app-icon.png",
    "public/semacad/semacad-main-window.png"
  ]) {
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

  console.log(
    `Verified SemaCAD ${semacadRelease.version} (${semacadRelease.build}) production release manifest.`
  );
} else {
  console.log(`SemaCAD release status: ${semacadRelease.status}`);
}
