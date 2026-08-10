import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import { z } from "zod";

import {
  answerV3Schema,
  artifactSpecSchema,
  verifiedLinkPartSchema
} from "@/server/chat-v3/contracts";
import { webLinkBindingDigest } from "@/server/agent/web-link-binding";
import type { AnswerBlock, AnswerV3 } from "@/types/chat-v3";

import { qwenVisionBenchmarkSchema } from "../vision/qwen-vl-benchmark";

import { ANSWER_V3_CASE_VERSION, ANSWER_V3_EVAL_CASES } from "./cases";
import type { AnswerV3CandidateOutput, AnswerV3EvalCase } from "./types";

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const FORBIDDEN_BROWSER_FIELD =
  /(?:object[_-]?key|signed[_-]?url|reasoning[_-]?content|chain[_-]?of[_-]?thought|provider[_-]?request[_-]?id|rawarguments|toolarguments|tooloutput|internalprompt|systemprompt)/iu;

const browserEventSchema = z
  .object({
    type: z.enum([
      "run.accepted",
      "stage.changed",
      "tool.started",
      "tool.completed",
      "tool.failed",
      "answer.block.committed",
      "citation.committed",
      "run.completed"
    ]),
    runId: z.string().uuid(),
    sequence: z.number().int().positive()
  })
  .passthrough();

export const runtimeToolAuditSchema = z
  .object({
    callId: z.string().trim().min(1).max(200),
    runId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    permission: z.literal("allowed"),
    executed: z.literal(true),
    status: z.enum(["completed", "failed"]),
    citationIds: z.array(z.string().regex(/^E\d+$/u)).max(64),
    resultDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    source: z.literal("postgres_agent_tool_call")
  })
  .strict();

export const runtimeAuthorizationAuditSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    runId: z.string().uuid(),
    clientRequestId: z.string().uuid(),
    permission: z.literal("denied"),
    executed: z.literal(false),
    denialReason: z.string().trim().min(1).max(240),
    source: z.literal("staging_http_response")
  })
  .strict();

export const runtimeLinkAuditSchema = z
  .object({
    evidenceId: z.string().regex(/^E\d+$/u),
    linkId: z.string().trim().min(1).max(160),
    hostname: z.string().trim().min(1).max(253),
    status: z.enum(["verified", "unavailable"])
  })
  .strict();

export const crossConversationAuthorizationOutcomeSchema = z
  .object({
    attempted: z.literal(true),
    sourceConversationId: z.string().uuid(),
    targetConversationId: z.string().uuid(),
    attachmentId: z.string().uuid(),
    deniedClientRequestId: z.string().uuid(),
    httpStatus: z.literal(409),
    machineErrorCode: z.literal("ATTACHMENT_BIND_CONFLICT"),
    outcome: z.literal("denied"),
    boundToTargetMessage: z.literal(false),
    forbiddenToolExecuted: z.literal(false),
    forbiddenAttachmentToolCallCount: z.literal(0),
    agentToolCallQueryRunId: z.string().uuid(),
    deniedRunStatus: z.literal("failed")
  })
  .strict();

const provenanceSchema = z
  .object({
    fixture: z.literal(false),
    gitSha: z.string().regex(GIT_SHA),
    imageDigest: z.string().regex(IMAGE_DIGEST),
    runId: z.string().uuid(),
    chatRequestId: z.string().uuid(),
    conversationId: z.string().uuid(),
    turnId: z.string().uuid(),
    assistantMessageId: z.string().uuid(),
    capturedAt: z.iso.datetime(),
    chatSource: z.literal("staging_api_chat_sse"),
    toolAuditSource: z.literal("postgres_agent_tool_call")
  })
  .strict();

