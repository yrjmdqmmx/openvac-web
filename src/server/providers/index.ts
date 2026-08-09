import { getResponsesProvider as getDeepSeekResponsesProvider } from "./deepseek-responses";
import { getDocumentParser as getAlibabaDocumentParser } from "./docmind";
import { getVisionProvider as getQwenVisionProvider } from "./qwen-vl";
import type {
  DocumentParser,
  ResponsesProvider,
  VisionProvider
} from "./types";

export * from "./errors";
export * from "./types";

export {
  DeepSeekModelProvider,
  getModelProvider,
  parseSseJson
} from "./deepseek";
export {
  DEEPSEEK_RESPONSES_CAPABILITIES,
  DeepSeekResponsesProvider,
  getResponsesProvider
} from "./deepseek-responses";
export {
  QWEN_VL_CAPABILITIES,
  QwenVlProvider,
  getVisionProvider
} from "./qwen-vl";
export {
  createDeepSeekUserPartition,
  getDeepSeekUserPartition
} from "./user-partition";
export {
  AlibabaEmbeddingProvider,
  getEmbeddingProvider
} from "./alibaba-embedding";
export {
  AlibabaWebSearchProvider,
  getWebSearchProvider
} from "./alibaba-web-search";
export { AlibabaDocMindParser, getDocumentParser } from "./docmind";
export { AlibabaDirectMailProvider, getEmailProvider } from "./directmail";
export { AlibabaOssStorage, getObjectStorage } from "./oss";

export interface CapabilityRouteRequest {
  hasImages: boolean;
  hasDocuments: boolean;
}

export interface CapabilityRoute {
  reasoningProvider: ResponsesProvider;
  visionProvider?: VisionProvider;
  documentParser?: DocumentParser;
}

export function routeCapabilities(
  request: CapabilityRouteRequest
): CapabilityRoute {
  return {
    reasoningProvider: getDeepSeekResponsesProvider(),
    ...(request.hasImages ? { visionProvider: getQwenVisionProvider() } : {}),
    ...(request.hasDocuments
      ? { documentParser: getAlibabaDocumentParser() }
      : {})
  };
}
