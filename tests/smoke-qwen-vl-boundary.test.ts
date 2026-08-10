import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  ProviderResponseError,
  ProviderTimeoutError
} from "../src/server/providers";
import {
  classifyQwenVlSmokeFailure,
  publicQwenVlSmokeFailure,
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

  it.each(["Pa", "单位为 Pa（帕斯卡）", "帕", "帕斯卡", "pascal"])(
    "accepts an equivalent Pascal-unit recognition: %s",
    (value) => {
      expect(recognizesPascalUnit(value)).toBe(true);
    }
  );

  it.each(["bar", "mbar", "Torr", "无法识别"])(
    "rejects a different or missing pressure unit: %s",
    (value) => {
      expect(recognizesPascalUnit(value)).toBe(false);
    }
  );
});