const runtimeCaseEvidenceSchema = z
  .object({
    caseId: z.string().trim().min(1).max(160),
    runId: z.string().uuid(),
    provider: z.enum(["deepseek", "qwen"]),
    model: z.string().trim().min(1).max(240),
    answer: answerV3Schema.strict(),
    verifiedLinks: z.array(verifiedLinkPartSchema).max(64),
    linkAudit: z.array(runtimeLinkAuditSchema).max(256),
    browserEvents: z.array(browserEventSchema).min(2).max(2_000),
    toolAudit: z.array(runtimeToolAuditSchema).max(256),
    authorizationAudit: z.array(runtimeAuthorizationAuditSchema).max(64),
    authorizationOutcome:
      crossConversationAuthorizationOutcomeSchema.optional(),
    observedFacts: z.array(z.string().trim().min(1).max(2_000)).max(256),
    artifactSpec: artifactSpecSchema.optional(),
    provenance: provenanceSchema
  })
  .strict();

export const runtimeEvidenceSchema = z
  .object({
    schemaVersion: z.literal("openvac.answer-v3-runtime-evidence.v1"),
    caseVersion: z.string().trim().min(1).max(160),
    gitSha: z.string().regex(GIT_SHA),
    imageDigest: z.string().regex(IMAGE_DIGEST),
    generatedAt: z.iso.datetime(),
    source: z
      .object({
        environment: z.literal("staging"),
        baseUrl: z
          .url()
          .max(2_048)
          .refine((value) => {
            const url = new URL(value);
            return (
              url.protocol === "https:" &&
              !url.username &&
              !url.password &&
              !url.port &&
              url.pathname === "/" &&
              !url.search &&
              !url.hash
            );
          })
      })
      .strict(),
    visionBenchmark: qwenVisionBenchmarkSchema,
    cases: z.array(runtimeCaseEvidenceSchema).min(1).max(100)
  })
  .strict();

export type RuntimeEvidence = z.infer<typeof runtimeEvidenceSchema>;

export async function loadRuntimeEvidence(input: {
  path: string;
  checksumSha256: string;
  gitSha: string;
  imageDigest: string;
  baseUrl: string;
}): Promise<RuntimeEvidence> {
  const checksum = input.checksumSha256.trim();
  if (!/^[0-9a-f]{64}$/u.test(checksum)) {
    throw new Error("ANSWER_V3_RUNTIME_EVIDENCE_SHA256 is malformed.");
  }
  const metadata = await lstat(input.path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("ANSWER_V3_RUNTIME_EVIDENCE must be a regular file.");
  }
  if (metadata.size < 2 || metadata.size > MAX_EVIDENCE_BYTES) {
    throw new Error("ANSWER_V3_RUNTIME_EVIDENCE has an invalid size.");
  }
  const bytes = await readFile(input.path);
  const actualChecksum = createHash("sha256").update(bytes).digest("hex");
  if (actualChecksum !== checksum) {
    throw new Error("ANSWER_V3_RUNTIME_EVIDENCE checksum mismatch.");
  }
  const parsed = runtimeEvidenceSchema.parse(
    JSON.parse(bytes.toString("utf8")) as unknown
  );
  validateEvidenceIdentity(parsed, input);
  return parsed;
}

export function candidateOutputsFromRuntimeEvidence(
  evidence: RuntimeEvidence
): Map<string, AnswerV3CandidateOutput> {
  return new Map(
    evidence.cases.map((item) => [
      item.caseId,
      {
        provider: item.provider,
        model: item.model,
        answer: item.answer,
        verifiedLinks: item.verifiedLinks,
        linkAudit: item.linkAudit,
        browserEvents: item.browserEvents,
        toolAudit: item.toolAudit,
        authorizationAudit: item.authorizationAudit,
        observedFacts: item.observedFacts,
        ...(item.artifactSpec ? { artifactSpec: item.artifactSpec } : {})
      }
    ])
  );
}

