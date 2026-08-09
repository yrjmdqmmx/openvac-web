import type { AnswerV3, ArtifactSpec, VerifiedLinkPart } from "@/types/chat-v3";

export type AnswerV3EvalCategory =
  "text" | "multi_turn" | "visual" | "document_qa" | "artifact";

export type DeterministicGate =
  "safety" | "citation" | "link" | "permission" | "tool_protocol";

export type AnswerV3EvalCase = {
  id: string;
  category: AnswerV3EvalCategory;
  outputProvider: "deepseek" | "qwen";
  prompt: string;
  turns?: string[];
  deterministicGates: DeterministicGate[];
  expected: {
    answerKind: AnswerV3["answerKind"];
    riskLevel: AnswerV3["riskLevel"];
    evidenceIds: string[];
    minimumEvidenceCount?: number;
    linkIds: string[];
    requireLinkEvidenceBinding?: boolean;
    allowedLinkDomains?: string[];
    facts: string[];
    forbiddenText: string[];
    artifactKind?: ArtifactSpec["kind"];
    permissionAudit?: EvalPermissionAudit[];
  };
};

export type EvalToolAudit = {
  name: string;
  permission: "allowed" | "denied";
  executed: boolean;
  status?: "completed" | "failed";
  denialReason?: string;
  citationIds?: string[];
  resultDigest?: string;
};

export type EvalPermissionAudit = EvalToolAudit;

export type EvalAuthorizationAudit = {
  name: string;
  permission: "denied";
  executed: false;
  denialReason: string;
};

export type EvalLinkAudit = {
  evidenceId: string;
  linkId: string;
  hostname: string;
  status: "verified" | "unavailable";
};

export type AnswerV3CandidateOutput = {
  provider: "deepseek" | "qwen";
  model: string;
  answer: AnswerV3;
  verifiedLinks: VerifiedLinkPart[];
  linkAudit?: EvalLinkAudit[];
  browserEvents: unknown[];
  toolAudit: EvalToolAudit[];
  authorizationAudit?: EvalAuthorizationAudit[];
  observedFacts: string[];
  artifactSpec?: ArtifactSpec;
};

export interface AnswerV3CandidateExecutor {
  readonly provider: "deepseek" | "qwen" | "fixture";
  readonly model: string;
  execute(testCase: AnswerV3EvalCase): Promise<AnswerV3CandidateOutput>;
}

export type JudgeScore = {
  score: number;
  reason: string;
};

export interface AnswerV3Judge {
  readonly provider: "qwen" | "deepseek";
  readonly model: string;
  available(): Promise<boolean>;
  score(input: {
    testCase: AnswerV3EvalCase;
    output: AnswerV3CandidateOutput;
  }): Promise<JudgeScore>;
}

export type AnswerV3EvalDependencies = {
  candidate: AnswerV3CandidateExecutor;
  qwenJudge: AnswerV3Judge;
  deepseekJudge: AnswerV3Judge;
};

export type CategoryScore = {
  score: number;
  passed: boolean;
  caseCount: number;
  failedIds: string[];
};

export type DeterministicGateScore = {
  score: number;
  passed: boolean;
  caseCount: number;
  failedIds: string[];
};

export type AnswerV3EvalReport = {
  schemaVersion: "openvac.answer-eval-report.v3";
  caseVersion: string;
  gitSha: string;
  generatedAt: string;
  models: {
    candidate: string;
    outputs: string[];
    qwenJudge: string;
    deepseekJudge: string;
  };
  thresholds: {
    aggregate: 90;
    category: 85;
    deterministic: 100;
  };
  aggregateScore: number;
  categories: Record<AnswerV3EvalCategory, CategoryScore>;
  deterministicGates: Record<DeterministicGate, DeterministicGateScore>;
  failureIds: string[];
  passed: boolean;
};
