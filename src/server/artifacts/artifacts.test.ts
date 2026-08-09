import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";

import type { ArtifactKind, ArtifactSpec } from "@/types/chat-v3";
import {
  ArtifactService,
  ArtifactSpecValidationError,
  parseArtifactSpec,
  renderArtifactFiles,
  renderCsv,
  renderMarkdown
} from ".";

const sourceTurnId = "00000000-0000-4000-8000-000000000001";
const artifactId = "00000000-0000-4000-8000-000000000002";

function createSpec(overrides: Partial<ArtifactSpec> = {}): ArtifactSpec {
  return {
    schemaVersion: "openvac.artifact.v1",
    kind: "diagnosis_report",
    title: "真空系统诊断报告",
    formats: ["md", "docx", "pdf", "csv"],
    summary: "系统在 10 Pa 附近出现压力平台，需要依次排查泄漏、放气与流导。",
    sections: [
      {
        heading: "诊断结论",
        paragraphs: [
          "当前数据不足以直接判定泄漏。建议先确认隔离阀状态，并记录压力-时间曲线。"
        ]
      }
    ],
    tables: [
      {
        title: "检查参数",
        columns: ["参数", "当前值", "动作"],
        rows: [
          ["入口压力", "10 Pa", "复测"],
          ["公式保护", "=1+1", "不得执行"]
        ]
      }
    ],
    sourceTurnId,
    ...overrides
  };
}

describe("ArtifactSpec validation", () => {
  it("accepts every supported artifact kind", () => {
    const kinds: ArtifactKind[] = [
      "diagnosis_report",
      "selection_report",
      "inspection_checklist",
      "parameter_table"
    ];
    for (const kind of kinds) {
      expect(parseArtifactSpec(createSpec({ kind })).kind).toBe(kind);
    }
  });

  it.each([
    ["unknown fields", { ...createSpec(), unexpected: true }],
    ["duplicate formats", createSpec({ formats: ["md", "md"] })],
    [
      "row width mismatch",
      createSpec({
        tables: [{ columns: ["a", "b"], rows: [["only-one"]] }]
      })
    ],
    ["CSV without a table", createSpec({ formats: ["csv"], tables: [] })],
    ["control characters", createSpec({ summary: "bad\u0000text" })]
  ])("rejects %s", (_label, input) => {
    expect(() => parseArtifactSpec(input)).toThrow(ArtifactSpecValidationError);
  });
});

describe("deterministic artifact renderers", () => {
  it("renders deterministic MD, DOCX, PDF, and CSV with Chinese text", async () => {
    const first = await renderArtifactFiles(createSpec());
    const second = await renderArtifactFiles(createSpec());

    expect(first.map((file) => file.format)).toEqual([
      "md",
      "docx",
      "pdf",
      "csv"
    ]);
    first.forEach((file, index) => {
      expect(file.bytes).toEqual(second[index]?.bytes);
      expect(file.bytes.length).toBeGreaterThan(32);
    });

    const markdown = new TextDecoder().decode(
      first.find((file) => file.format === "md")?.bytes
    );
    expect(markdown).toContain("# 真空系统诊断报告");
    expect(markdown).toContain("| 参数 | 当前值 | 动作 |");

    const docx = first.find((file) => file.format === "docx")?.bytes;
    expect(Array.from(docx?.slice(0, 4) ?? [])).toEqual([80, 75, 3, 4]);
    expect(new TextDecoder().decode(docx)).toContain("真空系统诊断报告");

    const pdf = first.find((file) => file.format === "pdf")?.bytes;
    expect(new TextDecoder().decode(pdf?.slice(0, 8))).toContain("%PDF-");
    expect((await PDFDocument.load(pdf!)).getPageCount()).toBeGreaterThan(0);

    const csv = new TextDecoder().decode(
      first.find((file) => file.format === "csv")?.bytes
    );
    expect(
      Array.from(first.find((file) => file.format === "csv")!.bytes.slice(0, 3))
    ).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv).toContain('"\'=1+1"');
  }, 120_000);

  it("escapes Markdown tables and CSV formulas deterministically", () => {
    const spec = createSpec({
      formats: ["md", "csv"],
      tables: [{ columns: ["a|b"], rows: [["@SUM(A1)"]] }]
    });
    expect(renderMarkdown(spec)).toContain("a\\|b");
    expect(renderCsv(spec)).toContain('"\'@SUM(A1)"');
  });
});

