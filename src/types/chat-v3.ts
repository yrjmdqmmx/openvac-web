export type AgentV3RiskLevel = "low" | "medium" | "high";

export type AttachmentKind = "document" | "image";
export type AttachmentStatus =
  | "initiated"
  | "uploading"
  | "scanning"
  | "processing"
  | "ready"
  | "failed"
  | "deleted";

export type ArtifactFormat = "md" | "docx" | "pdf" | "csv";
export type ArtifactStatus = "generating" | "ready" | "failed" | "deleted";
export type ArtifactKind =
  | "diagnosis_report"
  | "selection_report"
  | "inspection_checklist"
  | "parameter_table";

export type TextPart = {
  type: "text";
  text: string;
};

export type VerifiedLinkPart = {
  type: "verified_link";
  linkId: string;
  url: string;
  label: string;
  hostname: string;
  status: "verified" | "unavailable";
};

export type AttachmentPart = {
  type: "attachment";
  attachmentId: string;
  kind: AttachmentKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: AttachmentStatus;
};

export type CitationPart = {
  type: "citation";
  sourceId: string;
  ordinal: number;
};

export type ArtifactPart = {
  type: "artifact";
  artifactId: string;
  kind: ArtifactKind;
  title: string;
  formats: ArtifactFormat[];
  status: ArtifactStatus;
};

export type MessagePart =
  TextPart | VerifiedLinkPart | AttachmentPart | CitationPart | ArtifactPart;

export type InputMessagePart =
  | TextPart
  | { type: "link"; url: string; label?: string }
  | { type: "attachment"; attachmentId: string };

type EvidenceBound = { evidenceIds: string[] };

export type AnswerBlock =
  | ({ type: "paragraph"; text: string } & EvidenceBound)
  | { type: "heading"; level: 2 | 3; text: string }
  | {
      type: "list";
      style: "ordered" | "unordered";
      items: string[];
      evidenceIds: string[];
    }
  | {
      type: "table";
      columns: string[];
      rows: string[][];
      evidenceIds: string[];
    }
  | { type: "code"; language?: string; code: string }
  | {
      type: "callout";
      tone: "info" | "warning" | "danger";
      title?: string;
      body: string;
      evidenceIds: string[];
    }
  | {
      type: "calculation";
      calculationId: string;
      title: string;
      result: string;
      unit?: string;
      assumptions: string[];
      warnings: string[];
    }
  | { type: "link_reference"; linkId: string; label: string }
  | { type: "artifact_reference"; artifactId: string; label: string };

export type AnswerV3 = {
  schemaVersion: "openvac.answer.v3";
  answerKind: "direct" | "expert" | "clarification" | "safe_refusal";
  riskLevel: AgentV3RiskLevel;
  blocks: AnswerBlock[];
  missingInputs: string[];
  usedEvidenceIds: string[];
  usedLinkIds: string[];
};

export type ArtifactSection = {
  heading: string;
  paragraphs: string[];
};

export type ArtifactTable = {
  title?: string;
  columns: string[];
  rows: string[][];
};

export type ArtifactSpec = {
  schemaVersion: "openvac.artifact.v1";
  kind: ArtifactKind;
  title: string;
  formats: ArtifactFormat[];
  summary: string;
  sections: ArtifactSection[];
  tables: ArtifactTable[];
  sourceTurnId: string;
};

export type AgentV3StreamEvent =
  | { type: "answer.block.committed"; block: AnswerBlock; index: number }
  | { type: "attachment.updated"; attachment: AttachmentPart }
  | { type: "artifact.updated"; artifact: ArtifactPart }
  | { type: "answer.completed"; answer: AnswerV3 };
