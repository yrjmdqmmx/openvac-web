import { describe, expect, it, vi } from "vitest";

import type {
  DocumentParser,
  EmbeddingProvider,
  ObjectStorage
} from "@/server/providers";

import {
  chunkReviewedMarkdown,
  KnowledgeIngestionWorker,
  renderParsedDocument,
  sha256
} from "./knowledge-ingestion";
import type {
  KnowledgeIngestionJob,
  KnowledgeIngestionRepository
} from "./types";

describe("knowledge ingestion review gate", () => {
  it("stops after OCR and persists review_required without embedding", async () => {
    const job = makeJob({
      stage: "ocr_processing",
      parserJobId: "parser-1",
      parserSubmittedAt: new Date().toISOString()
    });
    const repository = makeRepository(job);
    const parser = makeParser();
    const embeddings = makeEmbeddings();
    const worker = new KnowledgeIngestionWorker({
      repository,
      parser,
      embeddings
    });

    const outcome = await worker.runOnce();

    expect(outcome).toBe("review_required");
    expect(repository.saveParsedForReview).toHaveBeenCalledOnce();
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it("submits only a private OSS object through an exact allowlisted HTTPS host", async () => {
    const job = makeJob({ stage: "ocr_pending" });
    const repository = makeRepository(job);
    const parser = makeParser();
    const storage = makeObjectStorage(
      "https://openvac-private.oss-cn-hangzhou.aliyuncs.com/knowledge-originals/manual.pdf?signature=redacted"
    );
    const worker = new KnowledgeIngestionWorker({
      repository,
      parser,
      embeddings: makeEmbeddings(),
      objectStorage: storage,
      allowedDocumentHosts: ["openvac-private.oss-cn-hangzhou.aliyuncs.com"]
    });

    const outcome = await worker.runOnce();

    expect(outcome).toBe("deferred");
    expect(storage.createPrivateDownloadUrl).toHaveBeenCalledWith(
      "knowledge-originals/manual.pdf",
      900
    );
    expect(parser.submit).toHaveBeenCalledOnce();
    expect(repository.markOcrSubmitted).toHaveBeenCalledOnce();
  });

  it("accepts the schema-canonical private knowledge-original key", async () => {
    const canonicalKey =
      "private/knowledge-originals/00000000-0000-4000-8000-000000000001/" +
      "00000000-0000-4000-8000-000000000002/manual.pdf";
    const job = makeJob({ stage: "ocr_pending", objectKey: canonicalKey });
    const repository = makeRepository(job);
    const parser = makeParser();
    const storage = makeObjectStorage(
      "https://openvac-private.oss-cn-hangzhou.aliyuncs.com/private/knowledge-originals/manual.pdf?signature=redacted"
    );
    const worker = new KnowledgeIngestionWorker({
      repository,
      parser,
      embeddings: makeEmbeddings(),
      objectStorage: storage,
      allowedDocumentHosts: ["openvac-private.oss-cn-hangzhou.aliyuncs.com"]
    });

    await expect(worker.runOnce()).resolves.toBe("deferred");
    expect(storage.createPrivateDownloadUrl).toHaveBeenCalledWith(
      canonicalKey,
      900
    );
  });

  it("rejects a signed URL whose hostname is not exactly allowlisted", async () => {
    const job = makeJob({ stage: "ocr_pending" });
    const repository = makeRepository(job);
    const parser = makeParser();
    const worker = new KnowledgeIngestionWorker({
      repository,
      parser,
      embeddings: makeEmbeddings(),
      objectStorage: makeObjectStorage(
        "https://openvac-private.oss-cn-hangzhou.aliyuncs.com.attacker.example/manual.pdf"
      ),
      allowedDocumentHosts: ["openvac-private.oss-cn-hangzhou.aliyuncs.com"]
    });

    const outcome = await worker.runOnce();

    expect(outcome).toBe("failed");
    expect(parser.submit).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledOnce();
  });

  it("fails closed when OCR polling exceeds its bounded poll budget", async () => {
    const job = makeJob({
      stage: "ocr_processing",
      parserJobId: "parser-1",
      parserSubmittedAt: new Date().toISOString(),
      parserPollCount: 3
    });
    const repository = makeRepository(job);
    const parser = makeParser();
    const worker = new KnowledgeIngestionWorker({
      repository,
      parser,
      embeddings: makeEmbeddings(),
      maxOcrPolls: 3
    });

    const outcome = await worker.runOnce();

    expect(outcome).toBe("failed");
    expect(parser.getStatus).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledOnce();
  });

  it("does not mutate a task after its worker lease becomes stale", async () => {
    const job = makeJob({
      stage: "ocr_processing",
      parserJobId: "parser-1",
      parserSubmittedAt: new Date().toISOString()
    });
    const repository = makeRepository(job);
    vi.mocked(repository.renewLease).mockRejectedValueOnce(
      Object.assign(new Error("stale"), { name: "StaleWorkerLeaseError" })
    );
    const parser = makeParser();
    const worker = new KnowledgeIngestionWorker({
      repository,
      parser,
      embeddings: makeEmbeddings()
    });

    const outcome = await worker.runOnce();

    expect(outcome).toBe("failed");
    expect(parser.getStatus).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it("refuses embedding when human approval metadata is missing", async () => {
    const job = makeJob({ stage: "embedding_pending" });
    const repository = makeRepository(job);
    const embeddings = makeEmbeddings();
    const worker = new KnowledgeIngestionWorker({
      repository,
      parser: makeParser(),
      embeddings
    });

    const outcome = await worker.runOnce();

    expect(outcome).toBe("review_required");
    expect(repository.markReviewRequired).toHaveBeenCalledOnce();
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it("embeds only content matching the human-approved hash", async () => {
    const content = "<!-- openvac-page:1 -->\n# Safety\nReviewed content.";
    const job = makeJob({
      stage: "embedding_pending",
      review: {
        status: "approved",
        reviewedBy: "admin-1",
        reviewedAt: "2026-07-31T08:00:00.000Z",
        contentHash: sha256(content)
      }
    });
    const repository = makeRepository(job, content);
    const embeddings = makeEmbeddings();
    const worker = new KnowledgeIngestionWorker({
      repository,
      parser: makeParser(),
      embeddings
    });

    const outcome = await worker.runOnce();

    expect(outcome).toBe("completed");
    expect(embeddings.embed).toHaveBeenCalledOnce();
    expect(repository.saveEmbeddingsAndComplete).toHaveBeenCalledOnce();
  });

  it("returns to review when content no longer matches the approved hash", async () => {
    const reviewedContent = "Originally reviewed content";
    const job = makeJob({
      stage: "embedding_pending",
      review: {
        status: "approved",
        reviewedBy: "admin-1",
        reviewedAt: "2026-07-31T08:00:00.000Z",
        contentHash: sha256(reviewedContent)
      }
    });
    const repository = makeRepository(job, "Content changed after review");
    const embeddings = makeEmbeddings();
    const worker = new KnowledgeIngestionWorker({
      repository,
      parser: makeParser(),
      embeddings
    });

    const outcome = await worker.runOnce();

    expect(outcome).toBe("review_required");
    expect(repository.markReviewRequired).toHaveBeenCalledOnce();
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(repository.saveEmbeddingsAndComplete).not.toHaveBeenCalled();
  });
});

describe("knowledge text preparation", () => {
  it("preserves OCR page markers and chunk page numbers", () => {
    const rendered = renderParsedDocument({
      jobId: "job-1",
      pages: [
        { pageNumber: 3, markdown: "# Pump\nFirst page" },
        { pageNumber: 4, markdown: "Second page" }
      ]
    });
    const chunks = chunkReviewedMarkdown(rendered, 100, 10);

    expect(rendered).toContain("openvac-page:3");
    expect(chunks.map((chunk) => chunk.pageStart)).toEqual([3, 4]);
    expect(chunks[0]?.sectionPath).toEqual(["Pump"]);
  });
});

function makeJob(
  patch: Partial<KnowledgeIngestionJob["payload"]>
): KnowledgeIngestionJob {
  return {
    id: "job-1",
    workerId: "worker-1",
    leaseToken: "00000000-0000-4000-8000-000000000001",
    attempts: 1,
    maxAttempts: 3,
    payload: {
      stage: "ocr_pending",
      documentId: "doc-1",
      versionId: "version-1",
      objectKey: "knowledge-originals/manual.pdf",
      ...patch
    }
  };
}

function makeObjectStorage(
  signedUrl: string
): ObjectStorage & { createPrivateDownloadUrl: ReturnType<typeof vi.fn> } {
  return {
    id: "storage",
    putPrivate: vi.fn(async () => ({ key: "unused" })),
    getPrivate: vi.fn(async () => new Uint8Array()),
    deletePrivate: vi.fn(async () => undefined),
    createPrivateDownloadUrl: vi.fn(async () => signedUrl)
  };
}

function makeParser(): DocumentParser {
  return {
    id: "parser",
    submit: vi.fn(async () => ({ jobId: "parser-1" })),
    getStatus: vi.fn(async (jobId: string) => ({
      jobId,
      status: "succeeded" as const
    })),
    getResult: vi.fn(async (jobId: string) => ({
      jobId,
      pages: [{ pageNumber: 1, markdown: "OCR result" }]
    }))
  };
}

function makeEmbeddings(): EmbeddingProvider & {
  embed: ReturnType<typeof vi.fn>;
} {
  return {
    id: "embedding",
    model: "embedding-test",
    dimensions: 1024,
    embed: vi.fn(async (texts: string[]) => ({
      model: "embedding-test",
      dimensions: 1024,
      vectors: texts.map(() => Array.from({ length: 1024 }, () => 0))
    }))
  };
}

function makeRepository(
  job: KnowledgeIngestionJob,
  content = "Reviewed content"
): KnowledgeIngestionRepository & Record<string, ReturnType<typeof vi.fn>> {
  let claimed = false;
  return {
    claimNext: vi.fn(async () => {
      if (claimed) return null;
      claimed = true;
      return job;
    }),
    renewLease: vi.fn(async () => undefined),
    markOcrSubmitted: vi.fn(async () => undefined),
    deferOcrPoll: vi.fn(async () => undefined),
    saveParsedForReview: vi.fn(async () => undefined),
    markReviewRequired: vi.fn(async () => undefined),
    loadApprovedContent: vi.fn(async () => ({
      documentId: job.payload.documentId,
      versionId: job.payload.versionId,
      content
    })),
    saveEmbeddingsAndComplete: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined)
  };
}
