import sharp from "sharp";

import {
  ProviderError,
  ProviderTimeoutError,
  QwenVlProvider,
  type VisionRequest,
  type VisionResult
} from "../src/server/providers";
import {
  classifyQwenVlSmokeFailure,
  publicQwenVlSmokeFailure
} from "./smoke-qwen-vl-boundary";

async function main(): Promise<void> {
  const provider = new QwenVlProvider();
  const image = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#f8fafc"/><text x="72" y="108" font-family="sans-serif" font-size="52" font-weight="700">Pa</text></svg>',
      "utf8"
    )
  )
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();

  const request: VisionRequest = {
    prompt: "识别图片中清晰可见的真空压力单位。只需简短回答。",
    images: [{ mimeType: "image/png", bytes: new Uint8Array(image) }],
    maxOutputTokens: 128
  };
  const result = await analyzeWithOneRetry(provider, request);
  if (!result.text.trim()) {
    throw new Error("Vision smoke returned no text.");
  }
  console.log(
    JSON.stringify({
      provider: provider.id,
      protocol: provider.capabilities.protocol,
      terminal: "completed"
    })
  );
}

async function analyzeWithOneRetry(
  provider: QwenVlProvider,
  request: VisionRequest
): Promise<VisionResult> {
  try {
    return await analyzeAttempt(provider, request);
  } catch (error) {
    if (!(error instanceof ProviderError) || !error.retryable) throw error;
  }
  return analyzeAttempt(provider, request);
}

async function analyzeAttempt(
  provider: QwenVlProvider,
  request: VisionRequest
): Promise<VisionResult> {
  const signal = AbortSignal.timeout(55_000);
  try {
    return await provider.analyze({ ...request, signal });
  } catch (error) {
    if (signal.aborted) {
      throw new ProviderTimeoutError(provider.id, "Vision smoke timed out.");
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(publicQwenVlSmokeFailure(classifyQwenVlSmokeFailure(error)))
  );
  process.exitCode = 1;
});
