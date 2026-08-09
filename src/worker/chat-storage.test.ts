import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentParser, ObjectStorage } from "@/server/providers";

import {
  ChatStorageWorker,
  chunksForLocalText,
  chunksForParsedDocument,
  type ChatAttachmentParseJob,
  type ChatStorageWorkerOptions,
  type ChatStorageWorkerRepository
} from "./chat-storage";

const parseJob: ChatAttachmentParseJob = {
  id: "00000000-0000-4000-8000-000000000001",
  objectKey:
    "private/chat-attachments/abcdef/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000001/notes.txt",
  filename: "notes.txt",
  mimeType: "text/plain",
  parserPollCount: 0,
  attempts: 1,
  maxAttempts: 3,
  workerId: "worker-1",
  leaseToken: "00000000-0000-4000-8000-000000000003"
};

describe("chat storage worker", () => {
  beforeEach(() => vi.useRealTimers());

  it("extracts local private text into locator-bound chunks", async () => {
    const repository = makeRepository();
    repository.claimAttachmentParse.mockResolvedValueOnce(parseJob);
    const storage = makeStorage(new TextEncoder().encode("line one\nline two"));

    const outcome = await makeWorker(repository, storage).runOnce();

    expect(outcome).toBe("completed");
    expect(storage.createPrivateDownloadUrl).not.toHaveBeenCalled();
    expect(repository.saveChunksAndComplete).toHaveBeenCalledWith(
      parseJob,
      [
        expect.objectContaining({
          ordinal: 0,
          content: "line one\nline two",
          locator: { type: "text", lineStart: 1, lineEnd: 2 }
        })
      ],
      "local-text"
    );
  });

  it("submits office documents to DocMind using only a short private URL", async () => {
    const repository = makeRepository();
    const officeJob = {
      ...parseJob,
      filename: "manual.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    };
    repository.claimAttachmentParse.mockResolvedValueOnce(officeJob);
    const storage = makeStorage();
    const parser = makeParser();

    const outcome = await makeWorker(repository, storage, parser).runOnce();

    expect(outcome).toBe("deferred");
    expect(storage.createPrivateDownloadUrl).toHaveBeenCalledWith(
      officeJob.objectKey,
      900
    );
    expect(parser.submit).toHaveBeenCalledWith({
      url: "https://oss.test/private",
      filename: "manual.docx",
      outputFormats: ["markdown", "visualLayoutInfo"],
      llmEnhancement: true
    });
    expect(repository.markParserSubmitted).toHaveBeenCalledWith(
      officeJob,
      "docmind-job-1",
      expect.any(Date),
      "test-parser"
    );
  });

  it("polls DocMind and persists page locators without touching knowledge", async () => {
    const repository = makeRepository();
    const remoteJob = {
      ...parseJob,
      filename: "manual.pdf",
      mimeType: "application/pdf",
      parserJobId: "docmind-job-1",
      parserSubmittedAt: new Date().toISOString()
    };
    repository.claimAttachmentParse.mockResolvedValueOnce(remoteJob);
    const parser = makeParser();
    vi.mocked(parser.getStatus).mockResolvedValueOnce({
      jobId: "docmind-job-1",
      status: "succeeded"
    });
    vi.mocked(parser.getResult).mockResolvedValueOnce({
      jobId: "docmind-job-1",
      pages: [{ pageNumber: 7, markdown: "# Pump\n\nPrivate content" }]
    });

    const outcome = await makeWorker(
      repository,
      makeStorage(),
      parser
    ).runOnce();

    expect(outcome).toBe("completed");
    expect(repository.saveChunksAndComplete).toHaveBeenCalledWith(
      remoteJob,
      [
        expect.objectContaining({
          content: "# Pump\n\nPrivate content",
          locator: expect.objectContaining({ type: "page", page: 7 })
        })
      ],
      "test-parser"
    );
  });

  it("prioritizes idempotent object deletion and records completion", async () => {
    const repository = makeRepository();
    const deletion = {
      id: "00000000-0000-4000-8000-000000000004",
      objectKey: parseJob.objectKey,
      attempts: 1,
      maxAttempts: 5,
      workerId: "worker-1",
      leaseToken: "00000000-0000-4000-8000-000000000005"
    };
    repository.claimDeletion.mockResolvedValueOnce(deletion);
    const storage = makeStorage();

    expect(await makeWorker(repository, storage).runOnce()).toBe("completed");
    expect(storage.deletePrivate).toHaveBeenCalledWith(deletion.objectKey);
    expect(repository.markDeletionSucceeded).toHaveBeenCalledWith(deletion);
    expect(repository.claimAttachmentParse).not.toHaveBeenCalled();
  });

  it("records parse failures through the leased repository state machine", async () => {
    const repository = makeRepository();
    repository.claimAttachmentParse.mockResolvedValueOnce(parseJob);
    const storage = makeStorage();
    vi.mocked(storage.getPrivate).mockRejectedValueOnce(
      new Error("private object unavailable")
    );

    expect(await makeWorker(repository, storage).runOnce()).toBe("failed");
    expect(repository.markAttachmentFailed).toHaveBeenCalledWith(
      parseJob,
      expect.objectContaining({ message: "private object unavailable" }),
      expect.any(Date)
    );
  });

  it("fails a permanently pending parser after the bounded poll budget", async () => {
    const repository = makeRepository();
    const remoteJob = {
      ...parseJob,
      filename: "manual.pdf",
      mimeType: "application/pdf",
      parserJobId: "docmind-job-1",
      parserPollCount: 5,
      parserSubmittedAt: new Date().toISOString()
    };
    repository.claimAttachmentParse.mockResolvedValueOnce(remoteJob);
    const parser = makeParser();

    expect(
      await makeWorker(repository, makeStorage(), parser, {
        maxParserPolls: 5
      }).runOnce()
    ).toBe("failed");
    expect(parser.getStatus).not.toHaveBeenCalled();
    expect(repository.markAttachmentFailed).toHaveBeenCalledWith(
      remoteJob,
      expect.objectContaining({
        provider: "chat-storage-worker",
        retryable: false
      }),
      expect.any(Date)
    );
  });
});

describe("private attachment chunk locators", () => {
  it("keeps CSV row ranges private and deterministic", () => {
    const chunks = chunksForLocalText(
      "text/csv",
      new TextEncoder().encode("name,value\npump,10\nvalve,20")
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      ordinal: 0,
      locator: { type: "csv_rows", rowStart: 1, rowEnd: 3 }
    });
    expect(chunks[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("uses supplied document page numbers", () => {
    expect(
      chunksForParsedDocument({
        jobId: "job",
        pages: [{ pageNumber: 3, markdown: "page text" }]
      })[0]?.locator
    ).toEqual({
      type: "page",
      page: 3,
      characterStart: 0,
      characterEnd: 9
    });
  });
});

function makeWorker(
  repository: ReturnType<typeof makeRepository>,
  storage: ObjectStorage,
  parser: DocumentParser = makeParser(),
  options: Partial<ChatStorageWorkerOptions> = {}
) {
  return new ChatStorageWorker({
    repository,
    objectStorage: storage,
    parser,
    workerId: "worker-1",
    pollIntervalMs: 1,
    retryDelayMs: 1,
    ...options
  });
}

function makeRepository() {
  return {
    enqueueExpiredOrphans: vi.fn(async () => 0),
    claimAttachmentParse: vi.fn<
      ChatStorageWorkerRepository["claimAttachmentParse"]
    >(async () => null),
    renewAttachmentLease: vi.fn(async () => undefined),
    markParserSubmitted: vi.fn(async () => undefined),
    deferParserPoll: vi.fn(async () => undefined),
    saveChunksAndComplete: vi.fn(async () => undefined),
    markAttachmentFailed: vi.fn(async () => undefined),
    claimDeletion: vi.fn<ChatStorageWorkerRepository["claimDeletion"]>(
      async () => null
    ),
    markDeletionSucceeded: vi.fn(async () => undefined),
    markDeletionFailed: vi.fn(async () => undefined)
  } satisfies ChatStorageWorkerRepository;
}

function makeStorage(bytes = new TextEncoder().encode("private")) {
  return {
    id: "test-storage",
    putPrivate: vi.fn(),
    getPrivate: vi.fn(async () => bytes),
    deletePrivate: vi.fn(async () => undefined),
    createPrivateDownloadUrl: vi.fn(async () => "https://oss.test/private")
  } satisfies ObjectStorage;
}

function makeParser(): DocumentParser {
  return {
    id: "test-parser",
    submit: vi.fn(async () => ({ jobId: "docmind-job-1" })),
    getStatus: vi.fn(async () => ({
      jobId: "docmind-job-1",
      status: "processing" as const
    })),
    getResult: vi.fn(async () => ({ jobId: "docmind-job-1", pages: [] }))
  };
}