function validateEvidenceIdentity(
  evidence: RuntimeEvidence,
  expected: {
    gitSha: string;
    imageDigest: string;
    baseUrl: string;
  }
): void {
  if (evidence.caseVersion !== ANSWER_V3_CASE_VERSION) {
    throw new Error(
      "Runtime evidence caseVersion does not match this checkout."
    );
  }
  if (evidence.gitSha !== expected.gitSha) {
    throw new Error(
      "Runtime evidence Git SHA does not match the requested eval SHA."
    );
  }
  if (evidence.imageDigest !== expected.imageDigest) {
    throw new Error(
      "Runtime evidence image digest does not match the accepted image."
    );
  }
  if (
    normalizeOrigin(evidence.source.baseUrl) !==
    normalizeOrigin(expected.baseUrl)
  ) {
    throw new Error(
      "Runtime evidence staging origin does not match the requested origin."
    );
  }

  const expectedIds = ANSWER_V3_EVAL_CASES.map(
    (testCase) => testCase.id
  ).sort();
  const actualIds = evidence.cases.map((item) => item.caseId).sort();
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error(
      "Runtime evidence does not contain the exact Answer V3 case set."
    );
  }
  const runIds = evidence.cases.map((item) => item.runId);
  if (new Set(runIds).size !== runIds.length) {
    throw new Error("Runtime evidence reuses a runId across cases.");
  }

  const casesById = new Map(
    ANSWER_V3_EVAL_CASES.map((testCase) => [testCase.id, testCase])
  );
  for (const item of evidence.cases) {
    const testCase = casesById.get(item.caseId);
    if (!testCase) throw new Error(`Unexpected runtime case ${item.caseId}.`);
    validateRuntimeCase(item, testCase, evidence);
  }
}

function validateRuntimeCase(
  item: RuntimeEvidence["cases"][number],
  testCase: AnswerV3EvalCase,
  evidence: RuntimeEvidence
): void {
  if (item.provider !== testCase.outputProvider) {
    throw new Error(
      `Runtime case ${item.caseId} used the wrong provider route.`
    );
  }
  if (/fixture|mock|stub/iu.test(item.model)) {
    throw new Error(
      `Runtime case ${item.caseId} contains a fixture model marker.`
    );
  }
  if (testCase.category === "visual" && item.model !== "qwen3.8-max") {
    throw new Error(
      `Runtime case ${item.caseId} did not use the accepted visual model.`
    );
  }
  if (
    item.provenance.fixture ||
    item.provenance.gitSha !== evidence.gitSha ||
    item.provenance.imageDigest !== evidence.imageDigest ||
    item.provenance.runId !== item.runId
  ) {
    throw new Error(`Runtime case ${item.caseId} provenance is inconsistent.`);
  }
  if (
    testCase.category === "artifact" &&
    (!item.artifactSpec ||
      item.artifactSpec.kind !== testCase.expected.artifactKind)
  ) {
    throw new Error(
      `Runtime case ${item.caseId} is missing its real ArtifactSpec.`
    );
  }
  validateBrowserEvidence(item);
  for (const audit of item.toolAudit) {
    if (audit.runId !== item.runId) {
      throw new Error(
        `Runtime case ${item.caseId} has a cross-run tool audit.`
      );
    }
  }
  for (const audit of item.authorizationAudit) {
    if (audit.runId === item.runId) {
      throw new Error(
        `Runtime case ${item.caseId} reuses its completed run for denial.`
      );
    }
  }
  validatePermissionEvidence(item, testCase);
  validateLinkEvidence(item, testCase);
  validateCrossConversationAuthorization(item, testCase);
  const visible = normalizeVisibleText(item.answer);
  if (
    item.observedFacts.some((fact) => !visible.includes(normalizeFact(fact)))
  ) {
    throw new Error(
      `Runtime case ${item.caseId} claims an observed fact absent from the answer.`
    );
  }
}

