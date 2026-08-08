import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/server/api/errors";

import {
  KnowledgeManualReviewService,
  type KnowledgeManualReviewRepository,
  type KnowledgeManualResolutionInput
} from "./manual-review-service";

const target = {
  documentId: "00000000-0000-4000-8000-000000000001",
  expectedVersionId: "00000000-0000-4000-8000-000000000002",
  expectedContentHash: "a".repeat(64),
  actorId: "editor-1",
  actorRole: "knowledge_editor" as const,
  requestId: "request-1"
};

describe("KnowledgeManualReviewService", () => {
  it("passes only a current version/hash-bound retry to the repository", async () => {
    const repository = makeRepository();
    repository.retry = vi.fn().mockResolvedValue({ status: "queued" });
    const service = new KnowledgeManualReviewService(repository);

    await service.retry(target);

    expect(repository.retry).toHaveBeenCalledWith(target);
  });

  it("requires edited content only for manual_edit_and_retry", async () => {
    const service = new KnowledgeManualReviewService(makeRepository());

    await expect(
      service.resolve({
        ...target,
        action: "manual_edit_and_retry",
        note: "修订"
      } as unknown as KnowledgeManualResolutionInput)
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      service.resolve({
        ...target,
        action: "adopt_revision_and_retry",
        revisedContent: "must not be accepted"
      } as unknown as KnowledgeManualResolutionInput)
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("requires a meaningful manual approval note", async () => {
    const service = new KnowledgeManualReviewService(makeRepository());

    await expect(
      service.resolve({
        ...target,
        action: "manual_approve_with_note",
        note: " "
      })
    ).rejects.toMatchObject({ code: "KNOWLEDGE_MANUAL_RESOLUTION_INVALID" });
  });
});

function makeRepository(): KnowledgeManualReviewRepository {
  return {
    retry: vi.fn(),
    resolve: vi.fn()
  };
}
