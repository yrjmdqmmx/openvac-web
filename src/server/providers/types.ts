export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ModelTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelStreamRequest {
  messages: ChatMessage[];
  tools?: ModelTool[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type ModelStreamEvent =
  | { type: "text-delta"; text: string }
  | {
      type: "tool-call-delta";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | {
      type: "finish";
      finishReason?: string;
      usage?: ModelUsage;
      providerRequestId?: string;
    };

export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  stream(request: ModelStreamRequest): AsyncIterable<ModelStreamEvent>;
}

export interface EmbeddingResult {
  model: string;
  dimensions: number;
  vectors: number[][];
  usage?: {
    promptTokens?: number;
    totalTokens?: number;
  };
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult>;
}

export interface WebSearchRequest {
  query: string;
  allowedDomains?: string[];
  forced?: boolean;
  signal?: AbortSignal;
}

export interface WebSearchSource {
  index: number;
  title: string;
  url: string;
  siteName?: string;
  icon?: string;
}

export interface WebSearchResult {
  requestId?: string;
  synthesis: string;
  searched: boolean;
  searchCalls: number;
  sources: WebSearchSource[];
}

export interface WebSearchProvider {
  readonly id: string;
  search(request: WebSearchRequest): Promise<WebSearchResult>;
}

export interface DocumentParseRequest {
  url?: string;
  bytes?: Uint8Array;
  filename?: string;
  outputFormats?: Array<"markdown" | "visualLayoutInfo">;
  pageIndexes?: number[];
  llmEnhancement?: boolean;
}

export type DocumentParseStatus =
  "pending" | "processing" | "succeeded" | "failed";

export interface DocumentParseJob {
  jobId: string;
  requestId?: string;
}

export interface DocumentParseStatusResult {
  jobId: string;
  status: DocumentParseStatus;
  requestId?: string;
  errorMessage?: string;
}

export interface ParsedDocumentPage {
  pageNumber?: number;
  markdown?: string;
  visualLayoutInfo?: unknown;
}

export interface ParsedDocument {
  jobId: string;
  pages: ParsedDocumentPage[];
  raw?: unknown;
}

export interface DocumentParser {
  readonly id: string;
  submit(request: DocumentParseRequest): Promise<DocumentParseJob>;
  getStatus(jobId: string): Promise<DocumentParseStatusResult>;
  getResult(jobId: string): Promise<ParsedDocument>;
}

export interface TransactionalEmail {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  tag?: string;
}

export interface EmailSendResult {
  messageId: string;
  requestId?: string;
}

export interface EmailProvider {
  readonly id: string;
  sendTransactional(message: TransactionalEmail): Promise<EmailSendResult>;
}

export interface PutObjectRequest {
  key: string;
  body: Uint8Array | string;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface StoredObject {
  key: string;
  etag?: string;
  url?: string;
}

export interface ObjectStorage {
  readonly id: string;
  putPrivate(request: PutObjectRequest): Promise<StoredObject>;
  getPrivate(key: string): Promise<Uint8Array>;
  createPrivateDownloadUrl(
    key: string,
    expiresSeconds?: number
  ): Promise<string>;
}
