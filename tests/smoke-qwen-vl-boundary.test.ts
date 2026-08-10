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
  recognizesPascalUnit
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
      "UNIT_NOT_RECOGNIZED"
    );
    expect(publicQwenVlSmokeFailure(failure)).toEqual({
      schemaVersion: "openvac.qwen-vl-smoke-failure.v1",
      code: "RESPONSE_INVALID",
      detail: "UNIT_NOT_RECOGNIZED"
    });
  });

  it.each([
    "Pa",
    "单位为 Pa（帕斯卡）",
    "帕",
    "帕斯卡",
    "pascal",
    "图中显示的是大写字母 P 和小写字母 a",
    "单位由字母 P 与 a 组成"
  ])("accepts an equivalent Pascal-unit recognition: %s", (value) => {
    expect(recognizesPascalUnit(value)).toBe(true);
  });

  it.each(["bar", "mbar", "Torr", "无法识别", "字母 P 和 B"])(
    "rejects a different or missing pressure unit: %s",
    (value) => {
      expect(recognizesPascalUnit(value)).toBe(false);
    }
  );
});
