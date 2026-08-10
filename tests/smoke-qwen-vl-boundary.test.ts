import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  ProviderResponseError,
  ProviderTimeoutError
} from "../src/server/providers";
import {
  classifyQwenVlSmokeFailure,
  publicQwenVlSmokeFailure,
  QwenVlSmokeFailure,
  recognizesVisualNonce
} from "../scripts/smoke-qwen-vl-boundary";

describe("Qwen-VL smoke public boundary", () => {
  it.each([
    [new ConfigurationError("qwen-vl", "private key name"), "CONFIG_MISSING"],
    [
      new ProviderResponseError("qwen-vl", "private auth body", {
        status: 401
      }),
      "AUTH_FAILED"
    ],
    [
      new ProviderResponseError("qwen-vl", "private quota body", {
        status: 402
      }),
      "QUOTA_EXHAUSTED"
    ],
    [
      new ProviderResponseError("qwen-vl", "private rate body", {
        status: 429,
        retryable: true
      }),
      "RATE_LIMITED"
    ],
    [
      new ProviderResponseError("qwen-vl", "private request body", {
        status: 422
      }),
      "REQUEST_INVALID"
    ],
    [
      new ProviderResponseError("qwen-vl", "private server body", {
        status: 503,
        retryable: true
      }),
      "PROVIDER_UNAVAILABLE"
    ],
    [new ProviderTimeoutError("qwen-vl", "private timeout"), "TIMEOUT"]
  ])("maps provider failures to fixed codes", (error, expectedCode) => {
    expect(classifyQwenVlSmokeFailure(error).code).toBe(expectedCode);
    const serialized = JSON.stringify(
      publicQwenVlSmokeFailure(classifyQwenVlSmokeFailure(error))
    );
    expect(serialized).toContain(expectedCode);
    expect(serialized).not.toMatch(/private|body|key name/iu);
  });

  it("does not serialize unknown error details", () => {
    const error = new Error(
      "secret request-id provider-body https://private.invalid"
    );
    expect(publicQwenVlSmokeFailure(classifyQwenVlSmokeFailure(error))).toEqual(
      {
        schemaVersion: "openvac.qwen-vl-smoke-failure.v1",
        code: "UNEXPECTED_FAILURE"
      }
    );
  });

  it.each(["CONFIG_MISSING", "RESPONSE_INVALID"] as const)(
    "preserves an explicitly classified smoke failure: %s",
    (code) => {
      const failure = new QwenVlSmokeFailure(code);
      expect(classifyQwenVlSmokeFailure(failure)).toBe(failure);
      expect(publicQwenVlSmokeFailure(failure)).toEqual({
        schemaVersion: "openvac.qwen-vl-smoke-failure.v1",
        code
      });
    }
  );

  it("exposes only the fixed semantic detail, never provider text", () => {
    const failure = new QwenVlSmokeFailure(
      "RESPONSE_INVALID",
      "VISUAL_NONCE_MISMATCH"
    );
    expect(publicQwenVlSmokeFailure(failure)).toEqual({
      schemaVersion: "openvac.qwen-vl-smoke-failure.v1",
      code: "RESPONSE_INVALID",
      detail: "VISUAL_NONCE_MISMATCH"
    });
  });

  it.each([
    "73194625",
    "校验数字：73194625",
    "图片中的8位校验数字是：73194625",
    "7319 4625"
  ])("accepts an exact visual nonce with harmless formatting: %s", (value) => {
    expect(recognizesVisualNonce(value, "73194625")).toBe(true);
  });

  it.each([
    "7319462",
    "731946250",
    "73194626",
    "73194625，另一个数字是12345678",
    "73194625，重复为73194625",
    "无法读取 73194625",
    "未清晰识别到 73194625"
  ])(
    "rejects an incomplete, different, or negated visual nonce: %s",
    (value) => {
      expect(recognizesVisualNonce(value, "73194625")).toBe(false);
    }
  );

  it.each(["7319462", "abcdefgh", "123456789"])(
    "rejects an invalid expected nonce: %s",
    (nonce) => {
      expect(recognizesVisualNonce("73194625", nonce)).toBe(false);
    }
  );
});
