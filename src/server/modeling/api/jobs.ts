import { authenticate } from "@/server/api/auth";
import {
  ApiError,
  jsonData,
  notFound,
  parseJson,
  parseSearchParams
} from "@/server/api/errors";
import {
  modelingRepository,
  type ModelingRepository
} from "@/server/modeling/repository";

import {
  createModelingJobSchema,
  eventStreamQuerySchema,
  modelingUuidSchema
} from "./schemas";
import { jobEventSchema, MODELING_PROTOCOL_VERSION } from "@/types/modeling";
import {
  jobDto,
  parseIdempotencyOnly,
  requireIdempotencyKey,
  sanitizeModelingJson,
  withModelingApiErrors
} from "./shared";

export const handleCreateModelingJob = withModelingApiErrors(
  async (
    request: Request,
    projectId: string,
    repository: ModelingRepository = modelingRepository
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(projectId);
    const input = await parseJson(request, createModelingJobSchema);
    const idempotencyKey = requireIdempotencyKey(request, input.idempotencyKey);
    const result = await repository.createJob({
      ownerId: user.id,
      projectId: id,
      revisionId: input.revisionId,
      kind: input.kind,
      idempotencyKey,
      input: {
        ...(input.formats ? { formats: input.formats } : {}),
        ...(input.validatePump !== undefined
          ? { validatePump: input.validatePump }
          : {})
      }
    });
    if (!result) {
      throw notFound("建模项目");
    }
    return jsonData(
      { job: jobDto(result.value), idempotentReplay: result.replayed },
      {
        status: result.replayed ? 200 : 202,
        headers: result.replayed ? { "idempotency-replayed": "true" } : {}
      }
    );
  }
);

function parseLastEventId(request: Request): number {
  const value = request.headers.get("last-event-id");
  if (value === null || value === "") {
    return 0;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new ApiError(
      422,
      "INVALID_LAST_EVENT_ID",
      "Last-Event-ID 必须是非负整数。"
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError(
      422,
      "INVALID_LAST_EVENT_ID",
      "Last-Event-ID 超出可支持范围。"
    );
  }
  return parsed;
}

export const handleGetModelingJob = withModelingApiErrors(
  async (
    request: Request,
    jobId: string,
    repository: ModelingRepository = modelingRepository
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(jobId);
    const job = await repository.getJob(user.id, id);
    if (!job) {
      throw notFound("建模任务");
    }
    return jsonData(jobDto(job));
  }
);

export const handleCancelModelingJob = withModelingApiErrors(
  async (
    request: Request,
    jobId: string,
    repository: ModelingRepository = modelingRepository
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(jobId);
    await parseIdempotencyOnly(request);
    const result = await repository.cancelJob(user.id, id);
    if (!result) {
      throw notFound("建模任务");
    }
    return jsonData(
      {
        job: jobDto(result.job),
        cancellationRequested: result.cancellationRequested,
        idempotentReplay: result.replayed
      },
      {
        headers: result.replayed ? { "idempotency-replayed": "true" } : {}
      }
    );
  }
);

export const handleModelingJobEvents = withModelingApiErrors(
  async (
    request: Request,
    jobId: string,
    repository: ModelingRepository = modelingRepository
  ) => {
    const user = await authenticate(request);
    const id = modelingUuidSchema.parse(jobId);
    const query = parseSearchParams(request, eventStreamQuerySchema);
    const afterSequence = parseLastEventId(request);
    const initialEvents = await repository.listJobEvents(
      user.id,
      id,
      afterSequence,
      query.limit
    );
    if (!initialEvents) {
      throw notFound("建模任务");
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        let cursor = afterSequence;
        let events = initialEvents;
        const deadline = Date.now() + query.waitMs;

        try {
          while (!request.signal.aborted) {
            let terminalEventSeen = false;
            for (const event of events) {
              cursor = Math.max(cursor, event.sequence);
              terminalEventSeen ||= isTerminalJobEvent(event.type);
              const payload = jobEventSchema.parse({
                version: MODELING_PROTOCOL_VERSION,
                eventId: event.id,
                jobId: event.jobId,
                sequence: event.sequence,
                occurredAt: event.createdAt.toISOString(),
                type: event.type,
                data: sanitizeModelingJson(event.data)
              });
              controller.enqueue(
                encoder.encode(
                  `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`
                )
              );
            }

            if (terminalEventSeen || query.waitMs === 0) break;
            if (events.length < query.limit) {
              const remainingMs = deadline - Date.now();
              if (remainingMs <= 0) break;
              controller.enqueue(encoder.encode(": keep-alive\n\n"));
              const continued = await waitForNextEventPoll(
                Math.min(1_000, remainingMs),
                request.signal
              );
              if (!continued) break;
            }

            const nextEvents = await repository.listJobEvents(
              user.id,
              id,
              cursor,
              query.limit
            );
            if (!nextEvents) break;
            events = nextEvents;
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    });
  }
);

function isTerminalJobEvent(type: string) {
  return type === "succeeded" || type === "failed" || type === "cancelled";
}

function waitForNextEventPoll(milliseconds: number, signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
