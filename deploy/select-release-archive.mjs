import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ARCHIVE_PREFIX = "openvac-web-release";

export function selectReleaseArchiveName(payload, input) {
  const runId = positiveInteger(input.runId, "run id");
  const runAttempt = positiveInteger(input.runAttempt, "run attempt");
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray(payload.artifacts)
  ) {
    throw new Error("Artifact response is malformed.");
  }

  const prefix = `${ARCHIVE_PREFIX}-${runId}-`;
  const candidates = new Map();
  for (const artifact of payload.artifacts) {
    if (
      !artifact ||
      typeof artifact !== "object" ||
      artifact.expired !== false ||
      artifact.workflow_run?.id !== runId ||
      typeof artifact.name !== "string" ||
      !artifact.name.startsWith(prefix)
    ) {
      continue;
    }

    const attempt = positiveInteger(
      artifact.name.slice(prefix.length),
      "archive attempt"
    );
    if (attempt > runAttempt) continue;
    if (candidates.has(attempt)) {
      throw new Error("Release archive selection is ambiguous.");
    }
    candidates.set(attempt, artifact.name);
  }

  const selectedAttempt = Math.max(...candidates.keys());
  const selected = candidates.get(selectedAttempt);
  if (!selected) {
    throw new Error("No usable same-run release archive was found.");
  }
  return selected;
}

function positiveInteger(value, label) {
  const raw = String(value ?? "");
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new Error(`${label} must be a positive decimal integer.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} is outside the supported range.`);
  }
  return parsed;
}

function main() {
  const [artifactPath, runId, runAttempt, ...extra] = process.argv.slice(2);
  if (!artifactPath || !runId || !runAttempt || extra.length > 0) {
    throw new Error(
      "Usage: select-release-archive.mjs <artifacts.json> <run-id> <run-attempt>"
    );
  }
  const payload = JSON.parse(readFileSync(artifactPath, "utf8"));
  process.stdout.write(
    `${selectReleaseArchiveName(payload, { runId, runAttempt })}\n`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    process.stderr.write(`Release archive selection failed: ${message}\n`);
    process.exitCode = 1;
  }
}
