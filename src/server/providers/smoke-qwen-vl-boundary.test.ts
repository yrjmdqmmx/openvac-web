import { describe, expect, it, vi } from "vitest";

import {
  ConfigurationError,
  ProviderError,
  ProviderResponseError,
  ProviderTimeoutError,
  QwenVlOutputTruncatedError
} from "./index";
import {
  createQwenVlSmokeRetryBudget,
  qwenVlSmokeRecordedDurationMs,
  QwenVlSmokeFailure,
  withOneQwenVlControlledFixtureRetry
} from "../../../scripts/smoke-qwen-vl-boundary";

describe("Qwen-VL controlled fixture retry", () => {
  it.each([400, 422])(
    "retries one allowlisted device request after HTTP %s with byte-identical input",
    async (status) => {
      const request = { body: "stable serialized request" };
      const seen: string[] = [];
      const execute = vi.fn(async (value: typeof request) => {
        seen.push(JSON.stringify(value));
        if (seen.length === 1) {
          throw new ProviderResponseError("qwen-vl", "redacted", {
            status
          });
        }
        return "ok";
      });
      const onRetry = vi.fn();

      await expect(
        withOneQwenVlControlledFixtureRetry({
          caseId: "device_identification",
          budget: createQwenVlSmokeRetryBudget(),
          request,
          execute,
          onRetry
        })
      ).resolves.toEqual({ result: "ok", attempts: 2 });

      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[0]?.[0]).toBe(request);
      expect(execute.mock.calls[1]?.[0]).toBe(request);
      expect(seen).toEqual([seen[0], seen[0]]);
      expect(onRetry).toHaveBeenCalledWith({
        schemaVersion: "openvac.qwen-vl-smoke-retry.v1",
        caseId: "device_identification",
        firstFailureCode: "REQUEST_INVALID",
        firstFailureStatus: status,
        attempt: 2,
        maxAttempts: 2
      });
      expect(JSON.stringify(onRetry.mock.calls)).not.toContain("redacted");
    }
  );

  it.each([
    {
      name: "timeout",
      error: new ProviderTimeoutError("qwen-vl", "redacted"),
      code: "TIMEOUT"
    },
    {
      name: "rate limit",
      error: new ProviderError("redacted", {
        provider: "qwen-vl",
        status: 429,
        retryable: true
      }),
      code: "RATE_LIMITED"
    },
    {
      name: "server error lower bound",
      error: new ProviderResponseError("qwen-vl", "redacted", {
        status: 500,
        retryable: true
      }),
      code: "PROVIDER_UNAVAILABLE"
    },
    {
      name: "service unavailable",
      error: new ProviderResponseError("qwen-vl", "redacted", {
        status: 503,
        retryable: true
      }),
      code: "PROVIDER_UNAVAILABLE"
    },
    {
      name: "server error upper bound",
      error: new ProviderResponseError("qwen-vl", "redacted", {
        status: 599,
        retryable: true
      }),
      code: "PROVIDER_UNAVAILABLE"
    }
  ])("retries one explicit $name failure", async ({ error, code }) => {
    const execute = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce("ok");
    const onRetry = vi.fn();

    await expect(
      withOneQwenVlControlledFixtureRetry({
        caseId: "pump_curve",
        budget: createQwenVlSmokeRetryBudget(),
        request: {},
        execute,
        onRetry
      })
    ).resolves.toEqual({ result: "ok", attempts: 2 });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ firstFailureCode: code })
    );
  });

  it("preserves the second failure and never makes a third request", async () => {
    const second = new ProviderResponseError("qwen-vl", "second redacted", {
      status: 503,
      retryable: true
    });
    const execute = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new ProviderResponseError("qwen-vl", "first redacted", {
          status: 400
        })
      )
      .mockRejectedValueOnce(second);

    await expect(
      withOneQwenVlControlledFixtureRetry({
        caseId: "device_identification",
        budget: createQwenVlSmokeRetryBudget(),
        request: {},
        execute,
        onRetry: vi.fn()
      })
    ).rejects.toBe(second);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("shares one retry quota across all benchmark cases in the process", async () => {
    const budget = createQwenVlSmokeRetryBudget();
    const first = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new ProviderResponseError("qwen-vl", "redacted", { status: 503 })
      )
      .mockResolvedValueOnce("ok");
    await withOneQwenVlControlledFixtureRetry({
      caseId: "pump_curve",
      budget,
      request: {},
      execute: first,
      onRetry: vi.fn()
    });

    const secondError = new ProviderResponseError("qwen-vl", "redacted", {
      status: 503
    });
    const second = vi.fn(async () => {
      throw secondError;
    });
    await expect(
      withOneQwenVlControlledFixtureRetry({
        caseId: "table_image",
        budget,
        request: {},
        execute: second,
        onRetry: vi.fn()
      })
    ).rejects.toBe(secondError);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("records both physical attempts in a successful retry duration", () => {
    expect(
      qwenVlSmokeRecordedDurationMs({
        attempts: 2,
        successfulAttemptDurationMs: 40,
        requestStartedAtMs: 100,
        requestFinishedAtMs: 275
      })
    ).toBe(175);
    expect(
      qwenVlSmokeRecordedDurationMs({
        attempts: 1,
        successfulAttemptDurationMs: 40,
        requestStartedAtMs: 100,
        requestFinishedAtMs: 275
      })
    ).toBe(40);
  });

  it.each([
    new ProviderResponseError("qwen-vl", "redacted", { status: 400 }),
    new ProviderResponseError("qwen-vl", "redacted", {
      retryable: true
    }),
    new ProviderError("redacted", {
      provider: "qwen-vl",
      status: 401
    }),
    new ProviderError("redacted", {
      provider: "qwen-vl",
      status: 402
    }),
    new ProviderError("redacted", {
      provider: "qwen-vl",
      status: 403
    }),
    new ProviderError("redacted", {
      provider: "qwen-vl",
      status: 600,
      retryable: true
    }),
    new ConfigurationError("qwen-vl", "redacted"),
    new QwenVlOutputTruncatedError(),
    new QwenVlSmokeFailure("RESPONSE_INVALID")
  ])("does not retry a non-eligible failure", async (error) => {
    const execute = vi.fn(async () => {
      throw error;
    });
    await expect(
      withOneQwenVlControlledFixtureRetry({
        caseId: "nameplate_ocr",
        budget: createQwenVlSmokeRetryBudget(),
        request: {},
        execute,
        onRetry: vi.fn()
      })
    ).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
