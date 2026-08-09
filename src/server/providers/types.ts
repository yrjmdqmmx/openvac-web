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
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
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

export type VisionImageMimeType = "image/jpeg" | "image/png";

export interface VisionImage {
  bytes: Uint8Array;
  mimeType: VisionImageMimeType;
}

export interface VisionRequest {
  prompt: string;
  images: VisionImage[];
  systemPrompt?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface VisionResult {
  text: string;
  usage?: ModelUsage;
}

export interface VisionCapabilities {
  protocol: "openai-chat-completions";
  imageMimeTypes: readonly VisionImageMimeType[];
  maxImages: number;
  maxImageBytes: number;
  maxTotalImageBytes: number;
  maxResponseBytes: number;
  providerMetadataExposed: false;
}

export interface VisionProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: VisionCapabilities;
  analyze(request: VisionRequest): Promise<VisionResult>;
}

export type ResponsesReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ResponsesInputItem = Record<string, unknown> & {
  type: string;
};

export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponsesWebSearchTool {
  type: "web_search" | "web_search_2025_08_26";
}

export type ResponsesTool = ResponsesFunctionTool | ResponsesWebSearchTool;

export type ResponsesToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; name: string }
  | { type: "web_search" | "web_search_2025_08_26" };

export type ResponsesTextFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      name: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    };

export interface ResponsesStreamRequest {
  instructions?: string;
  input: string | ResponsesInputItem[];
  tools?: ResponsesTool[];
  toolChoice?: ResponsesToolChoice;
  reasoningEffort?: ResponsesReasoningEffort;
  textFormat?: ResponsesTextFormat;
  maxOutputTokens?: number;
  user: string;
  signal?: AbortSignal;
}

export interface ResponsesUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface ResponsesIncompleteDetails {
  reason?: string;
}

export interface ResponsesFailure {
  code?: string;
  message: string;
}

/**
 * `continuationItems` can include private reasoning items. They are only for
 * the next provider request in the current in-memory tool loop. Callers must
 * never persist, log, or send them to the browser.
 */
export type ResponsesStreamEvent =
  | { type: "response-created"; responseId: string }
  | { type: "text-delta"; text: string }
  | {
      type: "function-call";
      callId: string;
      name: string;
      arguments: string;
    }
  | {
      type: "web-search-status";
      status: "in_progress" | "searching" | "completed";
      callId?: string;
    }
  | {
      type: "web-search-sources";
      sources: Array<{ url: string; title: string }>;
    }
  | {
      type: "finish";
      status: "completed" | "incomplete" | "failed";
      responseId: string;
      outputText: string;
      continuationItems: ResponsesInputItem[];
      usage?: ResponsesUsage;
      incomplete?: ResponsesIncompleteDetails;
      error?: ResponsesFailure;
      providerRequestId?: string;
      firstEventLatencyMs?: number;
      /**
       * Saturated, provider-normalized proof of completed native web-search
       * calls. `9` means nine or more provider-internal calls. Consumers must
       * treat this as execution proof, not as the number of outbound requests.
       */
      completedWebSearchCalls?: number;
    };

export interface ResponsesProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ResponsesCapabilities;
  stream(request: ResponsesStreamRequest): AsyncIterable<ResponsesStreamEvent>;
}

export type ResponsesCapabilities = {
  protocol: "responses";
  semanticTerminalEvents: true;
  reasoningItems: true;
  functionTools: true;
  parallelFunctionCalls: true;
  nativeWebSearch: true;
  structuredOutputs: true;
  forcedFunctionResultTransport:
    "native_continuation" | "fresh_trusted_projection";
};

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
  forbidOverwrite?: boolean;
}

export interface StoredObject {
  key: string;
  etag?: string;
  url?: string;
}

export interface CreatePrivateUploadUrlRequest {
  key: string;
  contentType: string;
  contentLength: number;
  checksumSha256: string;
  metadata?: Record<string, string>;
  expiresSeconds?: number;
}

export interface PrivateUploadUrl {
  key: string;
  method: "PUT";
  url: string;
  requiredHeaders: Record<string, string>;
  expiresAt: string;
}

export interface PrivateObjectStat {
  key: string;
  sizeBytes: number;
  etag?: string;
  contentType?: string;
  metadata: Record<string, string>;
  lastModified?: string;
}

export interface ObjectStorage {
  readonly id: string;
  putPrivate(request: PutObjectRequest): Promise<StoredObject>;
  getPrivate(key: string): Promise<Uint8Array>;
  /** Idempotently removes one private object. A missing key is success. */
  deletePrivate(key: string): Promise<void>;
  createPrivateDownloadUrl(
    key: string,
    expiresSeconds?: number
  ): Promise<string>;
  /**
   * Optional for backwards-compatible providers. Callers must fail closed when
   * a private, header-bound upload URL is required and this capability is
   * absent.
   */
  createPrivateUploadUrl?(
    request: CreatePrivateUploadUrlRequest
  ): Promise<PrivateUploadUrl>;
  /**
   * Optional for backwards-compatible providers. This must describe the
   * object stored by the provider; callers must not trust client-supplied
   * length or metadata in its place.
   */
  statPrivate?(key: string): Promise<PrivateObjectStat>;
}
