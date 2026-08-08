import { ZodError, type ZodType } from "zod";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function jsonData<T>(data: T, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");

  return new Response(JSON.stringify({ data }), {
    ...init,
    headers
  });
}

export function jsonError(error: ApiError): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    }),
    {
      status: error.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    }
  );
}

export async function parseJson<T>(
  request: Request,
  schema: ZodType<T>
): Promise<T> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "请求体必须是有效的 JSON。");
  }

  return schema.parse(body);
}

export function parseSearchParams<T>(request: Request, schema: ZodType<T>): T {
  const url = new URL(request.url);
  return schema.parse(Object.fromEntries(url.searchParams.entries()));
}

export function withApiErrors<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<Response>
): (...args: TArgs) => Promise<Response> {
  return async (...args: TArgs) => {
    const request = args[0] instanceof Request ? args[0] : null;
    const requestId =
      request?.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const withRequestId = (response: Response) => {
      const headers = new Headers(response.headers);
      headers.set("x-request-id", requestId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    };
    try {
      return withRequestId(await handler(...args));
    } catch (error) {
      if (error instanceof ApiError) {
        return withRequestId(jsonError(error));
      }

      if (error instanceof ZodError) {
        return withRequestId(
          jsonError(
            new ApiError(
              422,
              "VALIDATION_ERROR",
              "请求参数不符合要求。",
              error.issues
            )
          )
        );
      }

      console.error("Unhandled API error", error);
      return withRequestId(
        jsonError(
          new ApiError(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。")
        )
      );
    }
  };
}

export function notFound(resource: string): ApiError {
  return new ApiError(404, "NOT_FOUND", `${resource}不存在或无权访问。`);
}
