import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ApiError, parseJson, withApiErrors } from "./errors";

describe("API error responses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the shared JSON error envelope", async () => {
    const handler = withApiErrors(async () => {
      throw new ApiError(409, "CONFLICT", "状态冲突。", { field: "status" });
    });

    const response = await handler();

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "CONFLICT",
        message: "状态冲突。",
        details: { field: "status" }
      }
    });
  });

  it("normalizes zod failures", async () => {
    const handler = withApiErrors(async () => {
      z.object({ name: z.string().min(1) }).parse({ name: "" });
      return new Response();
    });

    const response = await handler();
    const body = (await response.json()) as {
      error: { code: string; details: unknown[] };
    };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toHaveLength(1);
  });

  it("rejects malformed JSON before schema parsing", async () => {
    const request = new Request("https://openvac.test/api/example", {
      method: "POST",
      body: "{"
    });

    await expect(
      parseJson(request, z.object({ value: z.string() }))
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_JSON"
    });
  });

  it("logs the request ID with an unhandled API error", async () => {
    const requestId = "4af6ab18-5108-4d61-b1e8-7ea0d6d5ce7e";
    const error = new Error("database driver failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const handler = withApiErrors<[Request]>(async () => {
      throw error;
    });

    const response = await handler(
      new Request("https://openvac.test/api/admin/budgets", {
        headers: { "x-request-id": requestId }
      })
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(consoleError).toHaveBeenCalledWith("Unhandled API error", {
      requestId,
      error
    });
  });
});
