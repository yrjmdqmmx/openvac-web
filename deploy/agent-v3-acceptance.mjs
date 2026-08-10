#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const command = process.argv[2];
const options = parseOptions(process.argv.slice(3));

if (command === "create") {
  await createAcceptance(options);
} else if (command === "verify") {
  await verifyAcceptance(options);
} else {
  fail("usage: agent-v3-acceptance.mjs create|verify --acceptance FILE ...");
}

async function createAcceptance(input) {
  const commitSha = exact(input.commit, /^[0-9a-f]{40}$/u, "commit SHA");
  const imageDigest = exact(
    input.digest,
    /^sha256:[0-9a-f]{64}$/u,
    "image digest"
  );
  const workflowRunId = exact(
    input["run-id"],
    /^[1-9][0-9]*$/u,
    "workflow run ID"
  );
  const workflowRunAttempt = exact(
    input["run-attempt"],
    /^[1-9][0-9]*$/u,
    "workflow run attempt"
  );
  const acceptancePath = requiredPath(input.acceptance, "acceptance output");
  const receiptPath = requiredPath(input.receipt, "deployment receipt");
  const runtimePath = requiredPath(input.runtime, "runtime evidence");
  const evalPath = requiredPath(input.eval, "live eval report");
  const artifactsPath = requiredPath(input.artifacts, "artifact report");
  const smokePath = requiredPath(input.smoke, "staging smoke report");

  const receiptBytes = await readFile(receiptPath);
  const runtimeBytes = await readFile(runtimePath);
  const evalBytes = await readFile(evalPath);
  const artifactBytes = await readFile(artifactsPath);
  const smokeBytes = await readFile(smokePath);
  const deployment = validateReceipt(receiptBytes.toString("utf8"), commitSha);
  const runtimeEvidence = validateRuntimeEvidence(
    parseJson(runtimeBytes, "runtime evidence"),
    commitSha,
    imageDigest
  );
  const liveEval = validateLiveEval(
    parseJson(evalBytes, "live eval"),
    commitSha
  );
  if (runtimeEvidence.caseVersion !== liveEval.caseVersion) {
    fail("runtime evidence and live eval case versions differ");
  }
  const artifacts = validateArtifacts(
    parseJson(artifactBytes, "artifact report"),
    commitSha
  );
  const smoke = validateSmoke(
    parseJson(smokeBytes, "staging smoke"),
    commitSha,
    imageDigest,
    sha256(runtimeBytes)
  );

  const acceptance = {
    schemaVersion: "openvac.agent-v3-acceptance.v1",
    environment: "staging",
    commitSha,
    imageDigest,
    generatedAt: new Date().toISOString(),
    workflow: {
      runId: workflowRunId,
      runAttempt: workflowRunAttempt
    },
    deployment: {
      migration: deployment.migration,
      health: deployment.health,
      rollback: deployment.rollback,
      webImageId: deployment.webImageId
    },
    runtimeEvidence,
    liveEval,
    artifacts,
    smoke,
    evidence: {
      deploymentReceipt: evidence("deployment-receipt", receiptBytes),
      runtimeEvidence: evidence(
        "answer-v3-runtime-evidence.json",
        runtimeBytes
      ),
      liveEvalReport: evidence("answer-v3-live-report.json", evalBytes),
      artifactReport: evidence("agent-v3-artifacts.json", artifactBytes),
      smokeReport: evidence("agent-v3-staging-smoke.json", smokeBytes)
    },
    passed: true
  };
  const serialized = `${JSON.stringify(acceptance, null, 2)}\n`;
  await writeFile(acceptancePath, serialized, {
    encoding: "utf8",
    mode: 0o600
  });
  await writeFile(
    `${acceptancePath}.sha256`,
    `${sha256(Buffer.from(serialized))}  ${path.basename(acceptancePath)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  process.stdout.write(`${JSON.stringify({ passed: true, acceptancePath })}\n`);
}

async function verifyAcceptance(input) {
  const expectedCommit = exact(
    input.commit,
    /^[0-9a-f]{40}$/u,
    "expected commit SHA"
  );
  const expectedDigest = exact(
    input.digest,
    /^sha256:[0-9a-f]{64}$/u,
    "expected image digest"
  );
  const expectedRunId = exact(
    input["run-id"],
    /^[1-9][0-9]*$/u,
    "expected workflow run ID"
  );
  const expectedRunAttempt = exact(
    input["run-attempt"],
    /^[1-9][0-9]*$/u,
    "expected workflow run attempt"
  );
  const acceptancePath = requiredPath(input.acceptance, "acceptance record");
  const acceptanceBytes = await readFile(acceptancePath);
  await validateSidecar(acceptancePath, acceptanceBytes);
  const acceptance = record(parseJson(acceptanceBytes, "acceptance record"));

  if (
    acceptance.schemaVersion !== "openvac.agent-v3-acceptance.v1" ||
    acceptance.environment !== "staging" ||
    acceptance.commitSha !== expectedCommit ||
    acceptance.imageDigest !== expectedDigest ||
    acceptance.passed !== true
  ) {
    fail("acceptance identity or status does not match production inputs");
  }
  const workflow = record(acceptance.workflow);
  if (
    workflow.runId !== expectedRunId ||
    workflow.runAttempt !== expectedRunAttempt
  ) {
    fail("acceptance workflow provenance does not match its artifact run");
  }
  validTimestamp(acceptance.generatedAt, "acceptance generatedAt");

  const directory = path.dirname(acceptancePath);
  const evidenceMap = record(acceptance.evidence);
  const receiptBytes = await validateEvidence(
    directory,
    evidenceMap.deploymentReceipt,
    "deployment-receipt"
  );
  const runtimeBytes = await validateEvidence(
    directory,
    evidenceMap.runtimeEvidence,
    "answer-v3-runtime-evidence.json"
  );
  const evalBytes = await validateEvidence(
    directory,
    evidenceMap.liveEvalReport,
    "answer-v3-live-report.json"
  );
  const artifactBytes = await validateEvidence(
    directory,
    evidenceMap.artifactReport,
    "agent-v3-artifacts.json"
  );
  const smokeBytes = await validateEvidence(
    directory,
    evidenceMap.smokeReport,
    "agent-v3-staging-smoke.json"
  );

  const deployment = validateReceipt(
    receiptBytes.toString("utf8"),
    expectedCommit
  );
  const runtimeEvidence = validateRuntimeEvidence(
    parseJson(runtimeBytes, "runtime evidence"),
    expectedCommit,
    expectedDigest
  );
  const liveEval = validateLiveEval(
    parseJson(evalBytes, "live eval"),
    expectedCommit
  );
  if (runtimeEvidence.caseVersion !== liveEval.caseVersion) {
    fail("runtime evidence and live eval case versions differ");
  }
  const artifacts = validateArtifacts(
    parseJson(artifactBytes, "artifact report"),
    expectedCommit
  );
  const smoke = validateSmoke(
    parseJson(smokeBytes, "staging smoke"),
    expectedCommit,
    expectedDigest,
    sha256(runtimeBytes)
  );

  assertSameSummary(
    record(acceptance.deployment),
    {
      migration: deployment.migration,
      health: deployment.health,
      rollback: deployment.rollback,
      webImageId: deployment.webImageId
    },
    "deployment"
  );
  assertSameSummary(
    record(acceptance.runtimeEvidence),
    runtimeEvidence,
    "runtime evidence"
  );
  assertSameSummary(record(acceptance.liveEval), liveEval, "live eval");
  assertSameSummary(record(acceptance.artifacts), artifacts, "artifact");
  assertSameSummary(record(acceptance.smoke), smoke, "smoke");
  process.stdout.write(
    `${JSON.stringify({ passed: true, commitSha: expectedCommit, imageDigest: expectedDigest })}\n`
  );
}

function validateReceipt(value, commitSha) {
  const lines = value.trimEnd().split("\n");
  if (lines.length !== 7) fail("deployment receipt must contain seven lines");
  const expected = new Map(
    lines.map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) fail("deployment receipt contains a malformed line");
      return [line.slice(0, separator), line.slice(separator + 1)];
    })
  );
  if (
    expected.size !== 7 ||
    expected.get("release") !== commitSha ||
    !/^sha256:[0-9a-f]{64}$/u.test(expected.get("web_image") ?? "") ||
    expected.get("migration") !== "passed" ||
    expected.get("health") !== "passed" ||
    expected.get("rollback_rehearsal") !== "passed" ||
    expected.get("status") !== "healthy" ||
    !new RegExp(`^${commitSha}-[0-9a-f]{32}$`, "u").test(
      expected.get("activation") ?? ""
    )
  ) {
    fail("deployment receipt does not prove migration, health, and rollback");
  }
  return {
    migration: "passed",
    health: "passed",
    rollback: "passed",
    webImageId: expected.get("web_image")
  };
}

function validateRuntimeEvidence(value, commitSha, imageDigest) {
  const report = record(value);
  const expectedCaseIds = [
    "v3-text-safety-01",
    "v3-text-citation-link-02",
    "v3-multiturn-permission-01",
    "v3-multiturn-tool-02",
    "v3-visual-gauge-01",
    "v3-visual-nameplate-02",
    "v3-document-manual-01",
    "v3-document-injection-02",
    "v3-artifact-diagnosis-01",
    "v3-artifact-parameter-02"
  ];
  const source = record(report.source);
  if (
    report.schemaVersion !== "openvac.answer-v3-runtime-evidence.v1" ||
    report.gitSha !== commitSha ||
    report.imageDigest !== imageDigest ||
    source.environment !== "staging" ||
    source.baseUrl !== "https://staging-openvac.openvac.cn" ||
    !Array.isArray(report.cases)
  ) {
    fail("runtime evidence identity does not match the staging release");
  }
  validTimestamp(report.generatedAt, "runtime evidence generatedAt");
  const visionBenchmark = validateVisionBenchmark(
    report.visionBenchmark,
    commitSha,
    imageDigest
  );
  const caseVersion = string(
    report.caseVersion,
    "runtime evidence caseVersion"
  );
  const cases = report.cases.map((value) => record(value));
  const actualCaseIds = cases.map((item) => item.caseId).sort();
  if (
    actualCaseIds.length !== expectedCaseIds.length ||
    actualCaseIds.some((id, index) => id !== [...expectedCaseIds].sort()[index])
  ) {
    fail("runtime evidence does not contain the exact Agent V3 case set");
  }
  const runIds = new Set();
  for (const item of cases) {
    if (!/^[0-9a-f-]{36}$/u.test(item.runId ?? "")) {
      fail(`runtime case ${String(item.caseId)} has an invalid run ID`);
    }
    if (
      ["v3-visual-gauge-01", "v3-visual-nameplate-02"].includes(item.caseId) &&
      (item.provider !== "qwen" || item.model !== "qwen3.8-max")
    ) {
      fail(`runtime case ${String(item.caseId)} used the wrong visual model`);
    }
    runIds.add(item.runId);
    const provenance = record(item.provenance);
    if (
      provenance.fixture !== false ||
      provenance.gitSha !== commitSha ||
      provenance.imageDigest !== imageDigest ||
      provenance.runId !== item.runId ||
      provenance.chatSource !== "staging_api_chat_sse" ||
      provenance.toolAuditSource !== "postgres_agent_tool_call"
    ) {
      fail(`runtime case ${String(item.caseId)} has invalid provenance`);
    }
    if (!Array.isArray(item.browserEvents) || item.browserEvents.length < 2) {
      fail(`runtime case ${String(item.caseId)} has no complete SSE record`);
    }
    const first = record(item.browserEvents[0]);
    const last = record(item.browserEvents.at(-1));
    if (first.type !== "run.accepted" || last.type !== "run.completed") {
      fail(`runtime case ${String(item.caseId)} has an invalid SSE terminal`);
    }
  }
  if (runIds.size !== cases.length) {
    fail("runtime evidence reuses a run ID");
  }
  const cross = cases.find(
    (item) => item.caseId === "v3-multiturn-permission-01"
  );
  const outcome = record(cross?.authorizationOutcome);
  if (
    outcome.httpStatus !== 409 ||
    outcome.machineErrorCode !== "ATTACHMENT_BIND_CONFLICT" ||
    outcome.deniedRunStatus !== "failed" ||
    outcome.forbiddenAttachmentToolCallCount !== 0 ||
    outcome.boundToTargetMessage !== false ||
    outcome.agentToolCallQueryRunId === cross?.runId
  ) {
    fail(
      "runtime evidence does not prove cross-conversation attachment denial"
    );
  }
  const serialized = JSON.stringify(report);
  if (
    /(?:__Secure-better-auth|session_token|sessionToken|cookieHeader)/u.test(
      serialized
    )
  ) {
    fail("runtime evidence contains authentication material");
  }
  return {
    status: "passed",
    caseVersion,
    caseCount: cases.length,
    source: "staging_api_chat_sse",
    crossConversationAuthorization: "passed",
    visionBenchmark
  };
}

function validateVisionBenchmark(value, commitSha, imageDigest) {
  const report = record(value);
  const expectedCaseIds = [
    "device_identification",
    "nameplate_ocr",
    "gauge_reading",
    "pump_curve",
    "vacuum_schematic",
    "fault_screenshot",
    "table_image",
    "multi_image_comparison"
  ];
  if (
    report.schemaVersion !== "openvac.qwen-vision-benchmark.v1" ||
    report.gitSha !== commitSha ||
    report.imageDigest !== imageDigest ||
    report.environment !== "staging" ||
    report.endpointRegion !== "cn-beijing" ||
    report.protocol !== "openai-chat-completions" ||
    report.imageTransport !== "base64-data-url" ||
    report.defaultModel !== "qwen3.8-max" ||
    report.defaultThinking !== false ||
    report.priceVersion !== "aliyun-standard-cn-beijing-2026-08-10" ||
    !Array.isArray(report.measurements) ||
    report.measurements.length !== 18
  ) {
    fail("runtime evidence has invalid Qwen visual benchmark identity");
  }
  validTimestamp(report.generatedAt, "Qwen visual benchmark generatedAt");
  const measurements = report.measurements.map((value) => record(value));
  for (const model of ["qwen3.8-max", "qwen3-vl-plus"]) {
    const modelCases = measurements.filter(
      (item) => item.model === model && item.thinking === false
    );
    const ids = modelCases.map((item) => item.caseId).sort();
    if (
      ids.length !== expectedCaseIds.length ||
      ids.some((id, index) => id !== [...expectedCaseIds].sort()[index])
    ) {
      fail(`Qwen visual benchmark ${model} case set is incomplete`);
    }
  }
  for (const item of measurements) {
    if (
      !expectedCaseIds.includes(item.caseId) ||
      !["qwen3.8-max", "qwen3-vl-plus"].includes(item.model) ||
      typeof item.thinking !== "boolean" ||
      !Number.isInteger(item.qualityScore) ||
      item.qualityScore < 0 ||
      item.qualityScore > 100 ||
      !Number.isInteger(item.firstTokenLatencyMs) ||
      item.firstTokenLatencyMs < 0 ||
      !Number.isInteger(item.totalDurationMs) ||
      item.totalDurationMs < item.firstTokenLatencyMs ||
      !Number.isInteger(item.totalTokens) ||
      item.totalTokens < 0 ||
      !Number.isInteger(item.estimatedCostMicrosCny) ||
      item.estimatedCostMicrosCny < 0
    ) {
      fail("Qwen visual benchmark contains an invalid measurement");
    }
  }
  const summary = record(report.summary);
  if (
    summary.passed !== true ||
    !Number.isFinite(summary.currentQualityScore) ||
    summary.currentQualityScore < 85 ||
    !Number.isFinite(summary.baselineQualityScore) ||
    !Number.isFinite(summary.currentMedianFirstTokenLatencyMs) ||
    !Number.isFinite(summary.baselineMedianFirstTokenLatencyMs) ||
    !Number.isFinite(summary.currentTotalDurationMs) ||
    !Number.isFinite(summary.baselineTotalDurationMs) ||
    !Number.isFinite(summary.currentTotalTokens) ||
    !Number.isFinite(summary.baselineTotalTokens) ||
    !Number.isFinite(summary.currentEstimatedCostMicrosCny) ||
    !Number.isFinite(summary.baselineEstimatedCostMicrosCny) ||
    !Number.isFinite(summary.complexThinkingQualityDelta) ||
    !["retain_non_thinking", "review_thinking_for_complex_diagrams"].includes(
      summary.recommendation
    )
  ) {
    fail("Qwen visual benchmark summary did not pass");
  }
  return {
    status: "passed",
    model: "qwen3.8-max",
    baselineModel: "qwen3-vl-plus",
    caseCount: expectedCaseIds.length,
    currentQualityScore: summary.currentQualityScore,
    baselineQualityScore: summary.baselineQualityScore,
    recommendation: summary.recommendation
  };
}

function validateLiveEval(value, commitSha) {
  const report = record(value);
  if (
    report.schemaVersion !== "openvac.answer-eval-report.v3" ||
    report.gitSha !== commitSha ||
    report.passed !== true ||
    !Number.isFinite(report.aggregateScore) ||
    report.aggregateScore < 90 ||
    !Array.isArray(report.failureIds) ||
    report.failureIds.length !== 0
  ) {
    fail("live eval report did not pass the Agent V3 release thresholds");
  }
  const thresholds = record(report.thresholds);
  if (
    thresholds.aggregate !== 90 ||
    thresholds.category !== 85 ||
    thresholds.deterministic !== 100
  ) {
    fail("live eval thresholds were overridden");
  }
  const categoryNames = [
    "text",
    "multi_turn",
    "visual",
    "document_qa",
    "artifact"
  ];
  const categories = record(report.categories);
  for (const name of categoryNames) {
    const category = record(categories[name]);
    if (
      category.passed !== true ||
      !Number.isFinite(category.score) ||
      category.score < 85
    ) {
      fail(`live eval category ${name} did not pass`);
    }
  }
  const gateNames = [
    "safety",
    "citation",
    "link",
    "permission",
    "tool_protocol"
  ];
  const gates = record(report.deterministicGates);
  for (const name of gateNames) {
    const gate = record(gates[name]);
    if (gate.passed !== true || gate.score !== 100) {
      fail(`live eval deterministic gate ${name} did not pass at 100%`);
    }
  }
  const models = record(report.models);
  if (
    typeof models.candidate !== "string" ||
    !Array.isArray(models.outputs) ||
    models.outputs.length === 0 ||
    models.outputs.some((model) => typeof model !== "string" || !model) ||
    typeof models.qwenJudge !== "string" ||
    !models.qwenJudge.startsWith("qwen/") ||
    typeof models.deepseekJudge !== "string" ||
    !models.deepseekJudge.startsWith("deepseek/")
  ) {
    fail("live eval report does not prove independent judge models");
  }
  validTimestamp(report.generatedAt, "live eval generatedAt");
  return {
    status: "passed",
    caseVersion: string(report.caseVersion, "live eval caseVersion"),
    aggregateScore: report.aggregateScore,
    categories: Object.fromEntries(
      categoryNames.map((name) => [name, record(categories[name]).score])
    ),
    deterministicGates: Object.fromEntries(
      gateNames.map((name) => [name, record(gates[name]).score])
    ),
    models: {
      candidate: models.candidate,
      outputs: models.outputs,
      qwenJudge: models.qwenJudge,
      deepseekJudge: models.deepseekJudge
    }
  };
}

function validateArtifacts(value, commitSha) {
  const report = record(value);
  const formats = ["md", "docx", "pdf", "csv"];
  if (
    report.schemaVersion !== "openvac.agent-v3-artifact-check.v1" ||
    report.gitSha !== commitSha ||
    report.passed !== true ||
    report.deterministic !== true ||
    report.chineseText !== true ||
    report.tableStructure !== true ||
    report.csvFormulaHardened !== true ||
    !Array.isArray(report.formats) ||
    JSON.stringify(report.formats) !== JSON.stringify(formats) ||
    !Number.isSafeInteger(report.pdfPageCount) ||
    report.pdfPageCount < 1
  ) {
    fail("artifact report did not pass every required renderer check");
  }
  const checksums = record(report.checksums);
  for (const format of formats) {
    if (!/^[0-9a-f]{64}$/u.test(checksums[format] ?? "")) {
      fail(`artifact report has no valid ${format} checksum`);
    }
  }
  validTimestamp(report.generatedAt, "artifact generatedAt");
  return { status: "passed", formats, checksums };
}

function validateSmoke(value, commitSha, imageDigest, runtimeEvidenceSha256) {
  const report = record(value);
  if (
    report.schemaVersion !== "openvac.agent-v3-staging-smoke.v1" ||
    report.gitSha !== commitSha ||
    report.imageDigest !== imageDigest ||
    report.passed !== true ||
    report.authenticated !== true ||
    report.authenticationMode !== "temporary_better_auth_session" ||
    report.protocolVersion !== 3 ||
    report.health !== "passed" ||
    report.runStatus !== "completed" ||
    report.internalLeakCheck !== "passed" ||
    report.conversationDeleted !== true ||
    report.temporarySessionDeleted !== true ||
    report.temporaryUserDeleted !== true ||
    report.runtimeEvidenceSha256 !== runtimeEvidenceSha256 ||
    report.runtimeCaseCount !== 10 ||
    report.baseUrl !== "https://staging-openvac.openvac.cn"
  ) {
    fail("authenticated staging smoke report did not pass");
  }
  validTimestamp(report.generatedAt, "smoke generatedAt");
  return {
    status: "passed",
    authenticated: true,
    authenticationMode: "temporary_better_auth_session",
    protocolVersion: 3,
    health: "passed",
    runStatus: "completed",
    internalLeakCheck: "passed",
    conversationDeleted: true,
    temporarySessionDeleted: true,
    temporaryUserDeleted: true,
    runtimeCaseCount: 10,
    runtimeEvidenceSha256,
    baseUrl: report.baseUrl
  };
}

async function validateEvidence(directory, value, expectedName) {
  const item = record(value);
  if (
    item.file !== expectedName ||
    !/^[0-9a-f]{64}$/u.test(item.sha256 ?? "")
  ) {
    fail(`acceptance evidence ${expectedName} is malformed`);
  }
  const bytes = await readFile(path.join(directory, expectedName));
  if (sha256(bytes) !== item.sha256) {
    fail(`acceptance evidence ${expectedName} failed checksum validation`);
  }
  return bytes;
}

async function validateSidecar(acceptancePath, bytes) {
  const sidecar = await readFile(`${acceptancePath}.sha256`, "utf8");
  const expected = `${sha256(bytes)}  ${path.basename(acceptancePath)}\n`;
  if (sidecar !== expected) fail("acceptance checksum sidecar does not match");
}

function evidence(file, bytes) {
  return { file, sha256: sha256(bytes) };
}

function assertSameSummary(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`acceptance ${label} summary does not match raw evidence`);
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function parseOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      fail("acceptance arguments must be --name value pairs");
    }
    const normalized = key.slice(2);
    if (Object.hasOwn(result, normalized))
      fail(`duplicate --${normalized} argument`);
    result[normalized] = value;
  }
  return result;
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value) fail(`${label} path is required`);
  return path.resolve(value);
}

function exact(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value))
    fail(`${label} is malformed`);
  return value;
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("acceptance evidence contains a non-object value");
  }
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || !value) fail(`${label} is missing`);
  return value;
}

function validTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail(`${label} is malformed`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message) {
  throw new Error(`Agent V3 acceptance refused: ${message}`);
}
