import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelingRepository } from "@/server/modeling/repository";
import type { QuotaReservation } from "@/server/quota";

const authMocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("@/server/auth", () => ({
  auth: { api: { getSession: authMocks.getSession } }
}));

import { handleCreateAiPlan } from "./plans";

const USER_ID = "user-1";
const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const REVISION_ID = "10000000-0000-4000-8000-000000000002";
const JOB_ID = "10000000-0000-4000-8000-000000000003";

function queuedJob() {
  return {
    id: JOB_ID,
    projectId: PROJECT_ID,
    planId: null,
    revisionId: REVISION_ID,
    kind: "ai_plan" as const,
    status: "queued" as const,
    progress: 0,
    idempotencyKey: "plan-request-0001",
    input: {},
    output: {},
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    cancelRequestedAt: null,
    errorCode: null,
    errorMessage: null,
    createdByUserId: USER_ID,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    updatedAt: new Date()
  };
}

function reservation(): QuotaReservation {
  return {
    leaseId: "quota-lease-1",
    actorUserId: USER_ID,
    clientRequestId: `modeling-plan:${PROJECT_ID}:plan-request-0001`,
    resource: "answer",
    units: 1,
    status: "reserved",
    idempotent: false,
    window: {
      key: "2026-08-01",
      resetAt: new Date("2026-08-02T00:00:00.000Z")
    },
    scopes: []
  };
}

function request(): Request {
  return new Request(
    `https://openvac.test/api/modeling/projects/${PROJECT_ID}/ai-plans`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevisionId: REVISION_ID,
        prompt: "把入口直径改为 24 mm",
        idempotencyKey: "plan-request-0001"
      })
    }
  );
}

describe("AI modeling plan quota", () => {
  beforeEach(() => {
    authMocks.getSession.mockResolvedValue({
      user: { id: USER_ID, name: "Owner", email: "owner@example.com" }
    });
  });

  it("uses and commits the existing answer quota when a plan is queued", async () => {
    const job = queuedJob();
    const repository = {
      createAiPlanJob: vi.fn(async () => ({ value: job, replayed: false }))
    } as unknown as ModelingRepository;
    const quota = {
      reserve: vi.fn(async () => reservation()),
      commit: vi.fn(async () => ({
        ...reservation(),
        status: "committed" as const
      })),
      release: vi.fn()
    };

    const response = await handleCreateAiPlan(
      request(),
      PROJECT_ID,
      repository,
      quota
    );

    expect(response.status).toBe(202);
    expect(quota.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        clientRequestId: `modeling-plan:${PROJECT_ID}:plan-request-0001`
      })
    );
    expect(quota.commit).toHaveBeenCalledWith({
      leaseId: "quota-lease-1",
      userId: USER_ID
    });
    expect(quota.release).not.toHaveBeenCalled();
  });

  it("cancels a fresh queued job before releasing quota when commit fails", async () => {
    const job = queuedJob();
    const repository = {
      createAiPlanJob: vi.fn(async () => ({ value: job, replayed: false })),
      cancelJob: vi.fn(async () => ({
        job: { ...job, status: "cancelled" as const },
        replayed: false,
        cancellationRequested: true
      }))
    } as unknown as ModelingRepository;
    const quota = {
      reserve: vi.fn(async () => reservation()),
      commit: vi.fn(async () => {
        throw new Error("quota database unavailable");
      }),
      release: vi.fn(async () => ({
        ...reservation(),
        status: "released" as const
      }))
    };

    const response = await handleCreateAiPlan(
      request(),
      PROJECT_ID,
      repository,
      quota
    );

    expect(response.status).toBe(503);
    expect(repository.cancelJob).toHaveBeenCalledWith(USER_ID, JOB_ID);
    expect(quota.release).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "modeling_plan_quota_commit_failed" })
    );
  });

  it("retains quota when a commit failure races a running worker", async () => {
    const job = queuedJob();
    const repository = {
      createAiPlanJob: vi.fn(async () => ({ value: job, replayed: false })),
      cancelJob: vi.fn(async () => ({
        job: {
          ...job,
          status: "running" as const,
          startedAt: new Date(),
          cancelRequestedAt: new Date()
        },
        replayed: false,
        cancellationRequested: true
      }))
    } as unknown as ModelingRepository;
    const quota = {
      reserve: vi.fn(async () => reservation()),
      commit: vi.fn(async () => {
        throw new Error("quota database unavailable");
      }),
      release: vi.fn()
    };

    const response = await handleCreateAiPlan(
      request(),
      PROJECT_ID,
      repository,
      quota
    );

    expect(response.status).toBe(503);
    expect(quota.release).not.toHaveBeenCalled();
  });

  it("releases a fresh reservation when the project cannot be queued", async () => {
    const repository = {
      createAiPlanJob: vi.fn(async () => null)
    } as unknown as ModelingRepository;
    const quota = {
      reserve: vi.fn(async () => reservation()),
      commit: vi.fn(),
      release: vi.fn(async () => ({
        ...reservation(),
        status: "released" as const
      }))
    };

    const response = await handleCreateAiPlan(
      request(),
      PROJECT_ID,
      repository,
      quota
    );

    expect(response.status).toBe(404);
    expect(quota.release).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "modeling_plan_enqueue_failed" })
    );
  });
});
