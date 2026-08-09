import { describe, expect, it, vi } from "vitest";

import type { ArtifactSpec } from "@/types/chat-v3";

import {
  ArtifactToolService,
  hasExplicitArtifactIntent,
  type ArtifactStorage,
  UnconfiguredArtifactStorage
} from "./artifact-tools";

const turnId = "ea538766-c8a3-4350-8894-8fb72233af12";
const runId = "2d398755-2f37-444a-a76c-66956c09fb05";
const assistantMessageId = "2fcb566b-bd9d-4b88-aac6-611800321964";
const artifactId = "31d56d64-399a-4813-bad1-0c93e1eb8396";

describe("hasExplicitArtifactIntent", () => {
  it.each([
    "请生成一份真空系统诊断报告",
    "把上面的结果导出为 PDF 文档",
    "Create an inspection checklist for this pump"
  ])("accepts an explicit artifact request: %s", (question) => {
    expect(hasExplicitArtifactIntent(question)).toBe(true);
  });

  it.each([
    "解释这份报告中的结论",
    "报告通常应包含哪些内容？",
    "比较 PDF 和 DOCX 格式",
    "检查系统并直接回答我",
    "如何生成一份诊断报告？",
    "系统没有生成报告",
    "The report says the pump is undersized"
  ])("does not expose creation for a mere artifact mention: %s", (question) => {
    expect(hasExplicitArtifactIntent(question)).toBe(false);
  });
});

describe("ArtifactToolService", () => {
  it("requires intent and validates sourceTurnId before touching storage", async () => {
    const storage = makeStorage();
    const service = new ArtifactToolService(storage);

    await expect(
      service.create({
        userId: "user-a",
        conversationId: "conversation-a",
        turnId,
        runId,
        assistantMessageId,
        question: "请直接回答，不要创建文档",
        spec: makeSpec()
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_INTENT_REQUIRED" });
    await expect(
      service.create({
        userId: "user-a",
        conversationId: "conversation-a",
        turnId,
        runId,
        assistantMessageId,
        question: "请创建诊断报告",
        spec: { ...makeSpec(), sourceTurnId: crypto.randomUUID() }
      })
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_SPEC" });
    expect(storage.create).not.toHaveBeenCalled();
  });

  it("returns only public artifact metadata even if storage has URL-like fields", async () => {
    const storage = makeStorage({
      signedUrl: "https://private.example/signed-secret"
    });
    const service = new ArtifactToolService(storage);

    const result = await service.create({
      userId: "user-a",
      conversationId: "conversation-a",
      turnId,
      runId,
      assistantMessageId,
      question: "请生成一份诊断报告",
      spec: makeSpec()
    });

    expect(result).toEqual({
      type: "artifact",
      artifactId,
      kind: "diagnosis_report",
      title: "真空系统诊断",
      formats: ["pdf"],
      status: "generating"
    });
    expect(JSON.stringify(result)).not.toMatch(/url|secret/iu);
  });

  it("fails closed when persisted scope differs", async () => {
    const service = new ArtifactToolService(
      makeStorage({ conversationId: "conversation-b" })
    );

    await expect(
      service.create({
        userId: "user-a",
        conversationId: "conversation-a",
        turnId,
        runId,
        assistantMessageId,
        question: "请生成一份诊断报告",
        spec: makeSpec()
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_SCOPE_MISMATCH" });
  });

  it("rejects raw URLs and internal runtime fields in artifact content", async () => {
    const storage = makeStorage();
    const service = new ArtifactToolService(storage);

    await expect(
      service.create({
        userId: "user-a",
        conversationId: "conversation-a",
        turnId,
        runId,
        assistantMessageId,
        question: "请生成一份诊断报告",
        spec: {
          ...makeSpec(),
          summary:
            "provider tool_call: https://private.example/file?Signature=secret"
        }
      })
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_SPEC" });
    expect(storage.create).not.toHaveBeenCalled();
  });

  it("provides an explicitly fail-closed unconfigured storage stub", async () => {
    const service = new ArtifactToolService(new UnconfiguredArtifactStorage());

    await expect(
      service.create({
        userId: "user-a",
        conversationId: "conversation-a",
        turnId,
        runId,
        assistantMessageId,
        question: "请生成一份诊断报告",
        spec: makeSpec()
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_STORAGE_UNCONFIGURED" });
  });
});

function makeSpec(): ArtifactSpec {
  return {
    schemaVersion: "openvac.artifact.v1",
    kind: "diagnosis_report",
    title: "真空系统诊断",
    formats: ["pdf"],
    summary: "诊断摘要",
    sections: [{ heading: "现象", paragraphs: ["抽速不足"] }],
    tables: [],
    sourceTurnId: turnId
  };
}

function makeStorage(
  overrides: Record<string, unknown> = {}
): ArtifactStorage & { create: ReturnType<typeof vi.fn> } {
  return {
    create: vi.fn(async () => ({
      artifactId,
      userId: "user-a",
      conversationId: "conversation-a",
      sourceTurnId: turnId,
      kind: "diagnosis_report" as const,
      title: "真空系统诊断",
      formats: ["pdf" as const],
      status: "generating" as const,
      ...overrides
    }))
  };
}
