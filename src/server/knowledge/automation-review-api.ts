import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  ApiError,
  jsonData,
  parseJson,
  withApiErrors
} from "@/server/api/errors";
import { getObjectStorage } from "@/server/providers";

import { knowledgeReviewAutomationRepository } from "./automation-review-repository";
import {
  KnowledgeReviewAutomationService,
  automationReviewReportSchema
} from "./automation-review-service";
import {
  knowledgeAutomationReviewPhaseSchema,
  knowledgeSha256Schema
} from "./review-policy";

const defaultService = new KnowledgeReviewAutomationService(
  knowledgeReviewAutomationRepository,
  getObjectStorage()
);

type ClaimService = Pick<KnowledgeReviewAutomationService, "claim">;
type PackageService = Pick<KnowledgeReviewAutomationService, "getPackage">;
type ResultService = Pick<KnowledgeReviewAutomationService, "submitResult">;

export function authorizeKnowledgeReviewAutomation(
  request: Request,
  configuredHash = process.env.KNOWLEDGE_REVIEW_AUTOMATION_TOKEN_SHA256
): void {
  if (!configuredHash || !/^[0-9a-f]{64}$/u.test(configuredHash)) {
    throw new ApiError(
      503,
      "KNOWLEDGE_REVIEW_AUTH_UNAVAILABLE",
      "Knowledge review automation authentication is unavailable."
    );
  }
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  const actual = createHash("sha256")
    .update(match?.[1] ?? "", "utf8")
    .digest();
  const expected = Buffer.from(configuredHash, "hex");
  if (!match || !timingSafeEqual(actual, expected)) {
    throw new ApiError(
      401,
      "KNOWLEDGE_REVIEW_UNAUTHENTICATED",
      "Valid knowledge review automation credentials are required."
    );
  }
}

export const handleClaimKnowledgeReviews = withApiErrors(
  async (
    request: Request,
    service: ClaimService = defaultService,
    tokenHash?: string
  ) => {
    authorizeKnowledgeReviewAutomation(request, tokenHash);
    const input = await parseJson(
      request,
      z.object({
        phase: knowledgeAutomationReviewPhaseSchema,
        max: z.number().int().min(1).max(10).default(1)
      })
    );
    return jsonData({ claims: await service.claim(input) });
  }
);

export const handleGetKnowledgeReviewPackage = withApiErrors(
  async (
    request: Request,
    id: string,
    service: PackageService = defaultService,
    tokenHash?: string
  ) => {
    authorizeKnowledgeReviewAutomation(request, tokenHash);
    const url = new URL(request.url);
    const input = z
      .object({
        id: z.uuid(),
        phase: knowledgeAutomationReviewPhaseSchema,
        leaseToken: z.string().min(20).max(1_000)
      })
      .parse({
        id,
        phase: url.searchParams.get("phase"),
        leaseToken: request.headers.get("x-knowledge-review-lease")
      });
    return jsonData(await service.getPackage(input));
  }
);

export const handleSubmitKnowledgeReviewResult = withApiErrors(
  async (
    request: Request,
    id: string,
    service: ResultService = defaultService,
    tokenHash?: string
  ) => {
    authorizeKnowledgeReviewAutomation(request, tokenHash);
    const body = await parseJson(
      request,
      z
        .object({
          phase: knowledgeAutomationReviewPhaseSchema,
          leaseToken: z.string().min(20).max(1_000),
          inputVersionId: z.uuid(),
          inputContentHash: knowledgeSha256Schema,
          report: automationReviewReportSchema,
          revisedContent: z.string().trim().min(1).max(5_000_000).optional()
        })
        .strict()
    );
    return jsonData(await service.submitResult({ id, ...body }));
  }
);
