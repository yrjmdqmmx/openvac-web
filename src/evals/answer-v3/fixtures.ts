import type { AnswerBlock, AnswerV3, ArtifactSpec } from "@/types/chat-v3";
import { webLinkBindingDigest } from "@/server/agent/web-link-binding";
import type {
  AnswerV3CandidateExecutor,
  AnswerV3CandidateOutput,
  AnswerV3EvalCase,
  AnswerV3Judge
} from "./types";

const SOURCE_TURN_ID = "00000000-0000-4000-8000-000000000101";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000102";

export function createFixtureEvalDependencies() {
  const candidate: AnswerV3CandidateExecutor = {
    provider: "fixture",
    model: "openvac-v3-contract-fixture@1",
    execute: async (testCase) => fixtureOutput(testCase)
  };
  const judge = (
    provider: "qwen" | "deepseek",
    model: string
  ): AnswerV3Judge => ({
    provider,
    model,
    available: async () => true,
    score: async () => ({ score: 98, reason: "reviewed fixture" })
  });
  return {
    candidate,
    qwenJudge: judge("qwen", "qwen-independent-judge-fixture@1"),
    deepseekJudge: judge("deepseek", "deepseek-cross-judge-fixture@1")
  };
}

function fixtureOutput(testCase: AnswerV3EvalCase): AnswerV3CandidateOutput {
  const evidenceIds =
    (testCase.expected.minimumEvidenceCount ?? 0) > 0
      ? Array.from(
          { length: testCase.expected.minimumEvidenceCount ?? 1 },
          (_, index) => `E${index + 1}`
        )
      : testCase.expected.evidenceIds;
  const firstBlock: AnswerBlock =
    testCase.expected.answerKind === "safe_refusal"
      ? {
          type: "callout",
          tone: "danger",
          title: "安全边界",
          body: `${testCase.expected.facts.join("；")}。`,
          evidenceIds
        }
      : {
          type: "paragraph",
          text: `${testCase.expected.facts.join("；")}。`,
          evidenceIds
        };
  const fixtureLinkIds =
    testCase.expected.linkIds.length > 0
      ? testCase.expected.linkIds
      : Array.from(
          { length: testCase.expected.minimumLinkCount ?? 0 },
          (_, index) => `W${index + 1}`
        );
  const blocks: AnswerBlock[] = [firstBlock];
  if (fixtureLinkIds.length > 0) {
    blocks.push({
      type: "link_reference",
      linkId: fixtureLinkIds[0]!,
      label: "厂家手册"
    });
  }
  if (testCase.expected.artifactKind) {
    blocks.push({
      type: "artifact_reference",
      artifactId: ARTIFACT_ID,
      label: "下载工程产物"
    });
  }

  const answer: AnswerV3 = {
    schemaVersion: "openvac.answer.v3",
    answerKind: testCase.expected.answerKind,
    riskLevel: testCase.expected.riskLevel,
    blocks,
    missingInputs:
      testCase.expected.answerKind === "clarification" ? ["当前会话附件"] : [],
    usedEvidenceIds: evidenceIds,
    usedLinkIds: fixtureLinkIds
  };
  const linkHostname = testCase.expected.allowedLinkDomains?.[0]
    ? `www.${testCase.expected.allowedLinkDomains[0]}`
    : "www.example.com";
  return {
    provider: testCase.outputProvider,
    model:
      testCase.outputProvider === "qwen"
        ? "qwen-vl-fixture@1"
        : "deepseek-text-fixture@1",
    answer,
    verifiedLinks: fixtureLinkIds.map((linkId) => ({
      type: "verified_link",
      linkId,
      url: `https://${linkHostname}/manual`,
      label: "厂家手册",
      hostname: linkHostname,
      status: "verified",
      ...(testCase.expected.requireLinkEvidenceBinding ? { evidenceIds } : {})
    })),
    linkAudit: testCase.expected.requireLinkEvidenceBinding
      ? fixtureLinkIds.flatMap((linkId) =>
          evidenceIds.map((evidenceId) => ({
            evidenceId,
            linkId,
            hostname: linkHostname,
            status: "verified" as const
          }))
        )
      : [],
    browserEvents: [
      ...blocks.map((block, index) => ({
        type: "answer.block.committed",
        block,
        index
      })),
      { type: "answer.completed", answer }
    ],
    toolAudit: [
      ...(testCase.expected.permissionAudit ?? [])
        .filter((audit) => audit.permission === "allowed")
        .map((audit) => ({
          ...audit,
          ...(audit.name === "web_search" ? { citationIds: evidenceIds } : {})
        })),
      ...(testCase.expected.requireLinkEvidenceBinding
        ? fixtureLinkIds.flatMap((linkId) =>
            evidenceIds.map((evidenceId) => {
              const link = {
                linkId,
                url: `https://${linkHostname}/manual`,
                hostname: linkHostname
              };
              return {
                name: "web_link_binding",
                permission: "allowed" as const,
                executed: true,
                status: "completed" as const,
                citationIds: [evidenceId],
                resultDigest: webLinkBindingDigest({ evidenceId, link })
              };
            })
          )
        : [])
    ],
    authorizationAudit: (testCase.expected.permissionAudit ?? []).flatMap(
      (audit) =>
        audit.permission === "denied"
          ? [
              {
                name: audit.name,
                permission: "denied" as const,
                executed: false as const,
                denialReason: audit.denialReason ?? "fixture_denial"
              }
            ]
          : []
    ),
    observedFacts: testCase.expected.facts,
    artifactSpec: testCase.expected.artifactKind
      ? artifactFixture(testCase.expected.artifactKind)
      : undefined
  };
}

function artifactFixture(kind: ArtifactSpec["kind"]): ArtifactSpec {
  return {
    schemaVersion: "openvac.artifact.v1",
    kind,
    title: kind === "parameter_table" ? "泵组选型参数表" : "真空系统诊断报告",
    formats:
      kind === "parameter_table" ? ["csv"] : ["md", "docx", "pdf", "csv"],
    summary: "基于当前证据生成，结论需要结合现场复测。",
    sections: [
      { heading: "结论", paragraphs: ["先复测压力曲线，再确认泄漏与流导。"] }
    ],
    tables: [
      {
        title: "参数",
        columns: ["参数", "值", "单位/假设"],
        rows: [["有效抽速", "10", "L/s"]]
      }
    ],
    sourceTurnId: SOURCE_TURN_ID
  };
}
