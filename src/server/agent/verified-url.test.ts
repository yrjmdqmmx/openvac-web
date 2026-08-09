import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { HttpsRequester } from "@/server/knowledge/web-fetch";

import { VerifiedUrlError, VerifiedUrlReader } from "./verified-url";

const turnId = "turn-a";
const links = [
  {
    linkId: "L1",
    url: "https://example.com/report#results",
    label: "Report"
  }
] as const;

describe("VerifiedUrlReader turn binding", () => {
  it("reads and sanitizes only a link registered for the current turn", async () => {
    const requester = staticRequester({
      headers: { "content-type": "text/html" },
      body: "<html><script>secret()</script><p>Vacuum evidence</p></html>"
    });
    const reader = readerWith(requester);

    await expect(reader.read({ turnId, linkId: "L1" })).resolves.toEqual({
      link: {
        type: "verified_link",
        linkId: "L1",
        url: "https://example.com/report",
        label: "Report",
        hostname: "example.com",
        status: "verified"
      },
      contentType: "text/html",
      text: "Vacuum evidence"
    });
  });

  it("fails closed before fetching for another turn or an unknown linkId", async () => {
    const requester = staticRequester({
      headers: { "content-type": "text/plain" },
      body: "unused"
    });
    const reader = readerWith(requester);

    await expect(
      reader.read({ turnId: "turn-b", linkId: "L1" })
    ).rejects.toMatchObject({ code: "TURN_SCOPE_MISMATCH" });
    await expect(reader.read({ turnId, linkId: "L2" })).rejects.toMatchObject({
      code: "LINK_NOT_ALLOWED"
    });
    expect(requester).not.toHaveBeenCalled();
  });

  it("replaces an unsafe user label with the verified hostname", async () => {
    const reader = new VerifiedUrlReader({
      turnId,
      links: [
        {
          linkId: "L1",
          url: "https://example.com/report",
          label: "provider tool_call https://private.example"
        }
      ],
      fetcherOptions: {
        resolveDns: async () => [{ address: "8.8.8.8", family: 4 }],
        request: staticRequester({
          headers: { "content-type": "text/plain" },
          body: "verified content"
        })
      }
    });

    await expect(reader.read({ turnId, linkId: "L1" })).resolves.toMatchObject({
      link: { label: "example.com" }
    });
  });

  it.each([
    "http://example.com/report",
    "https://user:pass@example.com/report",
    "https://example.com:8443/report",
    "https://example.com/report?X-Amz-Signature=secret",
    "https://example.com/report?OSSAccessKeyId=secret&Expires=1"
  ])("rejects an unsafe current-turn URL %s", (url) => {
    expect(
      () => new VerifiedUrlReader({ turnId, links: [{ linkId: "L1", url }] })
    ).toThrow(VerifiedUrlError);
  });
});

describe("VerifiedUrlReader SSRF and response gates", () => {
  it("rejects a private DNS answer without making the HTTPS request", async () => {
    const requester = staticRequester({
      headers: { "content-type": "text/plain" },
      body: "metadata"
    });
    const reader = new VerifiedUrlReader({
      turnId,
      links,
      fetcherOptions: {
        resolveDns: async () => [{ address: "169.254.169.254", family: 4 }],
        request: requester
      }
    });

    await expect(reader.read({ turnId, linkId: "L1" })).rejects.toMatchObject({
      code: "VERIFIED_URL_UNAVAILABLE"
    });
    expect(requester).not.toHaveBeenCalled();
  });

  it("rejects redirects outside the selected link hostname", async () => {
    const reader = readerWith(
      staticRequester({
        status: 302,
        headers: {
          location: "https://other.example.net/private",
          "content-type": "text/plain"
        },
        body: ""
      })
    );

    await expect(reader.read({ turnId, linkId: "L1" })).rejects.toMatchObject({
      code: "VERIFIED_URL_UNAVAILABLE"
    });
  });

  it.each([
    {
      name: "unsupported content type",
      headers: { "content-type": "application/octet-stream" },
      body: "binary"
    },
    {
      name: "declared body larger than the cap",
      headers: {
        "content-type": "text/plain",
        "content-length": "100"
      },
      body: "small"
    }
  ])("rejects $name", async ({ headers, body }) => {
    const reader = new VerifiedUrlReader({
      turnId,
      links,
      fetcherOptions: {
        maxBytes: 16,
        resolveDns: async () => [{ address: "8.8.8.8", family: 4 }],
        request: staticRequester({
          headers: headers as Record<string, string>,
          body
        })
      }
    });

    await expect(reader.read({ turnId, linkId: "L1" })).rejects.toMatchObject({
      code: "VERIFIED_URL_UNAVAILABLE"
    });
  });
});

function readerWith(request: HttpsRequester): VerifiedUrlReader {
  return new VerifiedUrlReader({
    turnId,
    links,
    fetcherOptions: {
      resolveDns: async () => [{ address: "8.8.8.8", family: 4 }],
      request
    }
  });
}

function staticRequester(options: {
  status?: number;
  headers: Record<string, string>;
  body: string;
}): HttpsRequester & ReturnType<typeof vi.fn> {
  const requester = vi.fn(
    (
      _url: URL,
      _requestOptions: RequestOptions,
      callback: (response: IncomingMessage) => void
    ): ClientRequest => {
      const response = new PassThrough() as PassThrough & IncomingMessage;
      response.statusCode = options.status ?? 200;
      response.headers = options.headers;
      const emitter = new EventEmitter();
      const request = emitter as unknown as ClientRequest;
      request.setTimeout = (() => request) as ClientRequest["setTimeout"];
      request.destroy = ((error?: Error) => {
        response.destroy();
        if (error) queueMicrotask(() => emitter.emit("error", error));
        return request;
      }) as ClientRequest["destroy"];
      request.end = (() => {
        callback(response);
        response.end(options.body);
        return request;
      }) as ClientRequest["end"];
      return request;
    }
  );
  return requester as unknown as HttpsRequester & ReturnType<typeof vi.fn>;
}