describe("ArtifactService", () => {
  it("persists download metadata without exposing object keys", async () => {
    const repository = repositoryMock();
    const objectStore = objectStoreMock();
    const service = new ArtifactService({
      repository,
      objectStore,
      renderer: {
        render: async () => [
          {
            format: "md",
            filename: "report.md",
            contentType: "text/markdown; charset=utf-8",
            bytes: new TextEncoder().encode("safe")
          }
        ]
      },
      now: () => new Date("2026-08-09T00:00:00.000Z")
    });

    const result = await service.generateSafely({
      artifactId,
      ownerId: "user-1",
      conversationId: "conversation-1",
      spec: createSpec({ formats: ["md"] })
    });

    expect(result.artifact.status).toBe("ready");
    expect(result.downloads).toEqual([
      expect.objectContaining({
        artifactId,
        format: "md",
        filename: "report.md",
        downloadPath: `/api/artifacts/${artifactId}/md`,
        checksumSha256:
          "8b3369944dd2a3fab39e32d1aeb1f763946a458ae3e6368a46432adc8f3a0860"
      })
    ]);
    expect(result.downloads[0]).not.toHaveProperty("objectKey");
    expect(objectStore.put).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: expect.stringMatching(
          /^chat-artifacts\/[a-f0-9]{24}\/[0-9a-f-]+\/[a-f0-9]{64}\.md$/u
        )
      })
    );
  });

  it("turns render failure into artifact failure without throwing", async () => {
    const repository = repositoryMock();
    const service = new ArtifactService({
      repository,
      objectStore: objectStoreMock(),
      renderer: { render: async () => Promise.reject(new Error("render")) }
    });

    await expect(
      service.generateSafely({
        artifactId,
        ownerId: "user-1",
        conversationId: "conversation-1",
        spec: createSpec({ formats: ["md"] })
      })
    ).resolves.toMatchObject({
      artifact: { status: "failed" },
      downloads: [],
      failureCode: "RENDER_FAILED"
    });
    expect(repository.markFailed).toHaveBeenCalledWith(
      artifactId,
      "RENDER_FAILED",
      expect.any(Date)
    );
  });

  it("fails and cleans stored objects when the repository cannot mark ready", async () => {
    const repository = repositoryMock();
    repository.markReady.mockRejectedValue(new Error("repository unavailable"));
    const objectStore = objectStoreMock();
    const service = new ArtifactService({
      repository,
      objectStore,
      renderer: {
        render: async () => [
          {
            format: "md",
            filename: "report.md",
            contentType: "text/markdown; charset=utf-8",
            bytes: new TextEncoder().encode("safe")
          }
        ]
      }
    });

    const result = await service.generateSafely({
      artifactId,
      ownerId: "user-1",
      conversationId: "conversation-1",
      spec: createSpec({ formats: ["md"] })
    });

    expect(result).toMatchObject({
      artifact: { status: "failed" },
      failureCode: "REPOSITORY_FAILED",
      downloads: []
    });
    expect(objectStore.delete).toHaveBeenCalledTimes(1);
    expect(repository.markFailed).toHaveBeenCalledWith(
      artifactId,
      "REPOSITORY_FAILED",
      expect.any(Date)
    );
  });

  it("rejects an incomplete renderer result before writing objects", async () => {
    const objectStore = objectStoreMock();
    const service = new ArtifactService({
      repository: repositoryMock(),
      objectStore,
      renderer: { render: async () => [] }
    });

    const result = await service.generateSafely({
      artifactId,
      ownerId: "user-1",
      conversationId: "conversation-1",
      spec: createSpec({ formats: ["md"] })
    });

    expect(result.failureCode).toBe("RENDER_FAILED");
    expect(objectStore.put).not.toHaveBeenCalled();
  });
});

function repositoryMock() {
  return {
    createGenerating: vi.fn(async () => undefined),
    markReady: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    findOwned: vi.fn(async () => null),
    findOwnedDownload: vi.fn(async () => null),
    markDeleted: vi.fn(async () => false)
  };
}

function objectStoreMock() {
  return {
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined)
  };
}
