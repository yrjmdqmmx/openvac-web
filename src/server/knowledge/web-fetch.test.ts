import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { ProviderResponseError, ProviderTimeoutError } from "../providers";
import {
  type HttpsRequester,
  SafeWebFetcher,
  assertSafeResolvedAddresses,
  createPinnedLookup,
  isPublicIpAddress,
  validateFetchUrl
} from "./web-fetch";

describe("safe web fetch URL policy", () => {
  it("allows HTTPS on exact domains and subdomains", () => {
    expect(
      validateFetchUrl("https://sub.nist.gov/report#section", ["nist.gov"]).href
    ).toBe("https://sub.nist.gov/report");
  });

  it.each([
    "http://nist.gov/report",
    "https://nist.gov:8443/report",
    "https://user:pass@nist.gov/report",
    "https://nist.gov.evil.example/report"
  ])("rejects unsafe URL %s", (url) => {
    expect(() => validateFetchUrl(url, ["nist.gov"])).toThrow(
      ProviderResponseError
    );
  });
});

describe("safe web fetch wall-clock deadline", () => {
  it("stops a response that keeps drip-feeding below the inactivity timeout", async () => {
    const scripted = createScriptedRequester({
      chunks: ["a"],
      intervalMs: 5,
      repeat: true
    });
    const fetcher = new SafeWebFetcher({
      allowedDomains: ["nist.gov"],
      timeoutMs: 20,
      totalTimeoutMs: 35,
      resolveDns: async () => [{ address: "8.8.8.8", family: 4 }],
      request: scripted.requester
    });

    await expect(
      fetcher.fetch("https://nist.gov/report")
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(scripted.destroyed()).toBe(true);
    expect(scripted.chunksSent()).toBeGreaterThan(1);
  });

  it("preserves a normal response that completes within the deadline", async () => {
    const scripted = createScriptedRequester({
      chunks: ["vacuum", " evidence"],
      intervalMs: 1,
      repeat: false
    });
    const fetcher = new SafeWebFetcher({
      allowedDomains: ["nist.gov"],
      timeoutMs: 20,
      totalTimeoutMs: 100,
      resolveDns: async () => [{ address: "8.8.8.8", family: 4 }],
      request: scripted.requester
    });

    await expect(
      fetcher.fetch("https://nist.gov/report")
    ).resolves.toMatchObject({
      status: 200,
      contentType: "text/plain",
      body: "vacuum evidence"
    });
    expect(scripted.destroyed()).toBe(false);
  });
});

describe("safe web fetch DNS policy", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "198.51.100.8",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1"
  ])("blocks private or reserved address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"])(
    "allows global address %s",
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    }
  );

  it("rejects a DNS answer set if any address is unsafe", () => {
    expect(() =>
      assertSafeResolvedAddresses("nist.gov", [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 }
      ])
    ).toThrow(ProviderResponseError);
  });

  it("returns an address array when Node requests lookup with all=true", () => {
    const lookup = createPinnedLookup({ address: "8.8.8.8", family: 4 });

    lookup("nist.gov", { all: true }, (error, addresses, family) => {
      expect(error).toBeNull();
      expect(addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
      expect(family).toBeUndefined();
    });
  });

  it("returns the legacy address and family when all=false", () => {
    const lookup = createPinnedLookup({ address: "8.8.8.8", family: 4 });

    lookup("nist.gov", { all: false }, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe("8.8.8.8");
      expect(family).toBe(4);
    });
  });
});

function createScriptedRequester(options: {
  chunks: string[];
  intervalMs: number;
  repeat: boolean;
}): {
  requester: HttpsRequester;
  destroyed(): boolean;
  chunksSent(): number;
} {
  let wasDestroyed = false;
  let sent = 0;

  const requester = ((
    _url: URL,
    requestOptions: RequestOptions,
    callback: (response: IncomingMessage) => void
  ): ClientRequest => {
    const response = new PassThrough() as PassThrough & IncomingMessage;
    response.statusCode = 200;
    response.headers = {
      "content-type": "text/plain"
    };

    const emitter = new EventEmitter();
    const request = emitter as unknown as ClientRequest;
    let interval: NodeJS.Timeout | undefined;
    let stopped = false;

    request.setTimeout = (() => request) as ClientRequest["setTimeout"];
    request.destroy = ((error?: Error) => {
      if (stopped) {
        return request;
      }
      stopped = true;
      wasDestroyed = true;
      if (interval) {
        clearInterval(interval);
      }
      response.destroy();
      queueMicrotask(() =>
        emitter.emit("error", error ?? new Error("destroyed"))
      );
      return request;
    }) as ClientRequest["destroy"];
    request.end = (() => {
      callback(response);
      let index = 0;
      interval = setInterval(() => {
        if (stopped) {
          return;
        }
        const chunk = options.chunks[index] ?? options.chunks.at(-1) ?? "";
        response.write(chunk);
        sent += 1;
        index += 1;
        if (!options.repeat && index >= options.chunks.length) {
          clearInterval(interval);
          interval = undefined;
          stopped = true;
          response.end();
        }
      }, options.intervalMs);
      interval.unref?.();
      return request;
    }) as ClientRequest["end"];

    const signal = requestOptions.signal;
    const abort = (): void => {
      request.destroy(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("request aborted")
      );
    };
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }

    return request;
  }) as HttpsRequester;

  return {
    requester,
    destroyed: () => wasDestroyed,
    chunksSent: () => sent
  };
}
