import type {
  AnswerBlock,
  AnswerV3,
  ArtifactPart,
  AttachmentPart,
  InputMessagePart,
  MessagePart,
  VerifiedLinkPart
} from "./chat-v3";

export type RiskLevel = "low" | "medium" | "high";

export type RequestedAgentMode = "auto" | "deep";
export type ResolvedAgentMode = "fast" | "deep";
export type WebMode = "auto" | "always";
export type AnswerKind =
  "grounded" | "general_guidance" | "clarification" | "safe_refusal";
export type AnswerSectionName =
  "conclusion" | "assumptions" | "evidence" | "missingInputs" | "nextSteps";
export type SourceTrustTier = "tier_a" | "tier_b" | "tier_c" | "blocked";
export type SourceReviewStatus =
  "reviewed" | "pending_review" | "rejected" | "runtime_verified";

export type AnswerClaim = {
  text: string;
  evidenceIds: string[];
};

export type AnswerEvidenceItem = {
  claim: string;
  evidenceIds: string[];
};

export type AnswerV2 = {
  schemaVersion: "openvac.answer.v2";
  answerKind: AnswerKind;
  conclusion: AnswerClaim[];
  assumptions: string[];
  evidence: AnswerEvidenceItem[];
  missingInputs: string[];
  nextSteps: string[];
  calculationRefs: string[];
};

export type AnswerSectionValue =
  | AnswerV2["conclusion"]
  | AnswerV2["assumptions"]
  | AnswerV2["evidence"]
  | AnswerV2["missingInputs"]
  | AnswerV2["nextSteps"];

export type CalculationResult = {
  id: string;
  tool: string;
  formulaId: string;
  formulaVersion: string;
  normalizedInputs: Record<string, number | string | boolean | null>;
  result: Record<string, number | string | boolean | null>;
  assumptions: string[];
  warnings: string[];
  sourceIds: string[];
};

/**
 * Browser-safe projection of a deterministic calculation. Internal tool,
 * formula, input and result keys deliberately never cross the server boundary.
 */
export type PublicCalculation = {
  calculationId: string;
  title: string;
  result: string;
  unit?: string;
  assumptions: string[];
  warnings: string[];
};

export type ContextDisclosure = {
  strategy: "full" | "summarized" | "truncated";
  includedMessages: number;
  summarizedMessages: number;
  omittedMessages: number;
  savedMemoriesUsed: number;
};

export type Citation = {
  sourceId: string;
  title: string;
  publisher: string;
  url: string;
  sourcePolicy?:
    | {
        linkAllowed?: boolean;
        authoritative?: boolean;
        allowedDomains?: string[];
      }
    | "authoritative"
    | "reference"
    | "blocked";
  allowedDomains?: string[];
  pageOrSection?: string;
  fetchedAt: string;
  trustTier?: SourceTrustTier;
  reviewStatus?: SourceReviewStatus;
  licenseClass:
    | "open"
    | "public_domain"
    | "metadata_only"
    | "private_authorized"
    | "unknown";
};

export type AnswerMeta = {
  riskLevel: RiskLevel;
  missingInputs: string[];
  webSearched: boolean;
  citations: Citation[];
  answer?: AnswerV2;
  answerV3?: AnswerV3;
  verifiedLinks?: VerifiedLinkPart[];
  artifacts?: ArtifactPart[];
  answerBlocks?: AnswerBlock[];
  turnId?: string;
  runId?: string;
  answerVersion?: number;
  resolvedMode?: ResolvedAgentMode;
  requestedMode?: RequestedAgentMode;
  webMode?: WebMode;
  latencyMs?: number;
  context?: ContextDisclosure;
  calculations?: PublicCalculation[];
  incomplete?: boolean;
};

export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts?: MessagePart[];
  /** Optimistic V3 input. Replaced by server-normalized `parts` in history. */
  inputParts?: InputMessagePart[];
  status?: "streaming" | "completed" | "incomplete" | "error";
  meta?: AnswerMeta;
};

export type AgentStage =
  | "reserved"
  | "analyzing"
  | "retrieving"
  | "searching"
  | "validating_sources"
  | "calculating"
  | "reasoning"
  | "generating"
  | "validating_answer"
  | "saving";

export type PublicToolKind =
  | "knowledge_search"
  | "web_search"
  | "source_validation"
  | "calculation"
  | "answer_validation";

type SequencedRunEvent = {
  runId: string;
  sequence: number;
};

export type ChatStreamEvent =
  | {
      type: "status";
      stage: "reserved" | "retrieving" | "searching" | "answering" | "saving";
      label: string;
    }
  | { type: "delta"; text: string }
  | { type: "citation"; citation: Citation }
  | {
      type: "complete";
      conversationId: string;
      messageId: string;
      meta: AnswerMeta;
    }
  | {
      type: "error";
      code: string;
      message: string;
      resetAt?: string;
    }
  | (SequencedRunEvent & {
      type: "run.accepted";
      turnId: string;
      conversationId: string;
      userMessageId: string;
      messageId: string;
      answerVersion: number;
    })
  | (SequencedRunEvent & {
      type: "stage.changed";
      stage: AgentStage;
      label: string;
    })
  | (SequencedRunEvent & {
      type: "tool.started" | "tool.completed" | "tool.failed";
      label: string;
    })
  | (SequencedRunEvent & {
      type: "answer.section.committed";
      section: AnswerSectionName;
      value: AnswerSectionValue;
    })
  | (SequencedRunEvent & {
      type: "answer.block.committed";
      block: AnswerBlock;
      index: number;
    })
  | (SequencedRunEvent & {
      type: "citation.committed";
      citation: Citation;
    })
  | (SequencedRunEvent & {
      type: "run.completed";
      conversationId: string;
      turnId: string;
      messageId: string;
      answerVersion: number;
      answer: AnswerV2 | AnswerV3;
      meta: AnswerMeta;
    })
  | (SequencedRunEvent & {
      type: "run.cancelled";
      code: "CANCELLED";
      message: string;
      charged: false | null;
      settlement: "released" | "pending_recovery";
      retryable: boolean;
    })
  | (SequencedRunEvent & {
      type: "run.failed";
      code: string;
      message: string;
      retryable: boolean;
      suggestedAction: "retry" | "continue" | "sign_in" | "wait" | "report";
      charged: boolean | null;
      settlement?: "released" | "pending_recovery";
      resetAt?: string;
    })
  | (SequencedRunEvent & {
      type: "attachment.updated";
      attachment: AttachmentPart;
    })
  | (SequencedRunEvent & {
      type: "artifact.updated";
      artifact: ArtifactPart;
    })
  | (SequencedRunEvent & {
      type: "answer.completed";
      answer: AnswerV3;
    });