function validateLinkEvidence(
  item: RuntimeEvidence["cases"][number],
  testCase: AnswerV3EvalCase
): void {
  const derived = item.verifiedLinks.flatMap((link) =>
    (link.evidenceIds ?? []).map((evidenceId) => ({
      evidenceId,
      linkId: link.linkId,
      hostname: link.hostname,
      status: link.status
    }))
  );
  if (!sameJsonSet(item.linkAudit, derived)) {
    throw new Error(
      `Runtime case ${item.caseId} link audit does not match verified links.`
    );
  }
  if (!testCase.expected.requireLinkEvidenceBinding) return;
  const allowedDomains = testCase.expected.allowedLinkDomains ?? [];
  const webAudit = item.toolAudit.find(
    (audit) => audit.name === "web_search" && audit.status === "completed"
  );
  const bindingProofs = item.toolAudit.filter(
    (audit) => audit.name === "web_link_binding" && audit.status === "completed"
  );
  const referencedLinkIds = item.answer.blocks.flatMap((block) =>
    block.type === "link_reference" ? [block.linkId] : []
  );
  if (
    !sameJsonSet(referencedLinkIds, testCase.expected.linkIds) ||
    !sameJsonSet(item.answer.usedLinkIds, testCase.expected.linkIds) ||
    !webAudit ||
    !isNonEmptySubset(
      [...new Set(item.linkAudit.map((audit) => audit.evidenceId))],
      webAudit.citationIds
    ) ||
    item.verifiedLinks.some(
      (link) =>
        allowedDomains.length > 0 &&
        !allowedDomains.some((domain) => hostnameWithin(link.hostname, domain))
    ) ||
    item.linkAudit.some((binding) => {
      const link = item.verifiedLinks.find(
        (candidate) => candidate.linkId === binding.linkId
      );
      if (!link) return true;
      const expectedDigest = webLinkBindingDigest({
        evidenceId: binding.evidenceId,
        link
      });
      return !bindingProofs.some(
        (proof) =>
          proof.resultDigest === expectedDigest &&
          sameJsonSet(proof.citationIds, [binding.evidenceId])
      );
    }) ||
    !testCase.expected.linkIds.every((linkId) =>
      item.linkAudit.some(
        (audit) =>
          audit.linkId === linkId &&
          audit.status === "verified" &&
          item.answer.usedEvidenceIds.includes(audit.evidenceId)
      )
    )
  ) {
    throw new Error(
      `Runtime case ${item.caseId} lacks a verified evidence-to-link binding.`
    );
  }
}

function hostnameWithin(hostname: string, domain: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  const normalizedDomain = domain.toLowerCase();
  return (
    normalizedHostname === normalizedDomain ||
    normalizedHostname.endsWith(`.${normalizedDomain}`)
  );
}

function isNonEmptySubset(values: string[], allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return values.length > 0 && values.every((value) => allowedSet.has(value));
}

function validatePermissionEvidence(
  item: RuntimeEvidence["cases"][number],
  testCase: AnswerV3EvalCase
): void {
  if (!testCase.deterministicGates.includes("permission")) return;
  const expected = testCase.expected.permissionAudit;
  if (!expected?.length) {
    throw new Error(`Permission case ${item.caseId} has no expected audit.`);
  }
  const expectedNames = new Set(expected.map((audit) => audit.name));
  if (expectedNames.size !== expected.length) {
    throw new Error(`Permission case ${item.caseId} repeats an expected tool.`);
  }
  const actual = [...item.toolAudit, ...item.authorizationAudit]
    .filter((audit) => expectedNames.has(audit.name))
    .map(permissionProjection);
  if (!sameJsonSet(actual, expected.map(permissionProjection))) {
    throw new Error(
      `Runtime case ${item.caseId} permission evidence does not exact-match.`
    );
  }
}

function validateCrossConversationAuthorization(
  item: RuntimeEvidence["cases"][number],
  testCase: AnswerV3EvalCase
): void {
  const expectedCrossDenial = testCase.expected.permissionAudit?.some(
    (audit) =>
      audit.name === "read_cross_conversation_attachment" &&
      audit.permission === "denied"
  );
  if (!expectedCrossDenial) {
    if (item.authorizationOutcome) {
      throw new Error(
        `Runtime case ${item.caseId} has an unexpected cross-conversation outcome.`
      );
    }
    return;
  }
  const outcome = item.authorizationOutcome;
  if (
    !outcome ||
    outcome.sourceConversationId === outcome.targetConversationId ||
    outcome.targetConversationId !== item.provenance.conversationId ||
    outcome.deniedClientRequestId === item.provenance.chatRequestId ||
    outcome.agentToolCallQueryRunId === item.runId ||
    !item.authorizationAudit.some(
      (audit) =>
        audit.name === "read_cross_conversation_attachment" &&
        audit.clientRequestId === outcome.deniedClientRequestId &&
        audit.runId === outcome.agentToolCallQueryRunId
    ) ||
    item.toolAudit.some((audit) =>
      [
        "search_attachment",
        "open_attachment_excerpt",
        "analyze_image"
      ].includes(audit.name)
    )
  ) {
    throw new Error(
      `Runtime case ${item.caseId} lacks a real cross-conversation authorization denial.`
    );
  }
}

