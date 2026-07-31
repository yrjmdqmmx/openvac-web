export type RiskLevel = "low" | "medium" | "high";

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
  status?: "streaming" | "completed" | "error";
  meta?: AnswerMeta;
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
    };