function validateBrowserEvidence(item: RuntimeEvidence["cases"][number]): void {
  const events = item.browserEvents;
  if (
    events[0]?.type !== "run.accepted" ||
    events.at(-1)?.type !== "run.completed"
  ) {
    throw new Error(`Runtime case ${item.caseId} has incomplete SSE evidence.`);
  }
  let previousSequence = 0;
  for (const event of events) {
    if (event.runId !== item.runId || event.sequence <= previousSequence) {
      throw new Error(
        `Runtime case ${item.caseId} has invalid SSE identity or ordering.`
      );
    }
    previousSequence = event.sequence;
  }
  if (FORBIDDEN_BROWSER_FIELD.test(JSON.stringify(events))) {
    throw new Error(
      `Runtime case ${item.caseId} SSE evidence leaks internal fields.`
    );
  }

  const accepted = events[0]!;
  const completed = events.at(-1)!;
  if (
    accepted.conversationId !== item.provenance.conversationId ||
    accepted.turnId !== item.provenance.turnId ||
    accepted.messageId !== item.provenance.assistantMessageId ||
    completed.conversationId !== item.provenance.conversationId ||
    completed.turnId !== item.provenance.turnId ||
    completed.messageId !== item.provenance.assistantMessageId
  ) {
    throw new Error(
      `Runtime case ${item.caseId} SSE provenance does not match.`
    );
  }
  if (!sameJson(completed.answer, item.answer)) {
    throw new Error(
      `Runtime case ${item.caseId} completed answer does not match.`
    );
  }
  const completedMeta = asRecord(completed.meta);
  if (!sameJson(completedMeta.verifiedLinks ?? [], item.verifiedLinks)) {
    throw new Error(
      `Runtime case ${item.caseId} verified links do not match SSE meta.`
    );
  }
  const committedBlocks = events
    .filter((event) => event.type === "answer.block.committed")
    .map((event) => ({ index: event.index, block: event.block }));
  if (
    committedBlocks.length !== item.answer.blocks.length ||
    committedBlocks.some(
      (entry, index) =>
        entry.index !== index ||
        !sameJson(entry.block, item.answer.blocks[index])
    )
  ) {
    throw new Error(
      `Runtime case ${item.caseId} block SSE does not match its answer.`
    );
  }
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}/`;
}

function normalizeVisibleText(answer: AnswerV3): string {
  return normalizeFact(answer.blocks.map(blockText).join("\n"));
}

function blockText(block: AnswerBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return block.text;
    case "list":
      return block.items.join("\n");
    case "table":
      return [...block.columns, ...block.rows.flat()].join("\n");
    case "code":
      return block.code;
    case "callout":
      return [block.title, block.body].filter(Boolean).join("\n");
    case "calculation":
      return [
        block.title,
        block.result,
        ...block.assumptions,
        ...block.warnings
      ].join("\n");
    case "link_reference":
    case "artifact_reference":
      return block.label;
  }
}

function normalizeFact(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .toLocaleLowerCase("zh-CN");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameJsonSet(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = left.map(stableJson).sort();
  const sortedRight = right.map(stableJson).sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function permissionProjection(audit: {
  name: string;
  permission: "allowed" | "denied";
  executed: boolean;
  status?: "completed" | "failed";
  denialReason?: string;
}) {
  return {
    name: audit.name,
    permission: audit.permission,
    executed: audit.executed,
    ...(audit.status ? { status: audit.status } : {}),
    ...(audit.denialReason ? { denialReason: audit.denialReason } : {})
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
